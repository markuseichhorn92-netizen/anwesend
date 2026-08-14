'use strict';

/**
 * GET /api/phone/slots?key=<PHONE_KEY>[&limit=5][&trainer=1]
 *
 * Die nächsten freien Probetraining-Termine – kurz genug zum Vorlesen.
 *
 * Warum ein eigener Endpunkt statt /api/trial/slots? Der liefert rund 7 KB
 * inklusive langem Werbetext. Ein Telefonassistent braucht drei bis fünf
 * Termine als Satz, nicht die komplette Beschreibung.
 *
 * Der Endpunkt BUCHT NICHTS. Buchen verlangt elf Pflichtfelder inklusive
 * Anschrift und Geburtsdatum (Vorgabe von Magicline) – das über die Leitung zu
 * diktieren ist fehleranfällig. Der Assistent nennt Termine und nimmt über
 * /api/phone/callback einen Rückruf auf.
 */

const P = require('../../lib/phoneApi');
const C = require('../../lib/connect');

function ymd(d) { return d.toISOString().slice(0, 10); }

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

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return P.json(res, 405, { ok: false, error: 'method_not_allowed' });
  const g = await P.guard(req, null, 120);
  if (!g.ok) return P.json(res, g.code, g.body);

  const u = new URL(req.url, 'http://x');
  let limit = parseInt(u.searchParams.get('limit'), 10);
  if (!(limit >= 1 && limit <= 10)) limit = 5;
  const trainer = u.searchParams.get('trainer') === '1';

  const now = new Date();
  const start = ymd(now);
  const end = ymd(new Date(now.getTime() + 21 * 86400000));

  let r = null;
  try { r = await C.getTrialSlots(start, end, trainer); } catch (e) { r = null; }
  if (!r || r.status !== 200 || !r.json) {
    return P.json(res, 200, {
      ok: false, error: 'unavailable', slots: [],
      text: 'Die Termine kann ich gerade nicht abrufen. Ich notiere gern einen Rückruf, dann meldet sich das Team.',
    });
  }

  // Die Connect-API liefert je nach Konfiguration verschachtelte Strukturen –
  // wir sammeln alles ein, was nach einem Startzeitpunkt aussieht.
  const raw = r.json;
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
  const take = uniq.slice(0, limit);

  const spoken = take.map(sprechDatum).filter(Boolean);
  let text;
  if (!spoken.length) {
    text = 'In den nächsten drei Wochen ist online leider kein Termin frei. Ich notiere gern einen Rückruf.';
  } else if (spoken.length === 1) {
    text = 'Der nächste freie Termin fürs Probetraining ist ' + spoken[0] + '.';
  } else {
    text = 'Frei wären zum Beispiel: ' + spoken.slice(0, -1).join(', ') + ' oder ' + spoken[spoken.length - 1] + '.';
  }

  return P.json(res, 200, {
    ok: true,
    text: text,
    count: spoken.length,
    slots: take.map(function (s, i) { return { startDateTime: s, spoken: spoken[i] || null }; }),
    trainerRequired: trainer,
  });
};
