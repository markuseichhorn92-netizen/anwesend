'use strict';

/**
 * Gratis-Kontingent (Freemium) fürs Ernährungsmodul.
 * -------------------------------------------------------------------------
 * Basic-Mitglieder dürfen pro Kalendermonat eine begrenzte Zahl KI-Aktionen
 * nutzen (Rezepte generieren, Mahlzeit bewerten, Foto/Text schätzen, Coach
 * fragen). Danach greift das Premium-Upgrade. Premium = unbegrenzt.
 *
 * EIN gemeinsamer Monatszähler pro Mitglied (nicht pro Funktion), damit die
 * UI einfach „Noch X von 5 FINN-Aktionen diesen Monat" zeigen kann.
 *
 * Key:  nutri:q:<memberId>:<YYYY-MM>   INT (verbrauchte KI-Aktionen im Monat)
 *       läuft nach ~70 Tagen von selbst ab (kein Aufräumen nötig).
 *
 * WICHTIG: rein serverseitig durchgesetzt (Client-Anzeige ist nur Komfort).
 * Premium wird NIE hier gesetzt – das kommt allein aus den Entitlements.
 */

const { redisPipeline, hasStore } = require('./store');

const FREE_LIMIT = 5;                 // Gratis-KI-Aktionen pro Monat (Basic)
const TTL = 70 * 24 * 3600;           // Zähler-Lebensdauer (deckt den Monat + Puffer)
const QKEY = (id, month) => 'nutri:q:' + String(id) + ':' + String(month);

// Monat (YYYY-MM) aus einem Tagesdatum (YYYY-MM-DD).
function monthOf(ymd) { return String(ymd || '').slice(0, 7) || '0000-00'; }

// Bereits verbrauchte KI-Aktionen in diesem Monat.
async function getUsed(id, month) {
  if (!hasStore || !id) return 0;
  try { const [v] = await redisPipeline([['GET', QKEY(id, month)]]); const n = parseInt(v, 10); return isNaN(n) || n < 0 ? 0 : n; }
  catch (e) { return 0; }
}

// Eine KI-Aktion abbuchen (atomar). Gibt den neuen Verbrauchsstand zurück.
async function incr(id, month) {
  if (!hasStore || !id) return 0;
  try {
    const [n] = await redisPipeline([['INCR', QKEY(id, month)]]);
    // TTL nur setzen, wenn der Zähler gerade neu angelegt wurde (erster Verbrauch im Monat).
    if (Number(n) === 1) { try { await redisPipeline([['EXPIRE', QKEY(id, month), String(TTL)]]); } catch (e) {} }
    const num = parseInt(n, 10); return isNaN(num) ? 0 : num;
  } catch (e) { return 0; }
}

// Darf der (Nicht-Premium-)Nutzer noch? Reiner Lese-Check (verbraucht nichts).
async function canUse(id, month) { return (await getUsed(id, month)) < FREE_LIMIT; }

// Client-sichere Kontingent-Anzeige.
function publicQuota(used, premium, month) {
  const u = Math.max(0, parseInt(used, 10) || 0);
  return {
    unlimited: !!premium,
    limit: FREE_LIMIT,
    used: premium ? 0 : u,
    remaining: premium ? null : Math.max(0, FREE_LIMIT - u),
    month: month || null,
  };
}

module.exports = { FREE_LIMIT, QKEY, monthOf, getUsed, incr, canUse, publicQuota };
