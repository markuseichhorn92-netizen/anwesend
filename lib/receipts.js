'use strict';

/**
 * Zustell-/Lesestatus für gesendete Team-Nachrichten (WhatsApp + E-Mail).
 * Beim Senden wird die Provider-Nachrichten-ID -> {Vorgang, Nachricht-at} gemappt;
 * die Status-Webhooks (WhatsApp statuses / Resend delivered|opened) aktualisieren
 * dann den Status an genau dieser Nachricht. 30 Tage Aufbewahrung. Wirft nie.
 *
 * Status-Werte an der Nachricht: 'sent' | 'delivered' | 'read' | 'failed'.
 * (Bei E-Mail bedeutet 'read' = geöffnet – die UI kennzeichnet das als unsicher.)
 */

const { redisPipeline, hasStore } = require('./store');

const TTL = 60 * 60 * 24 * 30;   // 30 Tage
const K = (id) => 'rcpt:' + String(id);
const RANK = { sent: 1, delivered: 2, read: 3 };

function normStatus(s) {
  const t = String(s || '').toLowerCase().replace(/^email\./, '');
  if (t === 'read') return 'read';
  if (t === 'opened') return 'read';                 // E-Mail geöffnet ~ gelesen (unsicher)
  if (t === 'delivered' || t === 'delivery_delayed') return 'delivered';
  if (t === 'sent') return 'sent';
  if (t === 'failed' || t === 'undelivered' || t === 'bounced') return 'failed';
  return null;
}

// Provider-Nachrichten-ID -> Ort der Nachricht merken.
async function track(providerId, loc) {
  if (!hasStore || !providerId || !loc || loc.at == null) return;
  try {
    await redisPipeline([['SET', K(providerId), JSON.stringify({ m: String(loc.m), v: String(loc.v), at: loc.at }), 'EX', String(TTL)]]);
  } catch (e) {}
}

// Status eines gesendeten Nachricht-Objekts anhand der Provider-ID aktualisieren
// (nur „vorwärts": read überschreibt delivered, nicht umgekehrt). Liefert den
// Vorgang oder null. Wirft nie.
async function applyStatus(providerId, rawStatus) {
  try {
    if (!hasStore || !providerId) return null;
    const st = normStatus(rawStatus);
    if (!st) return null;
    let s; try { [s] = await redisPipeline([['GET', K(providerId)]]); } catch (e) { return null; }
    if (!s) return null;
    let loc = null; try { loc = JSON.parse(s); } catch (e) { return null; }
    if (!loc) return null;
    const Inbox = require('./inbox');
    const v = await Inbox.get(loc.m, loc.v);
    if (!v || !Array.isArray(v.messages)) return null;
    const msg = v.messages.find((mm) => mm && mm.from === 'team' && String(mm.at) === String(loc.at));
    if (!msg) return null;
    if (st === 'failed') {
      if (msg.st === 'read' || msg.st === 'delivered') return v;   // schon zugestellt -> failed ignorieren
      msg.st = 'failed';
    } else if ((RANK[st] || 0) > (RANK[msg.st] || 0)) {
      msg.st = st;
    } else {
      return v;   // kein Fortschritt -> nichts speichern
    }
    msg.stAt = Date.now();
    await Inbox.save(loc.m, v);
    return v;
  } catch (e) { return null; }
}

module.exports = { track, applyStatus };
