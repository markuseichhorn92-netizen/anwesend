'use strict';

/**
 * FINN – Confirmation Engine.
 * -----------------------------------------------------------------------------
 * MEDIUM- und HIGH-Tools werden nie direkt ausgeführt. Der Agent schlägt vor
 * (`propose`), der Mensch bestätigt ausdrücklich (`confirm`) oder lehnt ab
 * (`decline`). Der Vorschlag ist gebunden an: Aktor (Kind + Id), Kanal, Tool,
 * exakt diese Argumente (Hash). Gültig 10 Minuten, einmal einlösbar.
 *
 * Fail-closed: Ohne verfügbaren Speicher (Produktion ohne KV) wird KEIN Vorschlag
 * ausgestellt – die Aktion kann dann nur über den bestehenden App-Weg oder das
 * Team laufen.
 *
 * Key: finnact:<id>  { id, tool, args, argsHash, risk, preview, actor, channel, agent, traceId, createdAt, exp, state }
 */

const KV = require('./kv');
const Tools = require('./tools');
const Audit = require('./audit');
const Metrics = require('./metrics');
const Timeline = require('./timeline');
const U = require('./util');

const TTL = 600;   // 10 Minuten

const K = (id) => 'finnact:' + String(id);
const actorKey = (a) => (a ? (String(a.kind || '') + ':' + String(a.id == null ? '' : a.id)) : '');

async function propose(ctx, tool, args, preview, risk) {
  if (!KV.available()) return { ok: false, error: 'no_store' };
  const id = U.id(20);
  const rec = {
    id: id, tool: String(tool), args: args || {}, argsHash: U.hashArgs(args || {}), risk: risk || 'MEDIUM',
    preview: String(preview || '').slice(0, 400), actor: actorKey(ctx && ctx.actor), channel: (ctx && ctx.channel) || 'web',
    agent: (ctx && ctx.agent) || null, traceId: (ctx && ctx.traceId) || null, createdAt: Date.now(), exp: Date.now() + TTL * 1000, state: 'open',
  };
  const w = await KV.set(K(id), rec, TTL);
  if (w == null) return { ok: false, error: 'no_store' };
  await Audit.record({ kind: 'confirm', status: 'proposed', tool: rec.tool, risk: rec.risk, agent: rec.agent, actor: ctx && ctx.actor, channel: rec.channel, traceId: rec.traceId, confirmId: id });
  await Metrics.bump('finn.confirm.proposed');
  return { ok: true, id: id, preview: rec.preview, risk: rec.risk, tool: rec.tool, expiresAt: rec.exp };
}

async function load(ctx, id) {
  if (!id || !/^[A-Za-z0-9_-]{8,40}$/.test(String(id))) return { ok: false, error: 'confirm_expired' };
  const rec = await KV.getJSON(K(id));
  if (!rec || rec.state !== 'open') return { ok: false, error: 'confirm_expired' };
  if (rec.exp < Date.now()) { await KV.del(K(id)); await Metrics.bump('finn.confirm.expired'); return { ok: false, error: 'confirm_expired' }; }
  if (rec.actor !== actorKey(ctx && ctx.actor)) return { ok: false, error: 'confirm_mismatch' };
  return { ok: true, rec: rec };
}

// Einlösen: Bindung prüfen, Tool mit confirmed:true ausführen, Ergebnis validieren, auditieren.
async function confirm(ctx, id) {
  const l = await load(ctx, id);
  if (!l.ok) return { ok: false, error: l.error, message: U.safeMessage(l.error) };
  const rec = l.rec;
  // Einmaligkeit: erst als „used" markieren, dann ausführen (Doppelklick/Retry-Schutz).
  rec.state = 'used'; rec.usedAt = Date.now();
  await KV.set(K(id), rec, 120);
  const cx = Object.assign({}, ctx, { agent: rec.agent || (ctx && ctx.agent), traceId: rec.traceId || (ctx && ctx.traceId) });
  const r = await Tools.execute(cx, rec.tool, rec.args, { confirmed: true });
  await Audit.record({ kind: 'confirm', status: 'confirmed', tool: rec.tool, risk: rec.risk, agent: cx.agent, actor: ctx && ctx.actor, channel: rec.channel, traceId: cx.traceId, confirmId: id, code: r.error || null, validated: r.validated ? !!r.validated.ok : null });
  await Metrics.bump('finn.confirm.confirmed');
  const cid = Tools.targetId(cx, rec.args);
  if (cid != null) {
    await Timeline.add(cid, { kind: r.ok ? 'action' : 'action_failed', title: (r.ok ? 'Ausgeführt: ' : 'Fehlgeschlagen: ') + rec.preview, agent: cx.agent, source: 'agent', traceId: cx.traceId, detail: r.ok ? (r.validated ? ('Prüfung: ' + (r.validated.ok ? 'bestätigt' : 'nicht bestätigt')) : null) : ('Fehler: ' + (r.error || 'unbekannt')) });
  }
  return { ok: !!r.ok, result: r, tool: rec.tool, preview: rec.preview, risk: rec.risk, validated: r.validated || null, error: r.ok ? null : (r.error || 'failed'), forbidden: !!r.forbidden };
}

async function decline(ctx, id) {
  const l = await load(ctx, id);
  if (!l.ok) return { ok: false, error: l.error };
  const rec = l.rec; rec.state = 'declined';
  await KV.set(K(id), rec, 120);
  await Audit.record({ kind: 'confirm', status: 'declined', tool: rec.tool, risk: rec.risk, agent: rec.agent, actor: ctx && ctx.actor, channel: rec.channel, traceId: rec.traceId, confirmId: id });
  await Metrics.bump('finn.confirm.declined');
  return { ok: true, tool: rec.tool, preview: rec.preview };
}

async function peek(ctx, id) { const l = await load(ctx, id); return l.ok ? { ok: true, id: l.rec.id, tool: l.rec.tool, preview: l.rec.preview, risk: l.rec.risk, expiresAt: l.rec.exp } : { ok: false, error: l.error }; }

module.exports = { propose, confirm, decline, peek, TTL };
