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
const { redisPipeline, hasStore } = require('./store');

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

// ── Terminfenster ────────────────────────────────────────────────────────────
// Magicline beantwortet die Slot-Abfrage nur für eine begrenzte Spanne: mehr als
// 30 Tage zwischen startDate und endDate werden mit
// „trial.session.open.slots.interval.violation" abgelehnt (am 14.08. gegen die
// Connect-API ausgemessen). WIE WEIT VORAUS das Fenster liegt, ist Magicline
// dagegen egal – eine Abfrage für Dezember 2027 liefert genauso Termine.
//
// Daraus folgt: „weiter in der Zukunft buchen" heißt nicht „größeres Fenster",
// sondern „Fenster verschieben". Genau das macht slotWindow.
const MAX_SPAN = 30;
// Weiter als ein halbes Jahr fragen wir nicht. Nicht weil Magicline es verbietet,
// sondern damit ein verhörtes Jahr („zwanzigsiebenundzwanzig") nicht in einem
// Probetraining in zwei Jahren endet.
const MAX_AHEAD = 180;

function ymdAdd(ymd, days) {
  // 12:00 UTC als Anker: die Sommerzeit-Umstellung kann den Tag dann nicht kippen.
  const d = new Date(String(ymd) + 'T12:00:00Z');
  if (isNaN(d.getTime())) return String(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Ein Sprachassistent liefert das Datum mal als ISO, mal deutsch gesprochen.
// Alles andere (auch „nächste Woche") wird bewusst NICHT geraten – dann fragt
// der Assistent lieber nach, als einen falschen Tag anzubieten.
function asYmd(v) {
  const t = String(v == null ? '' : v).trim().slice(0, 24);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) {
    const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(t);
    if (d) m = [null, d[3], ('0' + d[2]).slice(-2), ('0' + d[1]).slice(-2)];
  }
  if (!m) return '';
  const mo = parseInt(m[2], 10), da = parseInt(m[3], 10);
  if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return '';
  return m[1] + '-' + m[2] + '-' + m[3];
}

/**
 * Welches Fenster fragen wir bei Magicline ab?
 *
 * @param {{datum?:string, ab?:string, tage?:string|number}} q
 *        datum – ein bestimmter Tag („am 15. September")
 *        ab    – ab diesem Tag suchen („irgendwann ab Oktober")
 *        tage  – in N Tagen suchen („in vier Wochen")
 * @returns {{start:string, end:string, exactDay:string|null, past:boolean, tooFar:boolean}}
 */
function slotWindow(q, nowMs) {
  const heute = berlinNow(nowMs).ymd;
  const grenze = ymdAdd(heute, MAX_AHEAD);
  const o = q || {};

  const wunsch = asYmd(o.datum);
  const ab = asYmd(o.ab);
  let tage = parseInt(o.tage, 10);
  if (!(tage >= 0 && tage <= MAX_AHEAD)) tage = null;

  let start = wunsch || ab || (tage == null ? heute : ymdAdd(heute, tage));
  const past = !!(start < heute);
  const tooFar = !!(start > grenze);
  // Vergangenes und Übermorgen-in-zwei-Jahren still zurechtrücken, statt zu
  // scheitern: der Anrufer soll einen Vorschlag hören, keine Fehlermeldung.
  if (past) start = heute;
  if (tooFar) start = grenze;

  // Auch bei einem Wunschtag holen wir das ganze Fenster – dieselbe eine Abfrage
  // liefert dann die Ausweichtermine mit, falls der Tag voll ist.
  let end = ymdAdd(start, MAX_SPAN);
  if (end > grenze) end = grenze;
  if (end < start) end = start;

  return {
    start: start, end: end,
    exactDay: (wunsch && !past && !tooFar) ? wunsch : null,
    past: past, tooFar: tooFar,
  };
}

/**
 * Die ganze Woche als Liste – für „wann habt ihr samstags auf?“.
 * openStatus beantwortet nur HEUTE; danach wird am Telefon aber ständig gefragt.
 * @returns {Array<{tag:string, day:string, text:string, offen:boolean}>}
 */
function weekPlan(hours) {
  const oh = hours && hours.openingHours;
  return ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map(function (d) {
    const w = windowsFor(oh, d);
    return {
      day: d, tag: DE[d], offen: w.length > 0,
      text: w.length ? w.map(function (x) { return minToHhmm(x.from) + ' bis ' + minToHhmm(x.to) + ' Uhr'; }).join(' und ') : 'geschlossen',
    };
  });
}

// Gleiche aufeinanderfolgende Tage zusammenfassen: „Montag bis Freitag …“ statt
// fünfmal derselbe Satz. Vorgelesen ist das der Unterschied zwischen einer
// Auskunft und einer Litanei.
function weekText(hours) {
  const plan = weekPlan(hours);
  const teile = [];
  let i = 0;
  while (i < plan.length) {
    let j = i;
    while (j + 1 < plan.length && plan[j + 1].text === plan[i].text) j++;
    const name = (j > i) ? (plan[i].tag + ' bis ' + plan[j].tag) : plan[i].tag;
    teile.push(name + ' ' + plan[i].text);
    i = j + 1;
  }
  return teile.join(', ') + '.';
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
    // Auch den Fehlversuch protokollieren – OHNE den Schluessel selbst. Sonst
    // bleibt genau der haeufigste Fall unsichtbar: die Telefon-Plattform ruft an,
    // schickt einen veralteten Schluessel, und im Gespraech hoert man nur „das
    // kann ich gerade nicht abrufen". Mit dem Eintrag zeigt /api/phone/ping?log=1
    // sofort, ob ueberhaupt Aufrufe ankommen und wo der Schluessel lag.
    // Eng begrenzt, damit ein Scanner den Speicher nicht vollschreibt.
    try {
      const okLog = await M.rateLimit('phonelog:' + ipOf(req), 5, 300);
      if (okLog !== false) {
        await logAttempt({ schritt: 'auth', ok: false,
          status: got.value ? 'schluessel_falsch' : 'kein_schluessel',
          pfad: String(req.url || '').split('?')[0].slice(0, 60), empfangen: got.where });
      }
    } catch (e) { /* Diagnose darf den Anruf nie stoeren */ }
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

// Body lesen (klein gedeckelt – hier kommen nur wenige Felder an).
//
// Robust gegen die Schreibweisen fremder Plattformen: JSON, aber auch
// form-urlencoded, und Felder, die in einem Umschlag stecken ({parameters:{…}}).
// Wir kontrollieren die Gegenstelle nicht – ein stiller Parse-Fehler saehe sonst
// aus wie „alle Pflichtfelder fehlen“ und schickt die Fehlersuche in die Irre.
const WRAPPERS = ['parameters', 'params', 'arguments', 'args', 'data', 'body', 'input', 'payload'];

function unwrap(o) {
  if (!o || typeof o !== 'object') return {};
  const out = Object.assign({}, o);
  WRAPPERS.forEach(function (k) {
    const v = o[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, v);
  });
  return out;
}

function parseBody(raw, contentType) {
  const t = String(raw || '').trim();
  if (!t) return {};
  const ct = String(contentType || '').toLowerCase();
  if (ct.indexOf('urlencoded') >= 0 || (t.indexOf('{') !== 0 && t.indexOf('=') > 0)) {
    const o = {};
    try { new URLSearchParams(t).forEach(function (v, k) { o[k] = v; }); } catch (e) { /* egal */ }
    return unwrap(o);
  }
  try { return unwrap(JSON.parse(t)); } catch (e) { /* gleich noch urlencoded probieren */ }
  const o2 = {};
  try { new URLSearchParams(t).forEach(function (v, k) { o2[k] = v; }); } catch (e) { /* egal */ }
  return unwrap(o2);
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = '';
    req.on('data', function (c) { raw += c; if (raw.length > 20000) raw = raw.slice(0, 20000); });
    req.on('end', function () {
      const body = parseBody(raw, req.headers && req.headers['content-type']);
      // Query-Parameter als Rueckfallebene: manche Plattformen haengen die Felder
      // auch bei POST an die URL. Body gewinnt.
      try {
        const u = new URL(req.url, 'http://x').searchParams;
        u.forEach(function (v, k) { if (body[k] == null || body[k] === '') body[k] = v; });
      } catch (e) { /* egal */ }
      Object.defineProperty(body, '__raw', { value: raw.slice(0, 400), enumerable: false });
      resolve(body);
    });
    req.on('error', function () { resolve({}); });
  });
}

