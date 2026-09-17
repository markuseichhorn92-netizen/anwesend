'use strict';

/**
 * FINN – Orchestrator (Einstiegspunkt für alle Kanäle).
 * -----------------------------------------------------------------------------
 *   handle(ctx, { message, history, conversationId })
 *     -> { ok, text, link, confirm, handoff, agent, traceId, blocked }
 *   confirm(ctx, id, conversationId)  /  decline(ctx, id, conversationId)
 *
 * ctx (vom Kanal-Adapter, serverseitig gebildet – nie vom Client):
 *   { actor:{kind:'member'|'team'|'lead', id}, channel:'web'|'whatsapp'|'email'|'team',
 *     securityScope:'member'|'team', member?:{firstName}, customerId? (Team), phone? }
 *
 * Reihenfolge je Nachricht: Rate-Limit -> Sicherheitsprüfung -> offene Bestätigung
 * per Ja/Nein -> Routing -> Agent-Lauf -> Gedächtnis -> Metriken/Audit.
 */

const AISecurity = require('../aiSecurity');
const Router = require('./router');
const Runtime = require('./runtime');
const Confirm = require('./confirm');
const Memory = require('./memory');
const Handoff = require('./handoff');
const Models = require('./models');
const Metrics = require('./metrics');
const Audit = require('./audit');
const KV = require('./kv');
const U = require('./util');

const LIMITS = { web: { n: 40, sec: 3600 }, whatsapp: { n: 30, sec: 3600 }, email: { n: 20, sec: 3600 }, team: { n: 120, sec: 3600 }, public: { n: 15, sec: 3600 } };
// Kurze Zustimmung/Ablehnung – auch die WhatsApp-Button-Titel („Ja, bestätigen" / „Abbrechen") und „1"/„2".
const YES = /^\s*(?:1|ja|jo|jep|jap|yes|ok|okay|passt|gerne|gern|bitte|best[aä]tige(?:n)?|mach(?:e)?\s*das|einverstanden|stimmt|genau|richtig|klar|los)(?:\s*[,!.]?\s*(?:ja|bitte|gerne|gern|best[aä]tige(?:n)?|passt|genau|mach\s*das))?[\s!.]*$/i;
const NO = /^\s*(?:2|nein|ne|nö|no|nicht|abbrechen|abbruch|stop+|lass(?:e)?\s*(?:es|das)|doch\s*nicht|lieber\s*nicht|verwerfen)(?:\s*[,!.]?\s*(?:danke|bitte|abbrechen|nicht))?[\s!.]*$/i;

function actorKey(ctx) { return (ctx.actor ? (ctx.actor.kind + ':' + ctx.actor.id) : 'anon'); }

async function rateOk(ctx) {
  const lim = LIMITS[ctx.channel] || LIMITS.web;
  const n = await KV.incr('finnrl:turn:' + actorKey(ctx) + ':' + (ctx.channel || 'web'), lim.sec);
  return n == null || n <= lim.n;
}

async function memoryText(ctx) {
  if (!ctx.actor || ctx.actor.kind !== 'member') return '';
  try { const FM = require('../finnMemory'); const mem = await FM.get(ctx.actor.id); return FM.toPromptText(mem) || ''; } catch (e) { return ''; }
}

// Diagnosezeile OHNE Personenbezug für die Vercel-Logs – wie [wa-assist] und
// [magicline-webhook]: nur Kanal, Agent, Ergebnisklasse, Schritte, Werkzeugnamen,
// Dauer und Fehlerklasse. KEIN Nachrichtentext, keine Kunden-Id.
function diag(o) { try { console.log('[finn]', JSON.stringify(o)); } catch (e) {} }

