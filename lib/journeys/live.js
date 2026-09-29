'use strict';

/**
 * FINN Journeys – Sofortversand nach einem Ereignis.
 * -----------------------------------------------------------------------------
 * Magicline meldet Vertrag, Termin oder Check-in sofort. Bisher merkten die Hooks die
 * Person nur vor, gesendet wurde erst im nächsten Durchlauf. kick() verarbeitet die
 * Person direkt im Anschluss – über Vercels waitUntil, die Antwort an den Aufrufer
 * (Magicline, Twilio, App) wartet NICHT darauf.
 *
 * Alle Sperren bleiben, weil sie im Sender sitzen (Einwilligung, STOP, Ruhezeiten →
 * verschieben, Kappen, 24-h-Fenster, Probelauf). Doppelversand verhindern die Sperre je
 * Person (tick.processOne) und die Einmal-Marke je Schritt (engine).
 *
 * Ohne waitUntil (lokal, Tests, anderer Host) passiert nichts – der Durchlauf holt die
 * Person in wenigen Minuten nach.
 */

const Config = require('./config');

const BUDGET_ML = 2;   // Magicline-Aufrufe je Sofortversand (Profil nachladen)

function later(task) {
  try {
    if (!Config.on()) return false;
    const ctx = require('./autotick').vercelContext();
    if (!ctx) return false;
    ctx.waitUntil(task().catch(() => {}));
    return true;
  } catch (e) { return false; }
}

function kick(subj, src) {
  if (!subj) return false;
  return later(() => run(String(subj), src));
}

/**
 * Nach einer neuen Einwilligung (START-Code, START, „Ja", App-Schalter): Schritte, die
 * mangels Einwilligung zurückgestellt waren (alle 6 h neu prüfen), sofort erneut prüfen –
 * z. B. die Willkommensnachricht direkt nach dem Opt-in. Person über Kunden-Id, sonst Nummer.
 */
function afterConsent(phone, cid, src) {
  return later(async () => {
    const Store = require('./store');
    let subj = cid != null && Store.isMemberId(cid) ? String(cid) : null;
    if (!subj && phone) subj = await Store.forPhone(require('../phone').canon(phone) || phone);
    if (!subj) return null;
    return run(subj, src || 'consent', { clearDefer: true });
  });
}

// Auch direkt aufrufbar (Tests): verarbeitet die Person jetzt.
async function run(subj, src, opts) {
  const Tick = require('./tick');
  const r = await Tick.processOne(subj, Date.now(), { ml: BUDGET_ML }, opts);
  try { console.log('[journeys]', JSON.stringify({ ev: 'live', src: String(src || '').slice(0, 20), sent: (r && r.sent) || 0, locked: !!(r && r.locked) })); } catch (e) {}
  return r;
}

module.exports = { kick, afterConsent, run, BUDGET_ML };
