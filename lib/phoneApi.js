'use strict';

/**
 * Gemeinsame Basis für den KI-Telefonassistenten (fonio & Co.).
 *
 * Der Assistent ruft während des Gesprächs unsere Endpunkte auf und liest die
 * Antwort vor. Daraus folgen drei Eigenheiten, die den Zuschnitt bestimmen:
 *
 *  1. ZEIT. fonio bricht standardmäßig nach 5 Sekunden ab. Die Endpunkte dürfen
 *     also nichts Langsames tun und nichts nachladen, das nicht gebraucht wird.
 *  2. SPRECHBARKEIT. Der Assistent liest vor. Jede Antwort trägt deshalb ein
 *     Feld `text` mit einem fertigen deutschen Satz. Die strukturierten Felder
 *     daneben sind für Protokoll und spätere Auswertung.
 *  3. UNBEKANNTER ANRUFER. Am Telefon ist niemand verifiziert. Diese Endpunkte
 *     geben deshalb AUSSCHLIESSLICH öffentliche Auskünfte und nehmen Rückrufe
 *     entgegen. Keine Mitglieds-, Vertrags- oder Gesundheitsdaten – dafür gibt
 *     es keinen sicheren Identitätsnachweis über die Leitung.
 *
 * Schlüssel: PHONE_KEY. fonio legt Geheimnisse in die „festen Parameter“, also
 * in Query oder Body – ein Header ist nicht garantiert. Wir akzeptieren beides
 * plus Authorization: Bearer. Ohne gesetzten PHONE_KEY antworten die Endpunkte
 * fail-closed mit 503; sie sind also nicht versehentlich offen.
 */

const M = require('./members');

const WEEK = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const DE = { MONDAY: 'Montag', TUESDAY: 'Dienstag', WEDNESDAY: 'Mittwoch', THURSDAY: 'Donnerstag', FRIDAY: 'Freitag', SATURDAY: 'Samstag', SUNDAY: 'Sonntag' };

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(body));
}

// Zeitgleicher Vergleich ohne Bibliothek: Wir arbeiten mit Minuten seit Mitternacht.
function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const v = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return (v >= 0 && v <= 1440) ? v : null;
}
function minToHhmm(v) {
  const h = Math.floor(v / 60), m = v % 60;
  return String(h) + ':' + (m < 10 ? '0' : '') + m;
}
// „9:30 Uhr“ statt „9:0 Uhr“ – gesprochen liest sich das sonst falsch.
function sprich(v) {
  const h = Math.floor(v / 60), m = v % 60;
  return m === 0 ? (h + ' Uhr') : (h + ':' + (m < 10 ? '0' : '') + m + ' Uhr');
}

// Berlin-Zeit ohne Bibliothek: Intl liefert die Zeitzonen-Rechnung inkl. Sommerzeit.
function berlinNow(nowMs) {
  const d = new Date(nowMs == null ? Date.now() : nowMs);
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return {
    ymd: p.year + '-' + p.month + '-' + p.day,
    min: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
    day: WEEK[wd],
    dayDe: DE[WEEK[wd]],
  };
}

// Magicline liefert Spannen („MONDAY bis FRIDAY“). Für einen Wochentag die
// passenden Zeitfenster herausziehen, sortiert und zusammengefasst.
function windowsFor(openingHours, day) {
  const iOf = (d) => WEEK.indexOf(d);
  const target = iOf(day);
  if (target < 0) return [];
  const out = [];
  (Array.isArray(openingHours) ? openingHours : []).forEach(function (h) {
    const a = iOf(h.dayOfWeekFrom), b = iOf(h.dayOfWeekTo);
    if (a < 0) return;
    const to = (b < 0) ? a : b;
    // Spanne kann über den Sonntag laufen (z. B. SATURDAY bis MONDAY).
    let hit = false;
    for (let i = a, n = 0; n < 7; n++, i = (i + 1) % 7) { if (i === target) { hit = true; } if (i === to) break; }
    if (!hit) return;
    const f = hhmmToMin(h.timeFrom), t = hhmmToMin(h.timeTo);
    if (f == null || t == null || t <= f) return;
    out.push({ from: f, to: t });
  });
  return out.sort(function (x, y) { return x.from - y.from; });
}

// Sonderschließung (Feiertag) für ein Datum? closingHours kommt als Zeitraum.
function closedOn(closingHours, ymd) {
  let hit = null;
  (Array.isArray(closingHours) ? closingHours : []).forEach(function (c) {
    const a = String(c.dateTimeFrom || '').slice(0, 10);
    const b = String(c.dateTimeTo || '').slice(0, 10);
    if (!a) return;
    // dateTimeTo ist exklusiv (01.01. bis 02.01. = nur Neujahr).
    if (ymd >= a && (!b || ymd < b)) hit = String(c.reason || '').slice(0, 60) || 'Feiertag';
  });
  return hit;
}

/**
 * Öffnungs-Status als fertiger Satz.
 * @returns {{open:boolean, text:string, todayText:string, closedReason:string|null}}
 */
