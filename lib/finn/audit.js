'use strict';

/**
 * FINN – Audit-Log.
 * -----------------------------------------------------------------------------
 * Jede Tool-Ausführung, Bestätigung und Übergabe hinterlässt einen Eintrag –
 * OHNE Freitext, ohne Nachrichteninhalte, ohne Gesundheitsdaten. Nur:
 *   at, traceId, agent, tool, risk, actorKind, actorId, channel, status, via,
 *   code (Fehlerklasse), ms, validated, confirmId
 *
 * Keys: finnaud:all (LIST, 2000) · finnaud:m:<customerId> (LIST, 200) · Zähler finnaud:n:<status>
 */

const KV = require('./kv');

const CAP_ALL = 2000, CAP_MEMBER = 200, TTL = 400 * 86400;
const FIELDS = ['traceId', 'agent', 'tool', 'risk', 'channel', 'status', 'via', 'code', 'ms', 'validated', 'confirmId', 'kind'];

function clean(e) {
  const out = { at: Date.now() };
  FIELDS.forEach((k) => { if (e[k] != null) out[k] = (typeof e[k] === 'string') ? e[k].slice(0, 80) : e[k]; });
  if (e.actor) { out.actorKind = String(e.actor.kind || '').slice(0, 12); out.actorId = e.actor.id != null ? String(e.actor.id).slice(0, 32) : null; }
  if (e.customerId != null) out.customerId = String(e.customerId).slice(0, 32);
  else if (out.actorKind === 'member') out.customerId = out.actorId;
  return out;
}

async function record(e) {
  const rec = clean(e || {});
  try {
    await KV.lpush('finnaud:all', rec, CAP_ALL, TTL);
    if (rec.customerId) await KV.lpush('finnaud:m:' + rec.customerId, rec, CAP_MEMBER, TTL);
    await KV.incr('finnaud:n:' + (rec.status || 'unknown'), TTL);
  } catch (err) {}
  return rec;
}

async function list(opts) {
  opts = opts || {};
  const n = Math.max(1, Math.min(500, opts.limit || 100));
  const rows = await KV.lrangeJSON(opts.customerId ? ('finnaud:m:' + String(opts.customerId)) : 'finnaud:all', 0, n - 1);
  return opts.tool ? rows.filter((r) => r.tool === opts.tool) : rows;
}

async function counts() {
  const out = {};
  for (const s of ['ok', 'failed', 'forbidden', 'rejected', 'invalid', 'rate_limited', 'confirmed', 'declined', 'proposed', 'handoff']) {
    const v = await KV.get('finnaud:n:' + s); out[s] = Number(v) || 0;
  }
  return out;
}

module.exports = { record, list, counts, clean };
