'use strict';

/**
 * Wie viele Menschen protokollieren tatsächlich ihr Essen?
 * -----------------------------------------------------------------------------
 * Die Frage klang einfach und war es nicht: Bis hierher hat NICHTS in der App
 * mitgezählt, wer das Ernährungsmodul benutzt. Es gab weder einen Zähler noch
 * ein Verzeichnis – nur die Tagesdatensätze selbst, verstreut unter
 * `nutri:d:<id>:<datum>`. Die Zahl liess sich also nur aus dem Bestand
 * ableiten, nicht nachschlagen.
 *
 * Genau das macht diese Datei, und zwar ABLEITEND statt mitzählend. Das ist
 * bewusst so:
 *
 *  - Ein mitlaufender Zähler müsste an jeder Speicherstelle sitzen (bestätigen,
 *    manuell, Favorit, Rezept, Mahlzeit …). Wird eine vergessen, zählt er
 *    dauerhaft falsch, ohne dass es jemand merkt. Ein abgeleiteter Wert kann
 *    nicht driften: er liest, was wirklich da ist.
 *  - Ein Zähler beantwortet ausserdem nur die Zukunft. Die Frage lautete aber
 *    „aktuell" – und die Antwort steckt in den letzten 30 Tagen, die es längst
 *    gibt.
 *
 * DATENSCHUTZ: Ernährung ist Gesundheitsdatum (Art. 9 DSGVO). Deshalb verlässt
 * hier KEINE Kennung das Modul. Mitglieds-IDs existieren nur während des Laufs
 * im Zwischenstand – nötig, um Personen zu unterscheiden – und werden beim
 * Abschluss verworfen. Gespeichert und ausgeliefert werden ausschliesslich
 * Zahlen. Es gibt bewusst keine Liste „diese Personen protokollieren".
 *
 * WAS „NUTZT" HEISST: mindestens ein LEBENSMITTEL-Eintrag im Zeitraum. Ein Tag,
 * an dem nur Wasser angetippt wurde, zählt nicht – sonst schönt sich die Zahl
 * selbst.
 *
 * DER SCAN: Redis kennt keine Abfrage „alle Schlüssel mit diesem Muster" ohne
 * Durchlauf. SCAN läuft über den GESAMTEN Schlüsselraum, in Runden, jede Runde
 * eine HTTP-Anfrage an Upstash. Das kann länger dauern als eine Funktion leben
 * darf. Darum ist der Lauf FORTSETZBAR: jeder Aufruf arbeitet ein Stück ab und
 * legt Cursor und Zwischenstand in `nutri:usage:run`. Erst wenn der Cursor
 * wieder bei 0 steht, entsteht ein fertiges Ergebnis in `nutri:usage:snap`.
 * Gelesen wird immer nur das fertige Ergebnis – nie ein halber Durchgang.
 *
 * Keys:
 *   nutri:usage:snap   fertige Auswertung (nur Zahlen), 14 Tage
 *   nutri:usage:run    laufender Durchgang (Cursor + Zwischenstand), 6 Stunden
 */

const { redisPipeline, hasStore } = require('./store');

const SNAP = 'nutri:usage:snap';
const RUN = 'nutri:usage:run';
const SNAP_TTL = 60 * 60 * 24 * 14;
const RUN_TTL = 60 * 60 * 6;

const SCAN_COUNT = 1000;      // Schlüssel je SCAN-Runde (Upstash-Richtwert)
const RUNDEN = 25;            // Runden je Aufruf – Rest übernimmt der nächste
const MAX_SCHLUESSEL = 500000; // Notbremse: lieber unvollständig als endlos
const FENSTER = 30;           // Tage, für die Inhalte gelesen werden
const MAX_TAGESKEYS = 12000;  // Notbremse fürs Nachladen der Tagesinhalte
const REGELMAESSIG = 5;       // ab so vielen Protokolltagen in 30 Tagen

const P_PREFIX = 'nutri:p:';
const D_PREFIX = 'nutri:d:';

