'use strict';

/**
 * WhatsApp: Gesundheitsdaten nur nach einem ausdrücklichen „Ja" im Chat.
 * -----------------------------------------------------------------------------
 * Erkennt FINN ein Mitglied an der Nummer (lib/waIdentity), beantwortet er Fragen zu
 * Vertrag, Terminen und Besuchen sofort. Körperwerte, Lebensstil-, Vital- und gemerkte
 * FINN-Angaben sind Gesundheitsdaten (Art. 9 DSGVO) und brauchen eine ausdrückliche
 * Einwilligung. Die holt dieses Modul im Chat – mit festem Text, nicht vom Modell:
 *
 *   Frage erkennbar zu eigenen Körper-/Gesundheitswerten, noch keine Einwilligung
 *     → feste Rückfrage (CONSENT_TEXT), ursprüngliche Frage 30 min gemerkt
 *   „Ja"   → Einwilligung gespeichert (wa:hc:<nummer>) + Nachweis (lib/privacy,
 *            Typ wa_ai_health), dann die ursprüngliche Frage MIT Gesundheitskontext
 *   „Nein" → ursprüngliche Frage OHNE Gesundheitskontext
 *   „Gesundheitsdaten aus" → Einwilligung zurückgenommen (+ Nachweis)
 *
 * Wer die Nummer über den Link (Geburtsdatum + E-Mail, lib/waAuth) bestätigt hat, hat
 * dort bereits eingewilligt (wa-finn-2026-07, inkl. Trainings-/Ernährungsdaten).
 */

const KV = require('./finn/kv');

const VERSION = 'wa-health-2026-09';
const HC_TTL = 400 * 86400;
const ASK_TTL = 30 * 60;

// Wortlaut = Nachweistext (lib/privacy DEFINITIONS.wa_ai_health), eine Quelle.
const CONSENT_TEXT = require('./privacy').definition('wa_ai_health').text;
const TXT = {
  off: 'Alles klar – ich nutze deine Körper- und Gesundheitsangaben hier nicht mehr. Mit „Ja" auf meine Nachfrage kannst du das jederzeit wieder erlauben.',
  no: 'Okay, dann antworte ich ohne deine Körper- und Gesundheitsangaben. 👍',
};

// Fragen, die erkennbar EIGENE Körper-/Gesundheitswerte brauchen.
const HEALTH_RE = /(inbody|k[öo]rper\s*(wert|fett|analyse|daten|zusammensetzung|zusammen)|muskelmasse|\bbmi\b|figur-?check|messwert|messung|vital\s*(wert|check|daten|status)|\bhrv\b|ruhepuls|blutdruck|lebensstil|meine?n?\s+(gewicht|werte|schlaf|puls|umf[äa]nge?|fortschritt))/i;
const YES_RE = /^\s*(?:1|ja|jo|jep|jap|yes|ok|okay|passt|gerne|gern|einverstanden|klar|genau)\b[\s!.,]*(?:bitte|gerne|gern|passt)?[\s!.]*$/i;
const NO_RE = /^\s*(?:2|nein|ne|nö|no|lieber\s+nicht|nicht)\b[\s!.,]*(?:danke)?[\s!.]*$/i;
const OFF_RE = /^\s*(?:gesundheitsdaten\s+aus|einwilligung\s+widerrufen|gesundheitsdaten\s+widerrufen)\s*[.!]*\s*$/i;

function digitsOf(p) { return String(p == null ? '' : p).replace(/[^\d]/g, ''); }

async function has(phone, memberId) {
  const v = await KV.getJSON('wa:hc:' + digitsOf(phone)).catch(() => null);
  return !!(v && String(v.memberId) === String(memberId));
}

async function record(memberId, granted) {
  try { await require('./privacy').recordConsent(String(memberId), 'wa_ai_health', !!granted, { version: VERSION, source: 'whatsapp' }); } catch (e) {}
}

/**
 * Vor der KI-Antwort aufrufen.
 * o: { phone, memberId, text, verified }
 * -> { reply?, stop?, question, health }
 *    reply: Systemnachricht an das Mitglied (vorher senden)
 *    stop:  nichts weiter tun (Rückfrage gestellt / Widerruf bestätigt)
 *    question: was beantwortet werden soll (bei Ja/Nein die gemerkte Frage)
 *    health: Gesundheitskontext erlaubt?
 */
async function turn(o) {
  o = o || {};
  const d = digitsOf(o.phone);
  const text = String(o.text || '').trim();
  const allowed = !!o.verified || (await has(o.phone, o.memberId));
  if (OFF_RE.test(text)) {
    await KV.del('wa:hc:' + d).catch(() => {}); await KV.del('wa:hcask:' + d).catch(() => {});
    await record(o.memberId, false);
    return { reply: TXT.off, stop: true, question: text, health: false };
  }
  const ask = await KV.getJSON('wa:hcask:' + d).catch(() => null);
  if (ask && String(ask.memberId) === String(o.memberId) && (YES_RE.test(text) || NO_RE.test(text))) {
    await KV.del('wa:hcask:' + d).catch(() => {});
    if (YES_RE.test(text)) {
      await KV.set('wa:hc:' + d, { memberId: String(o.memberId), v: VERSION, at: Date.now() }, HC_TTL);
      await record(o.memberId, true);
      return { question: ask.q || text, health: true };
    }
    return { reply: TXT.no, question: ask.q || text, health: false };
  }
  if (!allowed && HEALTH_RE.test(text)) {
    await KV.set('wa:hcask:' + d, { memberId: String(o.memberId), q: text.slice(0, 1000), at: Date.now() }, ASK_TTL);
    return { reply: CONSENT_TEXT, stop: true, question: text, health: false };
  }
  return { question: text, health: allowed };
}

async function forget(phone) { const d = digitsOf(phone); if (!d) return; await KV.del('wa:hc:' + d).catch(() => {}); await KV.del('wa:hcask:' + d).catch(() => {}); }

module.exports = { turn, has, forget, CONSENT_TEXT, VERSION, HEALTH_RE, TXT };