async function handle(ctx, input) {
  ctx = Object.assign({}, ctx || {});
  input = input || {};
  ctx.traceId = ctx.traceId || U.id(12);
  ctx.channel = ctx.channel || 'web';
  ctx.securityScope = ctx.securityScope || (ctx.actor && ctx.actor.kind === 'team' ? 'team' : 'member');
  const started = Date.now();
  const message = String(input.message || '').trim();
  const convId = input.conversationId != null ? String(input.conversationId) : actorKey(ctx);
  const out = (o) => {
    const r = Object.assign({ ok: true, text: '', link: null, confirm: null, handoff: null, agent: null, traceId: ctx.traceId, blocked: false, choices: [] }, o);
    diag({ ch: ctx.channel, kind: ctx.actor && ctx.actor.kind, agent: r.agent, ok: r.ok, err: r.error || null, blocked: r.blocked, confirm: !!r.confirm, handoff: !!r.handoff, steps: r.steps || 0, tools: r.toolsUsed || [], ms: Date.now() - started, trace: ctx.traceId });
    delete r.steps; delete r.toolsUsed;
    return r;
  };

  await Metrics.bump('finn.turn');
  if (message.length < 2) return out({ ok: false, error: 'empty', text: U.safeMessage('invalid') });
  if (!(await rateOk(ctx))) { await Metrics.bump('finn.rate_limited'); return out({ ok: false, error: 'rate_limited', text: U.safeMessage('rate_limited') }); }

  // Sicherheit: lokale Erkennung vor jedem Modellaufruf (zusätzlich zum Bedrock-Guardrail).
  const sec = AISecurity.assessText(message);
  if (!sec.ok && !(ctx.securityScope === 'team' && sec.reason === 'cross_member_data')) {
    await Metrics.bump('finn.blocked');
    await Audit.record({ kind: 'security', status: 'rejected', tool: 'input', code: sec.reason, actor: ctx.actor, channel: ctx.channel, traceId: ctx.traceId });
    return out({ blocked: true, text: AISecurity.safeRefusal(sec.reason), agent: 'security' });
  }

  const memo = await Memory.get(ctx.channel, convId);

  // Offene Bestätigung: kurzes Ja/Nein löst sie ein (wichtig für WhatsApp ohne Buttons).
  if (memo.pending) {
    if (YES.test(message)) return out(await confirm(ctx, memo.pending, convId));
    if (NO.test(message)) return out(await decline(ctx, memo.pending, convId));
  }

  if (!Models.available()) return out({ ok: false, error: 'no_ai', text: U.safeMessage('no_ai') });

  const r = await Router.routeWithModel(message, ctx, memo);
  await Metrics.bump('finn.route.' + r.agent);

  // Eskalation: direkt an Menschen übergeben – mit Kontext, ohne Modellaufruf.
  if (r.escalate) {
    ctx.agent = 'handoff'; ctx.agentPath = (memo.agent ? [memo.agent] : []).concat(['handoff']);
    const h = await Handoff.create(ctx, { reason: 'Heikles Thema (' + r.reason + ')', summary: 'Die Person hat ein Anliegen angesprochen, das ein Mensch übernehmen soll.', priority: 'hoch' });
    await Memory.set(ctx.channel, convId, { agent: 'handoff', pending: null, turns: (memo.turns || 0) + 1 });
    await Metrics.latency(ctx.channel, Date.now() - started);
    return out({ agent: 'handoff', handoff: { ref: h.ref }, text: 'Alles klar – da hole ich am besten jemanden aus dem Team dazu. ' + (h.ref ? ('Dein Anliegen liegt unter ' + h.ref + ' im Postfach, ') : '') + 'jemand meldet sich bei dir. 🙌', link: ctx.actor && ctx.actor.kind === 'member' ? { screen: 'postfach', label: 'Postfach öffnen' } : null, choices: [] });
  }

  ctx.memoryText = await memoryText(ctx);
  ctx.agentPath = memo.agent && memo.agent !== r.agent ? [memo.agent] : [];
  let res;
  try { res = await Runtime.run({ ctx: ctx, agent: r.agent, message: message, history: input.history }); }
  catch (e) { res = { ok: false, error: 'runtime_error' }; }
  await Metrics.latency(ctx.channel, Date.now() - started);
  await Metrics.bump('finn.agent.' + r.agent);

  if (!res.ok) {
    await Metrics.bump('finn.error.run');
    await Audit.record({ kind: 'turn', status: 'failed', agent: r.agent, code: String(res.error || 'failed').slice(0, 40), actor: ctx.actor, channel: ctx.channel, traceId: ctx.traceId });
    await Memory.set(ctx.channel, convId, { agent: r.agent, turns: (memo.turns || 0) + 1 });
    return out({ ok: false, error: res.error || 'ai_failed', agent: r.agent, text: U.safeMessage('failed'), link: ctx.actor && ctx.actor.kind === 'member' ? { screen: 'postfach', label: 'Ans Team schreiben' } : null });
  }
  await Memory.set(ctx.channel, convId, { agent: res.agent, pending: res.confirm ? res.confirm.id : null, turns: (memo.turns || 0) + 1, topics: (memo.topics || []).concat([r.agent]) });
  try { if (ctx.actor && ctx.actor.kind === 'member') require('../handled').record('ai', ctx.actor.id, 'finn_' + res.agent); } catch (e) {}
  // Auch reine Antworten (ohne Werkzeug) im Prüfpfad – sonst sieht das Team nur Aktionen.
  await Audit.record({ kind: 'turn', status: 'ok', tool: 'turn', agent: res.agent, actor: ctx.actor, channel: ctx.channel, traceId: ctx.traceId, ms: Date.now() - started, code: (res.toolsUsed && res.toolsUsed.length) ? (res.toolsUsed.length + '_tools') : null });
  return out({ text: res.text, link: res.link, confirm: res.confirm, handoff: res.handoff, agent: res.agent, steps: res.steps, toolsUsed: res.toolsUsed, choices: res.choices || [], choicesExplicit: !!res.choicesExplicit });
}

