'use strict';

/**
 * FINN – Kanal-Adapter.
 * -----------------------------------------------------------------------------
 * Gemeinsames Nachrichtenformat für den Orchestrator: der Kontext (`ctx`) wird
 * IMMER serverseitig aus einer geprüften Identität gebildet – nie aus dem Client.
 *
 *   memberTurn(sess, member, body)    Web/App (Bearer-Session) – Chat, Bestätigen, Ablehnen
 *   whatsapp({ memberId, vorgang, msg, phone })  verifizierte WhatsApp-Nummer
 *   emailDraft(memberId, vorgangId, text)        eingehende Mitglieder-Mail -> Entwurf als Team-Notiz
 *   publicTurn(visitorId, body)                  Website-Besucher (Lead), nur mit FINN_PUBLIC=1
 *   teamTurn(sess, body)                         Team-Backend (Team-Guardrail, customerId als Ziel)
 *
 * Antwortform für Clients: { ok, answer, link, confirm:{id,preview,risk}, handoff, agent, traceId }
 */

const Orc = require('./orchestrator');

function agentsOn() { return process.env.FINN_AGENTS === '1'; }
function publicOn() { return process.env.FINN_PUBLIC === '1'; }

function reply(r) {
  return { ok: !!r.ok, answer: r.text || '', link: r.link || null, confirm: r.confirm ? { id: r.confirm.id, preview: r.confirm.preview, risk: r.confirm.risk, expiresAt: r.confirm.expiresAt || null } : null, handoff: r.handoff || null, agent: r.agent || null, traceId: r.traceId || null, error: r.ok ? undefined : (r.error || 'failed'), blocked: !!r.blocked, done: !!r.done, declined: !!r.declined };
}

// ── Web/App ──
async function memberTurn(sess, member, body) {
  body = body || {};
  const ctx = { actor: { kind: 'member', id: String(sess.id) }, channel: 'web', securityScope: 'member', member: { firstName: member && member.firstName } };
  const convId = String(body.conversationId || ('web:' + sess.id)).slice(0, 80);
  const action = String(body.action || '');
  if (action === 'confirm') return reply(await Orc.confirm(ctx, String(body.id || ''), convId));
  if (action === 'decline') return reply(await Orc.decline(ctx, String(body.id || ''), convId));
  const history = Array.isArray(body.history) ? body.history.filter((h) => h && typeof h.text === 'string').slice(-8).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: String(h.text).slice(0, 1500) })) : [];
  if (body.live) ctx.live = String(body.live).slice(0, 4000);   // nur vom Server (coach.js) gesetzt
  return reply(await Orc.handle(ctx, { message: String(body.question || body.message || ''), history: history, conversationId: convId }));
}

// ── WhatsApp (verifiziertes Mitglied; v = Vorgang des Threads) ──
// Rückgabe { handled, text, buttons? } für lib/waAssistant.handleInbound.
async function whatsapp(o) {
  o = o || {};
  const v = o.vorgang || {};
  const ctx = { actor: { kind: 'member', id: String(o.memberId) }, channel: 'whatsapp', securityScope: 'member', phone: o.phone || null, vorgangId: v.id != null ? String(v.id) : null };
  const r = await Orc.handle(ctx, { message: String(o.text || ''), history: o.history || [], conversationId: 'wa:' + (v.id != null ? v.id : o.memberId) });
  if (!r.ok && !r.blocked && (r.error === 'no_ai' || r.error === 'ai_failed' || r.error === 'runtime_error' || r.error === 'empty')) return { handled: false, error: r.error };
  const out = { handled: true, text: r.text, agent: r.agent, traceId: r.traceId };
  if (r.confirm) {
    out.buttons = { body: r.text, options: [{ id: 'finn:ok:' + r.confirm.id, title: 'Ja, bestätigen' }, { id: 'finn:no:' + r.confirm.id, title: 'Abbrechen' }] };
    out.text = r.text + '\n\n1) Ja, bestätigen\n2) Abbrechen';
  }
  return out;
}

// ── E-Mail: Antwortentwurf als Team-Notiz (kein Versand, keine Aktionen) ──
async function emailDraft(memberId, vorgangId, text) {
  if (process.env.FINN_EMAIL_DRAFT !== '1') return { ok: false, skipped: 'off' };
  const ctx = { actor: { kind: 'member', id: String(memberId) }, channel: 'email', securityScope: 'member', readOnly: true, vorgangId: String(vorgangId) };
  const r = await Orc.handle(ctx, { message: String(text || '').slice(0, 4000), conversationId: 'mail:' + vorgangId });
  if (!r.ok || !r.text) return { ok: false, error: r.error || 'failed' };
  try {
    const Inbox = require('../inbox');
    await Inbox.addNote(memberId, vorgangId, { author: 'FINN (Entwurf)', text: 'Antwortvorschlag – bitte prüfen, bevor du antwortest:\n\n' + r.text });
  } catch (e) { return { ok: false, error: 'note_failed' }; }
  return { ok: true, agent: r.agent };
}

// ── Website (nicht angemeldet) ──
async function publicTurn(visitorId, body) {
  body = body || {};
  const ctx = { actor: { kind: 'lead', id: String(visitorId) }, channel: 'public', securityScope: 'member' };
  const convId = 'pub:' + String(visitorId);
  const action = String(body.action || '');
  if (action === 'confirm') return reply(await Orc.confirm(ctx, String(body.id || ''), convId));
  if (action === 'decline') return reply(await Orc.decline(ctx, String(body.id || ''), convId));
  const history = Array.isArray(body.history) ? body.history.slice(-6).filter((h) => h && typeof h.text === 'string').map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: String(h.text).slice(0, 800) })) : [];
  return reply(await Orc.handle(ctx, { message: String(body.message || ''), history: history, conversationId: convId }));
}

// ── Team ──
async function teamTurn(sess, body) {
  body = body || {};
  const cid = body.customerId != null && /^[0-9]{1,12}$/.test(String(body.customerId)) ? String(body.customerId) : null;
  const ctx = { actor: { kind: 'team', id: String(sess.user || sess.name || sess.id || 'team') }, channel: 'team', securityScope: 'team', customerId: cid };
  const convId = 'team:' + ctx.actor.id + ':' + (cid || '-');
  const action = String(body.action || '');
  if (action === 'confirm') return reply(await Orc.confirm(ctx, String(body.id || ''), convId));
  if (action === 'decline') return reply(await Orc.decline(ctx, String(body.id || ''), convId));
  const history = Array.isArray(body.history) ? body.history.slice(-8).filter((h) => h && typeof h.text === 'string').map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: String(h.text).slice(0, 1500) })) : [];
  return reply(await Orc.handle(ctx, { message: String(body.message || ''), history: history, conversationId: convId }));
}

module.exports = { agentsOn, publicOn, reply, memberTurn, whatsapp, emailDraft, publicTurn, teamTurn };
