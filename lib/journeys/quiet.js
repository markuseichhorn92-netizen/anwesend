'use strict';

/**
 * FINN Journeys – Ruhezeiten (Europe/Berlin, sommerzeitfest).
 * -----------------------------------------------------------------------------
 *   service    07:00–21:00, jeden Tag (Terminerinnerungen sind zeitgebunden)
 *   marketing  Mo–Sa 09:00–19:30, nicht sonntags, nicht an Feiertagen in Rheinland-Pfalz
 *   invite     wie marketing
 * Außerhalb wird verschoben, nie verworfen: nextAllowed() liefert den nächsten
 * erlaubten Zeitpunkt.
 */

const TZ = 'Europe/Berlin';
const FMT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function parts(ts) {
  const p = {}; FMT.formatToParts(new Date(ts)).forEach((x) => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, wd: WD[p.weekday], ymd: p.year + p.month + p.day };
}

// Ostersonntag (Meeus/Jones/Butcher, gregorianisch) -> [monat, tag]
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}
const HCACHE = {};
function holidays(y) {
  if (HCACHE[y]) return HCACHE[y];
  const pad = (n) => String(n).padStart(2, '0');
  const set = new Set(['0101', '0501', '1003', '1101', '1225', '1226'].map((md) => y + md));
  const [em, ed] = easter(y);
  const base = Date.UTC(y, em - 1, ed);
  [-2, 1, 39, 50, 60].forEach((off) => { const d = new Date(base + off * 86400000); set.add(d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())); });
  HCACHE[y] = set; return set;
}
function isHoliday(p) { return holidays(p.y).has(p.ymd); }

const RULES = {
  service: { from: 7 * 60, to: 21 * 60, sunday: true, holiday: true },
  marketing: { from: 9 * 60, to: 19 * 60 + 30, sunday: false, holiday: false },
  invite: { from: 9 * 60, to: 19 * 60 + 30, sunday: false, holiday: false },
};

function allowed(ts, cat) {
  const r = RULES[cat] || RULES.marketing;
  const p = parts(ts);
  const min = p.hh * 60 + p.mm;
  if (min < r.from || min >= r.to) return false;
  if (!r.sunday && p.wd === 0) return false;
  if (!r.holiday && isHoliday(p)) return false;
  return true;
}

// Nächster erlaubter Zeitpunkt ab ts (ts selbst, wenn erlaubt). Schritte à 15 min,
// höchstens 10 Tage voraus – robust über Sommer-/Winterzeitwechsel.
function nextAllowed(ts, cat) {
  if (allowed(ts, cat)) return ts;
  const step = 15 * 60 * 1000;
  let t = Math.ceil(ts / step) * step;
  for (let i = 0; i < 10 * 96; i++, t += step) { if (allowed(t, cat)) return t; }
  return ts + 24 * 3600 * 1000;
}

// Beginn des nächsten Berliner Kalendertags (für Tageskappen).
function nextDayStart(ts) {
  const p = parts(ts);
  let t = ts + ((23 - p.hh) * 60 + (60 - p.mm)) * 60 * 1000;
  // auf volle Minute runden und zur Sicherheit prüfen, dass es der Folgetag ist
  for (let i = 0; i < 6 && parts(t).ymd === p.ymd; i++) t += 30 * 60 * 1000;
  return t;
}
function sameDay(a, b) { return parts(a).ymd === parts(b).ymd; }

module.exports = { TZ, parts, easter, holidays, isHoliday, allowed, nextAllowed, nextDayStart, sameDay, RULES };
