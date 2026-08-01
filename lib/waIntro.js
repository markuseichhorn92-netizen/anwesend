'use strict';

/**
 * Einmalige KI-Transparenz-Ansage je WhatsApp-Kontakt.
 * -----------------------------------------------------------------------------
 * Transparenzpflicht: Wer über WhatsApp mit dem automatischen Assistenten (FINN)
 * schreibt, muss erkennen, dass zunächst eine KI antwortet. Dieser Hinweis geht
 * daher als ALLERERSTE Nachricht raus – genau einmal pro Kontakt (idempotent per
 * Telefonnummer über KV). Danach nie wieder, damit der Chat nicht zugespamt wird.
 *
 * Wird ausschließlich auf den KI-Pfaden ausgelöst (verifiziertes Mitglied ->
 * FINN, sowie Interessenten-Autoantwort). Ist die WhatsApp-KI aus (dann antwortet
 * ein Mensch), gibt es keinen KI-Hinweis.
 *
 * Wirft nie. Ohne konfigurierten WhatsApp-Anbieter passiert nichts.
 */

const WA = require('./whatsapp');
const { redisPipeline, hasStore } = require('./store');

// Vom Studio vorgegebener Wortlaut (oder sehr ähnlich).
const DISCLOSURE = 'Hi! Hier antwortet zunächst ein KI-Assistent von Fit-Inn 🤖. '
  + 'Für ein persönliches Gespräch leite ich dich gerne ans Team weiter.';

const KEY = (digits) => 'wa:aidisc:' + digits;
const TTL = 60 * 60 * 24 * 180;   // 180 Tage – danach darf der Hinweis erneut kommen.

function digitsOf(phone) { return String(phone == null ? '' : phone).replace(/[^\d]/g, ''); }

/**
 * Sendet den KI-Hinweis genau einmal je Kontakt (vor der ersten inhaltlichen
 * Antwort). Liefert true, wenn jetzt gesendet wurde, sonst false. Wirft nie.
 *
 * Idempotenz über SET … NX (atomar prüfen+setzen). Bei Store-Fehler wird der
 * Hinweis lieber gesendet als verschluckt (Transparenz hat Vorrang).
 */
async function discloseOnce(phone) {
  const digits = digitsOf(phone);
  if (!digits || !WA.hasWhatsApp) return false;
  if (hasStore) {
    try {
      const r = await redisPipeline([['SET', KEY(digits), String(Date.now()), 'NX', 'EX', String(TTL)]]);
      const set = Array.isArray(r) ? r[0] : r;
      if (set !== 'OK') return false;   // bereits vorhanden -> nicht erneut senden
    } catch (e) { /* Store-Fehler: absichtlich weiter zum Senden */ }
  }
  try { await WA.sendText(phone, DISCLOSURE); return true; } catch (e) { return false; }
}

module.exports = { discloseOnce, DISCLOSURE };
