'use strict';

/**
 * FINN Journeys – Durchlauf aus normalem App-Verkehr anstoßen.
 * -----------------------------------------------------------------------------
 * GitHub startet geplante Workflows in diesem Repository nur sporadisch (ein
 * „alle 15 Minuten"-Zeitplan lief teils nur alle paar Stunden). Ein Vercel-Cron
 * im 15-Minuten-Takt setzt den Pro-Tarif voraus und bricht sonst das Deployment ab.
 *
 * Deshalb: Häufig aufgerufene Endpunkte rufen maybe(). Höchstens alle 14 Minuten
 * (atomar über KV „SET NX", je Instanz zusätzlich höchstens eine Nachfrage pro
 * Minute) startet danach ein kurzer Durchlauf über Vercels waitUntil – die Antwort
 * an den Aufrufer wartet NICHT darauf. Ohne waitUntil (lokal, Tests, anderer Host)
 * passiert nichts: lieber kein Durchlauf als ein abgebrochener.
 *
 * Der Durchlauf selbst ist unverändert (lib/journeys/tick): Sperre gegen parallele
 * Läufe, Ruhezeiten, Kappen, fortsetzbar. Das Zeitbudget ist klein (20 s), damit er
 * weit vor der Laufzeitgrenze des aufrufenden Endpunkts (60 s) fertig ist.
 */

const KV = require('../finn/kv');
const Config = require('./config');

const KEY = 'jr:autotick';
const GAP_SEC = 14 * 60;
const BUDGET_MS = 20000;
let lastTry = 0;

// Vercels Anfrage-Kontext (so liest ihn auch @vercel/functions) – ohne Abhängigkeit.
function vercelContext() {
  try {
    const holder = globalThis[Symbol.for('@vercel/request-context')];
    const ctx = holder && typeof holder.get === 'function' ? holder.get() : null;
    return ctx && typeof ctx.waitUntil === 'function' ? ctx : null;
  } catch (e) { return null; }
}

/**
 * Nicht blockierend: liefert sofort true (Durchlauf eingeplant) oder false.
 * src: kurzer Name des Auslösers für die Anzeige „Letzter Durchlauf".
 */
function maybe(src) {
  try {
    if (!Config.tracking()) return false;
    const now = Date.now();
    if (now - lastTry < 60000) return false;
    const ctx = vercelContext();
    if (!ctx) return false;
    lastTry = now;
    ctx.waitUntil((async () => {
      const got = await KV.set(KEY, String(now), GAP_SEC, { nx: true });
      if (!got) return;
      await require('./tick').run({ budgetMs: BUDGET_MS, src: 'app' + (src ? ':' + String(src).slice(0, 20) : '') });
    })().catch(() => {}));
    return true;
  } catch (e) { return false; }
}

function _reset() { lastTry = 0; }

module.exports = { maybe, vercelContext, KEY, GAP_SEC, BUDGET_MS, _reset };
