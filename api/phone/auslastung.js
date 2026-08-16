'use strict';

/**
 * GET /api/phone/auslastung        (?key=… oder Authorization: Bearer …)
 *
 * „Ist gerade viel los?" — und die Frage dahinter: „Wann soll ich kommen?"
 *
 * ── Warum eine eigene Aktion neben /api/phone/info ──────────────────────────
 * info liefert die Auslastung nur als Nebensatz und nur, wenn gerade geöffnet
 * ist. Wer aber anruft, um den Besuch zu planen, will mehr wissen als „ziemlich
 * voll": nämlich ob das für die Uhrzeit normal ist und wann es heute noch ruhig
 * wird. Beides steht bereit — die Live-Zahl aus Magicline und die typische
 * Tageskurve aus dem Speicher —, war aber nirgends verbunden.
 *
 * ── Direkt statt über HTTP ──────────────────────────────────────────────────
 * info holt die Auslastung mit einem HTTP-Aufruf an die eigene Bereitstellung
 * (`/api/auslastung`, 2 Sekunden Zeitlimit). Das ist eine zweite
 * Funktionsausführung samt möglichem Kaltstart, und bei jedem Überschreiten
 * fällt die Auslastung stillschweigend weg. Hier wird lib/utilization direkt
 * aufgerufen — dieselbe Antwort, ohne den Umweg.
 *
 * ── Zahlen bleiben drinnen ──────────────────────────────────────────────────
 * Am Telefon wird gesagt, WIE voll es ist, nicht wie viele Menschen da sind.
 * Die genaue Kopfzahl ist eine Betriebszahl; sie gehört nicht in eine Auskunft
 * an Anrufer, die auch der Wettbewerb anrufen kann. `prozent` steht in der
 * Antwort für den Assistenten, `text` ist das, was er vorliest.
 */

const P = require('../../lib/phoneApi');
const U = require('../../lib/utilization');
const { fetchHours } = require('../../lib/studioHours');
const { getTypicalSlot, getTypicalDay, localParts, hasStore } = require('../../lib/store');

const MAX_CAPACITY = parseInt(process.env.MAX_CAPACITY || '40', 10);
const SLOTS = 48;                       // halbstündlich

// Dieselben Schwellen wie in lib/phoneApi.loadText – eine Auskunft darf sich
// nicht danach unterscheiden, über welche Aktion sie kam.
function stufe(p) {
  if (p == null) return null;
  if (p < 35) return { wort: 'wenig los', rang: 0 };
  if (p < 70) return { wort: 'normal viel los', rang: 1 };
  return { wort: 'ziemlich voll', rang: 2 };
}

function uhr(slot) {
  const h = Math.floor(slot / 2);
  const m = (slot % 2) ? '30' : '00';
  return h + ':' + m;
}

// „gerade deutlich voller als sonst um diese Zeit“ – der Vergleich ist das,
// was die Live-Zahl erst einordnet.
function vergleich(jetzt, typisch) {
  if (jetzt == null || typisch == null || typisch < 3) return null;   // zu dünne Datenlage
  const d = jetzt - typisch;
  const rel = d / Math.max(1, typisch);
  if (rel > 0.35) return 'etwas mehr als sonst um diese Zeit';
  if (rel < -0.35) return 'weniger als sonst um diese Zeit';
  return 'ungefähr so viel wie sonst um diese Zeit';
}

/**
 * Wann wird es heute noch ruhiger?
 *
 * Gesucht ist der nächste Zeitraum, der spürbar unter dem jetzigen Stand liegt –
 * nicht das Minimum des Tages. „Ab 22:30 ist kaum jemand da" hilft niemandem,
 * wenn um 23 Uhr geschlossen wird; „ab 20 Uhr wird es ruhiger" schon.
 */
function naechsteRuhige(day, abSlot, jetztWert) {
  if (!Array.isArray(day) || jetztWert == null) return null;
  const schwelle = jetztWert * 0.7;
  for (let s = abSlot + 1; s < SLOTS; s++) {
    const v = day[s];
    if (typeof v !== 'number' || v <= 0) continue;
    if (v <= schwelle) {
      // Nur melden, wenn es auch eine halbe Stunde später noch ruhig bleibt –
      // sonst ist es eine Zufallsdelle in der Kurve.
      const n = day[s + 1];
      if (typeof n === 'number' && n > jetztWert * 0.85) continue;
      return { slot: s, text: 'ab ' + uhr(s) };
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return P.json(res, 405, { ok: false, error: 'method_not_allowed' });
  const g = await P.guard(req, null, 120);
  if (!g.ok) return P.json(res, g.code, g.body);

  // Live-Zahl direkt aus der geteilten Logik – kein Umweg über HTTP.
  let live = null;
  try { live = await U.fetchUtilization(); } catch (e) { live = null; }
  const prozent = (live && typeof live.percent === 'number') ? live.percent : null;
  const st = stufe(prozent);

  // Typische Auslastung – ohne Speicher gibt es sie nicht, das ist kein Fehler.
  let typischJetzt = null, tageskurve = null, jetztSlot = null;
  if (hasStore) {
    try {
      const lp = localParts(new Date(Date.now()));
      jetztSlot = lp.slot;
      const [slotDaten, tagDaten] = await Promise.all([
        getTypicalSlot(lp.weekday, lp.slot),
        getTypicalDay(lp.weekday),
      ]);
      if (slotDaten && slotDaten.samples >= 3) typischJetzt = slotDaten.typicalCount;
      if (tagDaten && Array.isArray(tagDaten.day)) tageskurve = tagDaten.day;
    } catch (e) { /* dann eben nur die Live-Zahl */ }
  }

  const jetztWert = (live && typeof live.count === 'number') ? live.count : null;
  const einordnung = vergleich(jetztWert, typischJetzt);
  const ruhiger = (jetztSlot != null && st && st.rang >= 1)
    ? naechsteRuhige(tageskurve, jetztSlot, jetztWert) : null;

  // Ist geschlossen, ist jede Auslastungsangabe irreführend.
  let hours = null;
  try { const h = await fetchHours(); hours = (h && h.available) ? h : null; } catch (e) { hours = null; }
  const offen = hours ? P.openStatus(hours, Date.now()) : null;

  const teile = [];
  if (offen && offen.open === false) {
    teile.push(offen.text);
  } else if (!st) {
    teile.push('Zur aktuellen Auslastung habe ich gerade keine Zahl.');
  } else {
    teile.push('Aktuell ist ' + st.wort + '.');
    if (einordnung) teile.push('Das ist ' + einordnung + '.');
    if (ruhiger) teile.push('Ruhiger wird es erfahrungsgemäß ' + ruhiger.text + '.');
  }

  return P.json(res, 200, {
    ok: true,
    text: teile.join(' '),
    // Fuer den Assistenten, nicht zum Vorlesen: die genaue Kopfzahl bleibt drinnen.
    prozent: prozent,
    stufe: st ? st.wort : null,
    imVergleich: einordnung,
    ruhigerAb: ruhiger ? ruhiger.text : null,
    offen: offen ? offen.open : null,
    datenlage: {
      live: prozent != null,
      typisch: typischJetzt != null,
    },
    naechsterSchritt: (offen && offen.open === false)
      ? 'Es ist geschlossen - keine Auslastung nennen, sondern die Oeffnungszeiten.'
      : 'Nur „text" vorlesen. Niemals die Personenzahl oder Prozentwerte nennen - das sind '
        + 'Betriebszahlen. Fragt jemand nach einer genauen Zahl, freundlich bei der '
        + 'Einschaetzung bleiben.',
  });
};