// ── Diagnose-Protokoll ───────────────────────────────────────────────────────
// Die Telefon-Plattform zeigt uns ihre Logs nicht. Ohne eigene Spur bleibt nach
// einem gescheiterten Anruf nur Raten. Deshalb ein kurzes Protokoll der letzten
// Versuche - AUSDRUECKLICH OHNE personenbezogene Werte: nur ob ein Feld gefuellt
// war, dazu Statuscode und die Rueckmeldung des Studioverwaltungssystems.
const LOG_KEY = 'phone:log';
const LOG_MAX = 20;

async function logAttempt(entry) {
  if (!hasStore) return;
  try {
    const rec = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)).slice(0, 1200);
    await redisPipeline([['LPUSH', LOG_KEY, rec], ['LTRIM', LOG_KEY, '0', String(LOG_MAX - 1)],
      ['EXPIRE', LOG_KEY, '604800']]);
  } catch (e) { /* Diagnose darf den Anruf nie stoeren */ }
}

async function readLog() {
  if (!hasStore) return [];
  try {
    const [rows] = await redisPipeline([['LRANGE', LOG_KEY, '0', String(LOG_MAX - 1)]]);
    return (Array.isArray(rows) ? rows : []).map(function (r) { try { return JSON.parse(r); } catch (e) { return { raw: String(r).slice(0, 200) }; } });
  } catch (e) { return []; }
}

module.exports = {
  json, guard, readBody, parseBody, unwrap, ipOf, logAttempt, readLog,
  openStatus, loadText, windowsFor, closedOn, berlinNow, hhmmToMin, minToHhmm, sprich,
  weekPlan, weekText,
  slotWindow, ymdAdd, asYmd, MAX_SPAN, MAX_AHEAD,
  DE, WEEK,
};