// Nach einer ausgeführten Aktion: passender App-Bereich als Link (Mitglied) – „Termine ansehen"
// fühlt sich nach Abschluss richtiger an als ein neuer Vorschlag.
const AFTER_LINK = { book_appointment: 'appt', cancel_appointment: 'appt', cancel_contract: 'contract', withdraw_cancellation: 'contract', withdraw_contract: 'contract', create_pause: 'contract', withdraw_pause: 'contract', book_module: 'contract', cancel_module: 'contract', update_contact: 'data', update_address: 'data', update_payment: 'data', set_comm_prefs: 'settings', block_access_medium: 'card', checkin_now: 'home' };
function afterLink(ctx, tool) {
  if (!(ctx.actor && ctx.actor.kind === 'member')) return null;
  const s = AFTER_LINK[tool]; if (!s) return null;
  try { const Coach = require('../../api/member/coach'); return Coach.SCREENS[s] ? { screen: s, label: Coach.SCREENS[s] + ' öffnen' } : null; } catch (e) { return null; }
}

function resultText(c) {
  if (c.ok) {
    let t = 'Erledigt ✓ ' + c.preview;
    if (c.validated) t += c.validated.ok ? '\nIch habe es gerade noch einmal in Magicline nachgesehen – passt.' : '\nHinweis: Die Nachprüfung konnte ich gerade nicht abschließen; das Team sieht es im Verlauf.';
    return t;
  }
  if (c.error === 'confirm_expired' || c.error === 'confirm_mismatch') return U.safeMessage(c.error);
  if (c.forbidden) return U.safeMessage('forbidden') + ' Sag einfach „ans Team", dann übergebe ich es mit allen Details.';
  if (c.error === 'invalid_date' || c.error === 'invalid') return 'Die Angaben passen nicht mehr zum aktuellen Stand. Sag mir bitte noch einmal, was du möchtest – ich prüfe es neu.';
  if (c.error === 'not_eligible' || c.error === 'not_creatable') return 'Das ist nach dem aktuellen Stand deines Vertrags gerade nicht möglich. Das Team kann es sich gern ansehen.';
  return U.safeMessage('failed');
}

async function confirm(ctx, id, conversationId) {
  ctx = Object.assign({}, ctx || {}); ctx.traceId = ctx.traceId || U.id(12);
  const c = await Confirm.confirm(ctx, id);
  const convId = conversationId != null ? String(conversationId) : actorKey(ctx);
  await Memory.set(ctx.channel || 'web', convId, { pending: null });
  const Agents = require('./agents');
  const agent = c.agent || ctx.agent || null;
  return { ok: !!c.ok, text: resultText(c), agent: agent, traceId: ctx.traceId, done: !!c.ok, error: c.ok ? null : c.error, forbidden: !!c.forbidden, link: c.ok ? afterLink(ctx, c.tool) : null, confirm: null, handoff: null, choices: c.ok ? Agents.quickFor(agent) : (c.forbidden ? [{ label: 'Ans Team' }] : []) };
}
async function decline(ctx, id, conversationId) {
  ctx = Object.assign({}, ctx || {}); ctx.traceId = ctx.traceId || U.id(12);
  const d = await Confirm.decline(ctx, id);
  const convId = conversationId != null ? String(conversationId) : actorKey(ctx);
  await Memory.set(ctx.channel || 'web', convId, { pending: null });
  const Agents = require('./agents');
  const agent = d.agent || ctx.agent || null;
  return { ok: true, text: d.ok ? 'Okay, ich habe nichts geändert. Sag einfach, wenn du etwas anderes möchtest.' : U.safeMessage(d.error), agent: agent, traceId: ctx.traceId, declined: !!d.ok, link: null, confirm: null, handoff: null, choices: Agents.quickFor(agent) };
}

module.exports = { handle, confirm, decline, LIMITS, YES, NO };
