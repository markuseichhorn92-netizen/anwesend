'use strict';

/**
 * Team-Backend: FINN & Magicline-Integration.
 *   GET ?view=status                 -> Scopes (🟢🟡🔴), Webhook-Statistik, Event-Bus, Audit-Zähler, Metriken, Modus
 *   GET ?view=events&n=100           -> Event-Protokoll (Typ, Aktion, Klasse, Zeit – keine Personendaten)
 *   GET ?view=audit&n=100[&customerId=] -> Audit-Log der Agenten (ohne Freitext)
 *   GET ?view=timeline&customerId=   -> FINN-Verlauf einer Person (Team-Profil)
 *   GET ?view=agents                 -> Agenten und ihre Werkzeuge (Dokumentation im Backend)
 *   POST { message, customerId?, history? | action:'confirm'|'decline', id }
 *                                    -> Team-Kanal des Orchestrators (Team-Guardrail)
 *   POST { action:'probe', customerId? } -> Scope-Probe, nur lesende Aufrufe (lib/finn/probe.js)
 *
 * Rechte: status/events/audit/agents/POST nur Admin (admin.manage); timeline mit member.read.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  const J = (o, code) => { res.statusCode = code || 200; res.end(JSON.stringify(o)); };
  let q = {}; try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams.entries()); } catch (e) {}
  const n = Math.max(1, Math.min(500, parseInt(q.n, 10) || 100));

  if (req.method === 'GET') {
    const view = String(q.view || 'status');
    if (view === 'timeline') {
      if (!Cap.requireCap(sess, 'member.read', res)) return;
      const cid = String(q.customerId || '');
      if (!/^[0-9]{1,12}$/.test(cid)) return J({ ok: false, error: 'bad_customer' }, 400);
      const [items, signals] = await Promise.all([require('../../lib/finn/timeline').list(cid, n), require('../../lib/finn/automations').signals(cid)]);
      return J({ ok: true, items: items, signals: signals });
    }
    if (!Cap.requireCap(sess, 'admin.manage', res)) return;
    if (!TA.isAdmin(sess)) return J({ ok: false, error: 'forbidden' }, 403);
    if (view === 'events') return J({ ok: true, items: await require('../../lib/finn/events').log(n) });
    if (view === 'audit') {
      const cid = q.customerId && /^[0-9]{1,12}$/.test(String(q.customerId)) ? String(q.customerId) : null;
      return J({ ok: true, items: await require('../../lib/finn/audit').list({ limit: n, customerId: cid }) });
    }
    if (view === 'agents') {
      const Agents = require('../../lib/finn/agents'), Tools = require('../../lib/finn/tools');
      return J({ ok: true, agents: Agents.list().map((a) => ({ key: a.key, name: a.name, purpose: a.purpose, actors: a.actors, tools: a.tools })), tools: Tools.list().map((t) => ({ name: t.name, risk: t.risk, scopes: t.scopes, actors: t.actors, description: t.description })) });
    }
    // status
    const FCap = require('../../lib/finn/capabilities'), Events = require('../../lib/finn/events'), Audit = require('../../lib/finn/audit'), Metrics = require('../../lib/finn/metrics'), ML = require('../../lib/finn/magicline'), KV = require('../../lib/finn/kv');
    let webhook = {}; try { webhook = await require('../../lib/mlEvents').readStats(); } catch (e) {}
    const [caps, ev, aud, mx] = await Promise.all([FCap.status(), Events.stats(15), Audit.counts(), Metrics.read()]);
    return J({
      ok: true,
      mode: { agents: process.env.FINN_AGENTS === '1', magicline: ML.mockOn() ? 'mock' : 'live', mockRequestedInProd: ML.mockRequestedInProd(), kv: KV.mode(), ai: !!require('../../lib/ai').hasAI, automations: process.env.FINN_AUTOMATIONS == null ? 'timeline,retention' : process.env.FINN_AUTOMATIONS, publicChat: process.env.FINN_PUBLIC === '1', emailDraft: process.env.FINN_EMAIL_DRAFT === '1' },
      capabilities: caps, webhook: webhook, events: ev, audit: aud, metrics: mx,
    });
  }

  if (req.method === 'POST') {
    if (!Cap.requireCap(sess, 'admin.manage', res)) return;
    if (!TA.isAdmin(sess)) return J({ ok: false, error: 'forbidden' }, 403);
    const M = require('../../lib/members');
    const body = await M.readBody(req);
    if (String(body.action || '') === 'probe') {
      try { return J(await require('../../lib/finn/probe').run({ customerId: body.customerId, actor: { kind: 'team', id: String(sess.user || sess.name || 'team') } })); }
      catch (e) { return J({ ok: false, error: 'failed' }, 200); }
    }
    try { return J(await require('../../lib/finn/channels').teamTurn(sess, body)); }
    catch (e) { return J({ ok: false, error: 'failed' }, 200); }
  }
  return J({ ok: false, error: 'method_not_allowed' }, 405);
};