function berlinHeute() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}
function tagAbstand(heute, datum) {
  const a = Date.parse(heute + 'T12:00:00Z'), b = Date.parse(datum + 'T12:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

/**
 * Einen Tages-Schlüssel zerlegen. Der Datumsteil steht hinten und ist immer
 * zehn Zeichen lang – daran hängt die Trennung, nicht an der Anzahl der
 * Doppelpunkte. Eine Mitglieds-ID mit Doppelpunkt würde sonst alles verschieben.
 */
function zerlegeTag(key) {
  const rest = key.slice(D_PREFIX.length);
  const trenn = rest.lastIndexOf(':');
  if (trenn < 1) return null;
  const datum = rest.slice(trenn + 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return null;
  return { id: rest.slice(0, trenn), datum: datum };
}

function leererLauf(heute) {
  return { cursor: '0', heute: heute, gestartet: Date.now(), gesehen: 0, profile: [], jemals: [], tage: {} };
}

async function ladeLauf() {
  try {
    const [r] = await redisPipeline([['GET', RUN]]);
    if (!r) return null;
    const o = typeof r === 'string' ? JSON.parse(r) : r;
    return (o && o.heute) ? o : null;
  } catch (e) { return null; }
}
async function speichereLauf(lauf) {
  try { await redisPipeline([['SET', RUN, JSON.stringify(lauf), 'EX', String(RUN_TTL)]]); } catch (e) {}
}

/**
 * Einen Teil des Durchgangs abarbeiten. Gibt zurück, ob noch etwas offen ist –
 * der Aufrufer entscheidet, ob er weitermacht.
 * -> { fertig, cursor, gesehen, ergebnis? }
 */
async function weiter(opts) {
  if (!hasStore) return { fertig: true, gesehen: 0, ergebnis: null };
  const runden = Math.max(1, parseInt((opts && opts.runden) || RUNDEN, 10));
  const maxSchluessel = Math.max(1, parseInt((opts && opts.maxSchluessel) || MAX_SCHLUESSEL, 10));
  const heute = berlinHeute();

  let lauf = await ladeLauf();
  // Ein Durchgang, der über Mitternacht läuft, würde Tage falsch einordnen –
  // dann lieber neu anfangen.
  if (!lauf || lauf.heute !== heute) lauf = leererLauf(heute);

  const profile = new Set(lauf.profile || []);
  const jemals = new Set(lauf.jemals || []);
  const tage = lauf.tage || {};

  let cursor = String(lauf.cursor || '0');
  let abgebrochen = false;

  for (let i = 0; i < runden; i++) {
    let antwort = null;
    try {
      const [r] = await redisPipeline([['SCAN', cursor, 'MATCH', 'nutri:*', 'COUNT', String(SCAN_COUNT)]]);
      antwort = r;
    } catch (e) { break; }
    if (!Array.isArray(antwort) || antwort.length < 2) break;

    cursor = String(antwort[0]);
    const keys = Array.isArray(antwort[1]) ? antwort[1] : [];
    lauf.gesehen = (lauf.gesehen || 0) + keys.length;

    for (const k of keys) {
      const key = String(k);
      if (key.indexOf(P_PREFIX) === 0) { profile.add(key.slice(P_PREFIX.length)); continue; }
      if (key.indexOf(D_PREFIX) !== 0) continue;
      const t = zerlegeTag(key);
      if (!t) continue;
      jemals.add(t.id);
      const abstand = tagAbstand(heute, t.datum);
      if (abstand == null || abstand < 0 || abstand >= FENSTER) continue;
      const liste = tage[t.id] || (tage[t.id] = []);
      if (liste.indexOf(abstand) < 0) liste.push(abstand);
    }

    if (lauf.gesehen > maxSchluessel) { abgebrochen = true; break; }
    if (cursor === '0') break;
  }

  lauf.cursor = cursor;
  lauf.profile = Array.from(profile);
  lauf.jemals = Array.from(jemals);
  lauf.tage = tage;

  if (cursor !== '0' && !abgebrochen) {
    await speichereLauf(lauf);
    return { fertig: false, cursor: cursor, gesehen: lauf.gesehen };
  }

  const ergebnis = await abschliessen(lauf, !abgebrochen);
  try { await redisPipeline([['DEL', RUN]]); } catch (e) {}
  return { fertig: true, cursor: '0', gesehen: lauf.gesehen, ergebnis: ergebnis };
}

/**
 * Aus dem Zwischenstand die Zahlen machen. Hier werden die Inhalte nachgeladen –
 * vorher wissen wir nur, DASS es einen Tagesdatensatz gibt, nicht ob darin
 * Lebensmittel stehen oder nur ein angetipptes Wasserglas.
 */
async function abschliessen(lauf, vollstaendig) {
  const heute = lauf.heute;
  const tage = lauf.tage || {};
  const ids = Object.keys(tage);

  // Tagesinhalte in Blöcken holen (MGET) – ein Aufruf je 200 Schlüssel.
  const keys = [];
  const zuordnung = [];
  for (const id of ids) {
    for (const abstand of (tage[id] || [])) {
      if (keys.length >= MAX_TAGESKEYS) break;
      const d = new Date(Date.parse(heute + 'T12:00:00Z') - abstand * 86400000).toISOString().slice(0, 10);
      keys.push(D_PREFIX + id + ':' + d);
      zuordnung.push({ id: id, abstand: abstand });
    }
  }
  const werte = [];
  for (let i = 0; i < keys.length; i += 200) {
    const teil = keys.slice(i, i + 200);
    try {
      const [r] = await redisPipeline([['MGET'].concat(teil)]);
      (Array.isArray(r) ? r : teil.map(() => null)).forEach((v) => werte.push(v));
    } catch (e) { teil.forEach(() => werte.push(null)); }
  }

  // Je Person: an welchen Tagen wurde wirklich etwas gegessen protokolliert.
  const echteTage = {};
  let eintraege30 = 0, protokolltage30 = 0;
  werte.forEach((roh, i) => {
    if (!roh) return;
    let d = null;
    try { d = typeof roh === 'string' ? JSON.parse(roh) : roh; } catch (e) { return; }
    const anzahl = (d && Array.isArray(d.entries)) ? d.entries.length : 0;
    if (anzahl <= 0) return;               // Wasser allein ist kein Protokoll
    const z = zuordnung[i];
    const s = echteTage[z.id] || (echteTage[z.id] = []);
    if (s.indexOf(z.abstand) < 0) s.push(z.abstand);
    eintraege30 += anzahl;
    protokolltage30++;
  });

  const imFenster = (n) => Object.keys(echteTage).filter((id) => echteTage[id].some((a) => a < n)).length;
  const personen30 = Object.keys(echteTage).length;

  // Profile nachladen: „angelegt" ist nicht dasselbe wie „eingerichtet".
  let eingerichtet = 0;
  const pKeys = (lauf.profile || []).slice(0, 5000).map((id) => P_PREFIX + id);
  for (let i = 0; i < pKeys.length; i += 200) {
    try {
      const [r] = await redisPipeline([['MGET'].concat(pKeys.slice(i, i + 200))]);
      (Array.isArray(r) ? r : []).forEach((roh) => {
        if (!roh) return;
        try { const p = typeof roh === 'string' ? JSON.parse(roh) : roh; if (p && p.onboarded) eingerichtet++; } catch (e) {}
      });
    } catch (e) {}
  }

  const ergebnis = {
    stand: Date.now(),
    vollstaendig: !!vollstaendig,
    profile: (lauf.profile || []).length,
    eingerichtet: eingerichtet,
    jemals: (lauf.jemals || []).length,
    aktiv: { d1: imFenster(1), d7: imFenster(7), d30: personen30 },
    regelmaessig: Object.keys(echteTage).filter((id) => echteTage[id].length >= REGELMAESSIG).length,
    protokolltage30: protokolltage30,
    eintraege30: eintraege30,
    tageProPerson30: personen30 ? Math.round((protokolltage30 / personen30) * 10) / 10 : 0,
  };
  try { await redisPipeline([['SET', SNAP, JSON.stringify(ergebnis), 'EX', String(SNAP_TTL)]]); } catch (e) {}
  return ergebnis;
}

/** Den ganzen Durchgang abarbeiten, bis er fertig ist oder die Zeit knapp wird. */
async function auswerten(opts) {
  const frist = Date.now() + Math.max(2000, parseInt((opts && opts.msBudget) || 45000, 10));
  let letzte = { fertig: false, gesehen: 0 };
  while (Date.now() < frist) {
    letzte = await weiter({ runden: (opts && opts.runden) || RUNDEN });
    if (letzte.fertig) return letzte;
  }
  return letzte;
}

/** Das zuletzt fertig gewordene Ergebnis. Nie ein halber Durchgang. */
async function lesen() {
  if (!hasStore) return null;
  try {
    const [r] = await redisPipeline([['GET', SNAP]]);
    if (!r) return null;
    return typeof r === 'string' ? JSON.parse(r) : r;
  } catch (e) { return null; }
}

module.exports = { hasStore, weiter, auswerten, lesen, berlinHeute, zerlegeTag, SNAP, RUN, REGELMAESSIG, FENSTER };