function openStatus(hours, nowMs) {
  const now = berlinNow(nowMs);
  const reason = closedOn(hours && hours.closingHours, now.ymd);
  const wins = windowsFor(hours && hours.openingHours, now.day);
  const todayText = wins.length
    ? wins.map(function (w) { return minToHhmm(w.from) + ' bis ' + minToHhmm(w.to) + ' Uhr'; }).join(' und ')
    : 'geschlossen';

  if (reason) {
    return { open: false, closedReason: reason, todayText: todayText,
      text: 'Heute haben wir wegen ' + reason + ' geschlossen.' };
  }
  if (!wins.length) {
    return { open: false, closedReason: null, todayText: todayText,
      text: 'Heute, am ' + now.dayDe + ', haben wir geschlossen.' };
  }
  const cur = wins.filter(function (w) { return now.min >= w.from && now.min < w.to; })[0];
  if (cur) {
    return { open: true, closedReason: null, todayText: todayText,
      text: 'Wir haben gerade geöffnet, heute bis ' + sprich(cur.to) + '.' };
  }
  const next = wins.filter(function (w) { return w.from > now.min; })[0];
  if (next) {
    return { open: false, closedReason: null, todayText: todayText,
      text: 'Gerade ist geschlossen, wir öffnen heute wieder um ' + sprich(next.from) + '.' };
  }
  return { open: false, closedReason: null, todayText: todayText,
    text: 'Für heute haben wir bereits geschlossen. ' + now.dayDe + ' waren wir von ' + todayText + ' da.' };
}

// Auslastung in einen Satz, den man am Telefon versteht.
function loadText(a) {
  const p = a && typeof a.percent === 'number' ? a.percent : null;
  if (p == null) return null;
  if (p < 35) return 'Aktuell ist wenig los.';
  if (p < 70) return 'Aktuell ist normal viel los.';
  return 'Aktuell ist es ziemlich voll.';
}

// ── Zugang ───────────────────────────────────────────────────────────────────
// fonio kann den Schluessel als festen Parameter mitgeben (Query oder Body).
// Header wird zusaetzlich akzeptiert, falls die Plattform das spaeter kann.
// Liefert den gefundenen Schluessel UND wo er lag - das `where` ist die
// Diagnose, die im fonio-Log sofort zeigt, ob ueberhaupt etwas ankommt.
function keyFrom(req, body) {
  const where = { header: false, query: false, body: false };
  let val = '';
  try {
    const h = String((req.headers && req.headers.authorization) || '');
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m && m[1].trim()) { where.header = true; if (!val) val = m[1].trim(); }
  } catch (e) { /* egal */ }
  // Manche Plattformen erlauben nur einen eigenen Header-Namen.
  try {
    const x = String((req.headers && (req.headers['x-api-key'] || req.headers['x-phone-key'])) || '').trim();
    if (x) { where.header = true; if (!val) val = x; }
  } catch (e) { /* egal */ }
  try {
    const u = new URL(req.url, 'http://x').searchParams;
    const q = String(u.get('key') || u.get('apiKey') || '').trim();
    if (q) { where.query = true; if (!val) val = q; }
  } catch (e) { /* egal */ }
  try {
    const b = String((body && (body.key || body.apiKey)) || '').trim();
    if (b) { where.body = true; if (!val) val = b; }
  } catch (e) { /* egal */ }
  return { value: val, where: where };
}

function ipOf(req) {
  try {
    const h = req.headers || {};
    return String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim() || 'unknown';
  } catch (e) { return 'unknown'; }
}

// Zeitsicherer Vergleich: verhindert, dass sich der Schluessel ueber Laufzeit-
// unterschiede Zeichen fuer Zeichen erraten laesst.
function sameSecret(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/**
 * Torwächter für alle Telefon-Endpunkte.
 * @returns {Promise<{ok:true}|{ok:false, code:number, body:object}>}
 */
async function guard(req, body, limit) {
  const secret = String(process.env.PHONE_KEY || '').trim();
  // Fail-closed: ohne gesetzten Schlüssel ist die Schnittstelle zu, nicht offen.
  if (!secret) {
    return { ok: false, code: 503, body: { ok: false, error: 'not_configured',
      text: 'Die Telefon-Schnittstelle ist gerade nicht erreichbar. Ich notiere gern einen Rückruf.',
      hint: 'PHONE_KEY ist in Vercel nicht gesetzt.' } };
  }
  const got = keyFrom(req, body);
  if (!sameSecret(got.value, secret)) {
    // JEDE Antwort traegt einen vorlesbaren Satz - sonst denkt sich der Assistent
    // selbst etwas aus („die Termine kann ich nicht abrufen") und die eigentliche
    // Ursache bleibt unsichtbar. `hint` und `received` stehen im fonio-Log.
    return { ok: false, code: 401, body: { ok: false, error: 'unauthorized',
      text: 'Ich kann die Daten gerade nicht abrufen. Ich notiere gern einen Rückruf, dann meldet sich das Team.',
      hint: got.value
        ? 'Ein Schlüssel kam an, stimmt aber nicht mit PHONE_KEY überein (Tippfehler oder Leerzeichen?).'
        : 'Es kam KEIN Schlüssel an. In fonio als festen Parameter „key" hinterlegen oder als Header {"Authorization": "Bearer {{apiKey}}"}.',
      received: got.where } };
  }
  const okRate = await M.rateLimit('phone:' + ipOf(req), limit || 120, 300);
  if (!okRate) return { ok: false, code: 429, body: { ok: false, error: 'rate_limited', text: 'Bitte gleich noch einmal versuchen.' } };
  return { ok: true };
}

// JSON-Body lesen (klein gedeckelt – hier kommen nur wenige Felder an).
function readBody(req) {
  return new Promise(function (resolve) {
    let raw = '';
    req.on('data', function (c) { raw += c; if (raw.length > 20000) raw = raw.slice(0, 20000); });
    req.on('end', function () { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); } });
    req.on('error', function () { resolve({}); });
  });
}

module.exports = {
  json, guard, readBody, ipOf,
  openStatus, loadText, windowsFor, closedOn, berlinNow, hhmmToMin, minToHhmm, sprich,
  DE, WEEK,
};
