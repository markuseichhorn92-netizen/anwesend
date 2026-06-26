'use strict';

/**
 * Persistente Auslastungs-Historie über Upstash Redis (REST API).
 * ---------------------------------------------------------------
 * Speichert pro Wochentag + 30-Minuten-Slot einen laufenden Durchschnitt
 * der Personenzahl ("Stoßzeiten" / typische Auslastung) — vergleichbar mit
 * Google Maps' "Stoßzeiten". Es werden NUR anonyme, aggregierte Zahlen
 * gespeichert, keinerlei personenbezogene Daten.
 *
 * Datenmodell (zwei Redis-Hashes je Wochentag):
 *   typical:sum:{wd}   field=slot -> Summe aller gemessenen counts
 *   typical:cnt:{wd}   field=slot -> Anzahl der Messungen
 *   Durchschnitt = sum / cnt
 *
 *   wd   = 0..6  (0 = Sonntag, lokale Zeit, Standard Europe/Berlin)
 *   slot = 0..47 (30-Min-Raster: hour*2 + (minute >= 30 ? 1 : 0))
 *
 * Es wird bewusst KEIN SDK benutzt (nur fetch gegen die Upstash-REST-API),
 * damit das Projekt ohne npm-Dependencies auskommt.
 */

// Upstash/Vercel-KV legt diese Variablen automatisch an. Wir akzeptieren die
// gängigen Namensvarianten, damit es ohne manuelles Zutun greift.
const KV_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.STORAGE_REST_API_URL;
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.STORAGE_REST_API_TOKEN;

const SLOTS_PER_DAY = 48;                 // 30-Minuten-Raster
const TZ = process.env.STUDIO_TZ || 'Europe/Berlin';

// "Gedächtnis"-Fenster: Sobald ein Slot so viele Messungen gesammelt hat,
// verblasst pro neuer Live-Messung der älteste Anteil (gleitender Schnitt /
// EWMA). Dadurch spiegeln die Werte die jüngere Realität wider — die Live-Daten
// haben Priorität, die historische Basis wird über die Zeit überschrieben.
// 40 Messungen ≈ ~20 Wochen Speicher (Cron alle 15 min -> ~2 Messungen/Slot/Woche).
const MAX_SAMPLES = parseInt(process.env.TYPICAL_MAX_SAMPLES || '40', 10);

const hasStore = Boolean(KV_URL && KV_TOKEN);

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Aktuellen Wochentag/Slot in lokaler Studio-Zeit ermitteln (DST-sicher). */
function localParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const weekday = WD[get('weekday')];
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  const slot = hour * 2 + (minute >= 30 ? 1 : 0);
  return { weekday, hour, minute, slot };
}

/** Sendet eine Pipeline (Array von Kommando-Arrays) an die Upstash-REST-API. */
async function redisPipeline(commands) {
  if (!hasStore) {
    throw Object.assign(new Error('KV/Upstash ist nicht konfiguriert'), { code: 'no_store' });
  }
  const res = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`KV REST ${res.status} ${text}`.trim());
  }
  const data = await res.json();
  return data.map((d) => {
    if (d && d.error) throw new Error(`KV: ${d.error}`);
    return d ? d.result : null;
  });
}

/**
 * Aktuellen Live-Wert in den Wochentag/Slot-Topf einrechnen.
 * Unterhalb von MAX_SAMPLES wächst der einfache Durchschnitt; ab MAX_SAMPLES
 * läuft ein gleitender Schnitt (EWMA), sodass neue Live-Daten Priorität haben
 * und alte (auch die historische Basis) über die Zeit verblassen.
 */
async function recordCount(count, date = new Date()) {
  const { weekday, slot } = localParts(date);
  const c = Math.max(0, Math.round(count));
  const sumKey = `typical:sum:${weekday}`;
  const cntKey = `typical:cnt:${weekday}`;
  const f = String(slot);

  const [curSum, curCnt] = await redisPipeline([
    ['HGET', sumKey, f],
    ['HGET', cntKey, f],
  ]);
  let sum = Number(curSum) || 0;
  let cnt = Number(curCnt) || 0;

  if (cnt >= MAX_SAMPLES) {
    const factor = (MAX_SAMPLES - 1) / cnt;   // ältesten Anteil ausblenden
    sum = Math.round(sum * factor) + c;
    cnt = MAX_SAMPLES;
  } else {
    sum += c;
    cnt += 1;
  }

  await redisPipeline([
    ['HSET', sumKey, f, String(sum)],
    ['HSET', cntKey, f, String(cnt)],
  ]);
  return { weekday, slot, count: c, samples: cnt };
}

function avg(sum, cnt) {
  const s = Number(sum) || 0;
  const c = Number(cnt) || 0;
  return c > 0 ? s / c : null;
}

/** Typischer Wert für einen einzelnen Wochentag+Slot. */
async function getTypicalSlot(weekday, slot) {
  const [sum, cnt] = await redisPipeline([
    ['HGET', `typical:sum:${weekday}`, String(slot)],
    ['HGET', `typical:cnt:${weekday}`, String(slot)],
  ]);
  const a = avg(sum, cnt);
  return { typicalCount: a === null ? null : Math.round(a), samples: Number(cnt) || 0 };
}

function hashToMap(v) {
  if (!v) return {};
  if (Array.isArray(v)) {
    const m = {};
    for (let i = 0; i + 1 < v.length; i += 2) m[v[i]] = v[i + 1];
    return m;
  }
  if (typeof v === 'object') return v;
  return {};
}

/** Komplette Tageskurve (48 Slots) für einen Wochentag — für das Diagramm. */
async function getTypicalDay(weekday) {
  const [sumFlat, cntFlat] = await redisPipeline([
    ['HGETALL', `typical:sum:${weekday}`],
    ['HGETALL', `typical:cnt:${weekday}`],
  ]);
  const sums = hashToMap(sumFlat);
  const cnts = hashToMap(cntFlat);
  const day = [];
  let totalSamples = 0;
  for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
    const n = Number(cnts[slot]) || 0;
    totalSamples += n;
    const a = avg(sums[slot], cnts[slot]);
    day.push(a === null ? null : Math.round(a));
  }
  return { day, totalSamples };
}

/** Komplette Woche (7 Tageskurven) in einem Rutsch — für die Empfehlungslogik. */
async function getTypicalWeek() {
  const cmds = [];
  for (let wd = 0; wd < 7; wd++) {
    cmds.push(['HGETALL', `typical:sum:${wd}`]);
    cmds.push(['HGETALL', `typical:cnt:${wd}`]);
  }
  const res = await redisPipeline(cmds);
  const week = [];
  for (let wd = 0; wd < 7; wd++) {
    const sums = hashToMap(res[wd * 2]);
    const cnts = hashToMap(res[wd * 2 + 1]);
    const day = [];
    for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
      const a = avg(sums[slot], cnts[slot]);
      day.push(a === null ? null : Math.round(a));
    }
    week.push(day);
  }
  return week;
}

module.exports = {
  hasStore,
  localParts,
  recordCount,
  getTypicalSlot,
  getTypicalDay,
  getTypicalWeek,
  redisPipeline,
  SLOTS_PER_DAY,
  TZ,
};
