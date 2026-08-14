'use strict';

/**
 * GET /api/phone/slots?key=<PHONE_KEY>[&limit=5][&trainer=1]
 *                     [&datum=YYYY-MM-DD] [&ab=YYYY-MM-DD] [&tage=28]
 *
 * Die freien Probetraining-Termine – kurz genug zum Vorlesen.
 *
 * Warum ein eigener Endpunkt statt /api/trial/slots? Der liefert rund 7 KB
 * inklusive langem Werbetext. Ein Telefonassistent braucht drei bis fünf
 * Termine als Satz, nicht die komplette Beschreibung.
 *
 * WEITER IN DER ZUKUNFT: Anfangs schaute der Endpunkt starr auf die nächsten
 * 21 Tage. Wer „im Oktober" oder „in sechs Wochen" wollte, bekam trotzdem den
 * nächstmöglichen Termin vorgelesen. Jetzt bestimmen `datum`, `ab` oder `tage`
 * das Fenster (siehe P.slotWindow). Magicline beantwortet höchstens 30 Tage pro
 * Abfrage – wie weit voraus das Fenster liegt, ist ihm egal. Ist im ersten
 * Fenster nichts frei, rückt der Endpunkt selbständig weiter, statt „leider
 * nichts frei" zu melden.
 *
 * Der Endpunkt BUCHT NICHTS. Das macht /api/phone/book – und der prüft den
 * gewählten Termin noch einmal gegen genau diese Liste.
 */

const P = require('../../lib/phoneApi');
const C = require('../../lib/connect');

// Höchstens so viele Fenster hintereinander absuchen. Jede Abfrage kostet Zeit,
// und fonio bricht nach 5 Sekunden ab – lieber ein ehrliches „nichts gefunden"
// als ein Timeout mitten im Gespräch.
const MAX_FENSTER = 3;
const ZEITBUDGET = 3000;

// „Dienstag, 19. August um 17 Uhr“ – so, wie man es am Telefon sagt.
function sprechDatum(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long',
    hour: 'numeric', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
  const uhr = (p.minute === '00') ? (p.hour + ' Uhr') : (p.hour + ' Uhr ' + p.minute);
  return p.weekday + ', ' + p.day + '. ' + p.month + ' um ' + uhr;
}

// Nur der Tag, ohne Uhrzeit – für den Satz „Am Dienstag, 15. September …".
function sprechTag(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  if (isNaN(d.getTime())) return ymd;
  const p = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long',
  }).formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
  return p.weekday + ', ' + p.day + '. ' + p.month;
}

// Nur die Uhrzeit – innerhalb eines Tages ist das Datum schon gesagt.
function sprechUhr(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hour: 'numeric', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
  return (p.minute === '00') ? (p.hour + ' Uhr') : (p.hour + ' Uhr ' + p.minute);
}

// Die Connect-API liefert je nach Konfiguration verschachtelte Strukturen –
// wir sammeln alles ein, was nach einem Startzeitpunkt aussieht.
function sammle(raw) {
  const list = [];
  const walk = function (v, depth) {
    if (!v || depth > 4) return;
    if (Array.isArray(v)) { v.forEach(function (x) { walk(x, depth + 1); }); return; }
    if (typeof v !== 'object') return;
    const s = v.startDateTime || v.start || v.dateTime || null;
    if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s)) list.push(s);
    Object.keys(v).forEach(function (k) { walk(v[k], depth + 1); });
  };
  walk(raw, 0);
  const uniq = [];
  const seen = {};
  list.sort().forEach(function (s) { if (!seen[s]) { seen[s] = 1; uniq.push(s); } });
  return uniq;
}

