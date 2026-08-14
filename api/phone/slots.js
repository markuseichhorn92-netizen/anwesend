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

// Ortszeit-Stunde eines Zeitpunkts. Die Slots kommen in UTC – „nachmittags"
// waere sonst um zwei Stunden verschoben.
function berlinStunde(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return -1;
  return parseInt(new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false,
  }).format(d), 10);
}

// „Vormittags", „nachmittags", „abends" – so fragt man am Telefon, nicht in
// Uhrzeiten. Der Anrufer wollte nachmittags; der Assistent hatte nur die
// Vormittagstermine vorliegen und musste passen.
const TAGESZEITEN = {
  vormittag: function (h) { return h < 12; },
  morgens: function (h) { return h < 12; },
  frueh: function (h) { return h < 12; },
  mittag: function (h) { return h >= 11 && h < 14; },
  nachmittag: function (h) { return h >= 12 && h < 17; },
  abend: function (h) { return h >= 17; },
  spaet: function (h) { return h >= 17; },
};
function tageszeitFilter(v) {
  const t = String(v == null ? '' : v).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ü/g, 'ue').replace(/[^a-z]/g, '');
  // Laengste Bezeichnung zuerst: „nachmittags" enthaelt „mittag", und die
  // kuerzere Uebereinstimmung waere die falsche.
  const key = Object.keys(TAGESZEITEN)
    .sort(function (a, b) { return b.length - a.length; })
    .filter(function (k) { return t.indexOf(k) >= 0; })[0];
  return key ? { name: key, test: TAGESZEITEN[key] } : null;
}