// Termine über mehrere Tage streuen, statt fünfmal denselben Vormittag
// vorzulesen. Wer nach einem Termin fragt, will meist zuerst wissen, an WELCHEN
// TAGEN etwas geht.
function streue(list, limit, proTag) {
  const zahl = {};
  const out = [];
  list.forEach(function (s) {
    if (out.length >= limit) return;
    const tag = s.slice(0, 10);
    zahl[tag] = (zahl[tag] || 0) + 1;
    if (zahl[tag] <= proTag) out.push(s);
  });
  // Lieber zu viele Uhrzeiten an einem Tag als eine leere Antwort.
  if (!out.length) return list.slice(0, limit);
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return P.json(res, 405, { ok: false, error: 'method_not_allowed' });
  const g = await P.guard(req, null, 120);
  if (!g.ok) return P.json(res, g.code, g.body);

  const u = new URL(req.url, 'http://x');
  let limit = parseInt(u.searchParams.get('limit'), 10);
  if (!(limit >= 1 && limit <= 10)) limit = 5;
  const trainer = u.searchParams.get('trainer') === '1';

  const w = P.slotWindow({
    datum: u.searchParams.get('datum') || u.searchParams.get('date') || u.searchParams.get('tag'),
    ab: u.searchParams.get('ab') || u.searchParams.get('from'),
    tage: u.searchParams.get('tage') || u.searchParams.get('days'),
  }, Date.now());

  // Fenster für Fenster nach vorn, bis etwas frei ist oder die Zeit knapp wird.
  const bis = Date.now() + ZEITBUDGET;
  let alle = [];
  let start = w.start, end = w.end;
  let fehler = false;
  for (let i = 0; i < MAX_FENSTER; i++) {
    let r = null;
    try { r = await C.getTrialSlots(start, end, trainer); } catch (e) { r = null; }
    if (!r || r.status !== 200 || !r.json) { fehler = true; break; }
    alle = alle.concat(sammle(r.json));
    if (alle.length) break;
    // Nichts frei – ein Fenster weiterrücken, solange wir im erlaubten Zeitraum
    // sind und noch Zeit haben.
    const next = P.ymdAdd(end, 1);
    if (next > P.ymdAdd(w.start, P.MAX_AHEAD) || Date.now() > bis) break;
    start = next;
    end = P.ymdAdd(start, P.MAX_SPAN);
  }

  if (fehler && !alle.length) {
    return P.json(res, 200, {
      ok: false, error: 'unavailable', slots: [],
      text: 'Die Termine kann ich gerade nicht abrufen. Ich notiere gern einen Rückruf, dann meldet sich das Team.',
    });
  }

  // Wunschtag zuerst, der Rest ist Ausweichvorschlag aus derselben Abfrage.
  const amTag = w.exactDay ? alle.filter(function (s) { return s.slice(0, 10) === w.exactDay; }) : [];
  const sonst = w.exactDay ? alle.filter(function (s) { return s.slice(0, 10) !== w.exactDay; }) : alle;

  const take = w.exactDay
    ? (amTag.length ? amTag.slice(0, limit) : streue(sonst, limit, 2))
    : streue(sonst, limit, 2);
  const spoken = take.map(sprechDatum).filter(Boolean);

  let text;
  if (w.exactDay && amTag.length) {
    const uhren = take.map(sprechUhr).filter(Boolean);
    text = 'Am ' + sprechTag(w.exactDay) + ' wäre frei: '
      + (uhren.length > 1 ? (uhren.slice(0, -1).join(', ') + ' oder ' + uhren[uhren.length - 1]) : uhren[0]) + '.';
  } else if (w.exactDay && spoken.length) {
    text = 'Am ' + sprechTag(w.exactDay) + ' ist leider nichts mehr frei. '
      + 'Frei wären: ' + (spoken.length > 1 ? (spoken.slice(0, -1).join(', ') + ' oder ' + spoken[spoken.length - 1]) : spoken[0]) + '.';
  } else if (!spoken.length) {
    text = w.exactDay || w.tooFar
      ? 'In dem Zeitraum ist leider kein Termin frei. Ich notiere gern einen Rückruf.'
      : 'Im nächsten halben Jahr ist online leider kein Termin frei. Ich notiere gern einen Rückruf.';
  } else if (spoken.length === 1) {
    text = 'Der nächste freie Termin fürs Probetraining ist ' + spoken[0] + '.';
  } else {
    text = 'Frei wären zum Beispiel: ' + spoken.slice(0, -1).join(', ') + ' oder ' + spoken[spoken.length - 1] + '.';
  }
  // Ein in der Vergangenheit oder viel zu weit vorn genannter Tag wird still
  // zurechtgerückt – gesagt werden muss es trotzdem, sonst wundert sich der Anrufer.
  if (w.past) text = 'Der Tag liegt schon hinter uns. ' + text;
  else if (w.tooFar) text = 'So weit im Voraus buchen wir noch nicht. ' + text;

  return P.json(res, 200, {
    ok: true,
    text: text,
    count: spoken.length,
    slots: take.map(function (s, i) { return { startDateTime: s, spoken: spoken[i] || null }; }),
    trainerRequired: trainer,
    gesuchterTag: w.exactDay,
    zeitraum: { von: w.start, bis: end },
    // Ein Assistent hat den Termin einmal nur BEHAUPTET und die Buchung nie
    // aufgerufen - der Anrufer waere umsonst gekommen. Der Hinweis steht deshalb
    // in der Antwort selbst, nicht nur in der Anweisung: Modelle lesen ihn mit.
    naechsterSchritt: 'NICHTS ist gebucht, solange die Aktion /api/phone/book nicht aufgerufen wurde. '
      + 'Dafuer noetig: firstname, lastname, phone, dateOfBirth und startDateTime (exakt der Wert aus dieser Antwort). '
      + 'Bestaetige den Termin dem Anrufer erst, wenn diese Aktion ok:true zurueckgibt. '
      + 'Fuer einen spaeteren Zeitraum diese Aktion erneut mit datum, ab oder tage aufrufen - '
      + 'NIE einen Zeitpunkt selbst ausrechnen.',
  });
};