// Alle Zeiten eines Tages nach Tageszeit sortiert mitliefern. Damit muss der
// Assistent fuer „und nachmittags?" NICHT noch einmal anrufen – im Gespraech
// ist jeder zusaetzliche Aufruf eine Pause, die der Anrufer hoert.
function nachTageszeit(list) {
  const out = { vormittag: [], nachmittag: [], abend: [] };
  list.forEach(function (s) {
    const h = berlinStunde(s);
    if (h < 0) return;
    if (h < 12) out.vormittag.push(s);
    else if (h < 17) out.nachmittag.push(s);
    else out.abend.push(s);
  });
  return out;
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
  // Standard: mit Trainer/Ressource (lib/connect.js). Nur ein ausdrueckliches
  // trainer=0 schaltet das ab. Wichtig: /api/phone/book prueft mit DEMSELBEN
  // Flag - sonst enthaelt die Pruefliste Zeiten, zu denen kein Trainer frei ist.
  const trainerQ = u.searchParams.get('trainer');
  const trainer = (trainerQ == null || trainerQ === '') ? undefined : (trainerQ === '1');

  const w = P.slotWindow({
    datum: u.searchParams.get('datum') || u.searchParams.get('date') || u.searchParams.get('tag'),
    ab: u.searchParams.get('ab') || u.searchParams.get('from'),
    tage: u.searchParams.get('tage') || u.searchParams.get('days'),
    wochentag: u.searchParams.get('wochentag'),
    woche: u.searchParams.get('woche'),
  }, Date.now());
  const tz = tageszeitFilter(u.searchParams.get('tageszeit'));

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
  const amTagAlle = w.exactDay ? alle.filter(function (s) { return s.slice(0, 10) === w.exactDay; }) : [];
  const sonst = w.exactDay ? alle.filter(function (s) { return s.slice(0, 10) !== w.exactDay; }) : alle;
  // Tageszeit filtert nur, sie darf nie der Grund fuer eine leere Antwort sein –
  // was uebrig bleibt, wird unten als Alternative genannt.
  const amTag = tz ? amTagAlle.filter(function (s) { return tz.test(berlinStunde(s)); }) : amTagAlle;
  const zeiten = w.exactDay ? nachTageszeit(amTagAlle) : nachTageszeit(alle);

  const take = w.exactDay
    ? (amTag.length ? amTag.slice(0, limit) : streue(sonst, limit, 2))
    : streue(tz ? alle.filter(function (s) { return tz.test(berlinStunde(s)); }) : alle, limit, 2);
  const spoken = take.map(sprechDatum).filter(Boolean);

  // Was am Wunschtag sonst noch ginge – der Satz, der im Gespraech gefehlt hat.
  const restAmTag = amTagAlle.filter(function (s) { return amTag.indexOf(s) < 0; })
    .map(sprechUhr).filter(Boolean).slice(0, 4);

  let text;
  if (w.exactDay && amTag.length) {
    const uhren = take.map(sprechUhr).filter(Boolean);
    text = 'Am ' + sprechTag(w.exactDay) + ' wäre frei: '
      + (uhren.length > 1 ? (uhren.slice(0, -1).join(', ') + ' oder ' + uhren[uhren.length - 1]) : uhren[0]) + '.';
  } else if (w.exactDay && tz && restAmTag.length) {
    // Der Tag hat Termine, nur nicht zur gewuenschten Tageszeit. Das ist etwas
    // anderes als „ausgebucht" – und im Gespraech genau der Unterschied
    // zwischen einem Abschluss und einem Abbruch.
    text = 'Am ' + sprechTag(w.exactDay) + ' habe ich ' + tz.name + 's leider nichts frei. '
      + 'An dem Tag ginge noch: ' + (restAmTag.length > 1
        ? (restAmTag.slice(0, -1).join(', ') + ' oder ' + restAmTag[restAmTag.length - 1]) : restAmTag[0]) + '.';
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
    // gesprochen ZUERST: der Rohwert daneben ist UTC und darf nie vorgelesen
    // werden (siehe P.UTC_HINWEIS).
    slots: take.map(function (s, i) { return { gesprochen: spoken[i] || null, startDateTime: s }; }),
    hinweis: P.UTC_HINWEIS,
    trainerRequired: C.wantTrainer(trainer),
    gesuchterTag: w.exactDay,
    tageszeit: tz ? tz.name : null,
    // Der ganze Tag nach Tageszeit – damit „und nachmittags?" ohne einen
    // zweiten Aufruf beantwortbar ist.
    zeitenAmTag: w.exactDay ? {
      vormittag: zeiten.vormittag.map(sprechUhr).filter(Boolean),
      nachmittag: zeiten.nachmittag.map(sprechUhr).filter(Boolean),
      abend: zeiten.abend.map(sprechUhr).filter(Boolean),
    } : null,
    alleAmTag: w.exactDay ? amTagAlle.map(function (s) { return { gesprochen: sprechUhr(s), startDateTime: s }; }) : null,
    zeitraum: { von: w.start, bis: end },
    // Ein Assistent hat den Termin einmal nur BEHAUPTET und die Buchung nie
    // aufgerufen - der Anrufer waere umsonst gekommen. Der Hinweis steht deshalb
    // in der Antwort selbst, nicht nur in der Anweisung: Modelle lesen ihn mit.
    naechsterSchritt: 'NICHTS ist gebucht, solange die Aktion /api/phone/book nicht aufgerufen wurde. '
      + 'Dafuer noetig: firstname, lastname, phone, dateOfBirth und startDateTime (exakt der Wert aus dieser Antwort). '
      + 'Bestaetige den Termin dem Anrufer erst, wenn diese Aktion ok:true zurueckgibt. '
      + 'Fuer einen spaeteren Zeitraum diese Aktion erneut mit datum, ab, tage oder wochentag+woche '
      + 'aufrufen - NIE einen Wochentag oder ein Datum selbst ausrechnen, das uebernimmt der Server. '
      + 'Fragt der Anrufer nach einer anderen Tageszeit, steht die Antwort bereits in zeitenAmTag - '
      + 'dafuer ist KEIN weiterer Aufruf noetig.',
  });
};
