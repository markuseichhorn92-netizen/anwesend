'use strict';

/**
 * FINN – Übergabe an Menschen (Human Handoff).
 * -----------------------------------------------------------------------------
 * Legt einen Vorgang im bestehenden Postfach an (lib/inbox.addVorgang), mit
 * Kontextpaket für das Team: Grund, Zusammenfassung (vom Agenten formuliert,
 * ohne Gesundheitsdetails), Agentenpfad, versuchte Aktionen, Kanal. Danach
 * Studio-Mail über den bestehenden Weg (lib/studioReply.notifyStudio) und ein
 * Timeline-Eintrag. Bei Leads (kein Kunde) nur Mail.
 *
 * Wirft nie. Ergebnis { ok, ref, vorgangId } bzw. { ok:false }.
 */

const Timeline = require('./timeline');
const Audit = require('./audit');
const Metrics = require('./metrics');

const TYPE_BY_AGENT = { contract: 'kuendigung', payment: 'allgemein', appointment: 'termin', access: 'allgemein', document: 'allgemein', retention: 'angebot' };

function contextText(ctx, o) {
  const lines = [];
  lines.push('FINN hat dieses Anliegen an das Team übergeben.');
  if (o.reason) lines.push('Grund: ' + o.reason);
  if (o.summary) lines.push('Zusammenfassung: ' + o.summary);
  lines.push('Kanal: ' + (ctx.channel || 'web') + (ctx.agent ? (' · Agent: ' + ctx.agent) : ''));
  if (Array.isArray(ctx.agentPath) && ctx.agentPath.length) lines.push('Agentenpfad: ' + ctx.agentPath.join(' → '));
  if (Array.isArray(ctx.attempted) && ctx.attempted.length) lines.push('Versuchte Aktionen: ' + ctx.attempted.map((a) => a.tool + ' (' + (a.status || '?') + ')').join(', '));
  if (o.pending) lines.push('Offener Vorschlag: ' + o.pending);
  return lines.join('\n');
}

async function create(ctx, o) {
  ctx = ctx || {}; o = o || {};
  const actor = ctx.actor || {};
  const reason = String(o.reason || 'Übergabe durch FINN').slice(0, 200);
  const subject = 'FINN-Übergabe: ' + reason.slice(0, 60);
  let v = null;
  const text = contextText(ctx, { reason: reason, summary: String(o.summary || '').slice(0, 600), pending: o.pending });
  if (actor.kind === 'member' && actor.id != null) {
    try {
      const Inbox = require('../inbox');
      v = await Inbox.addVorgang(actor.id, {
        type: TYPE_BY_AGENT[ctx.agent] || 'allgemein', subject: subject, status: 'bearbeitung', priority: o.priority || 'mittel',
        channel: ctx.channel === 'whatsapp' ? 'whatsapp' : 'portal', phone: ctx.phone || null,
        systemText: 'FINN hat dein Anliegen an das Team übergeben. Jemand meldet sich bei dir.',
        teamText: text, needsAction: true,
      });
    } catch (e) { v = null; }
    try {
      const SR = require('../studioReply'); const M = require('../members');
      let m = null; try { m = await M.getMember(actor.id); } catch (e) {}
      await SR.notifyStudio({ member: m || { id: actor.id }, vorgang: v || {}, subject: '🤝 ' + subject, text: text });
    } catch (e) {}
    await Timeline.add(actor.id, { kind: 'handoff', title: 'An Team übergeben: ' + reason, agent: ctx.agent, source: 'agent', traceId: ctx.traceId, ref: v ? v.ref : null });
  } else {
    try {
      const Mail = require('../mail');
      await Mail.sendMail('🤝 ' + subject + ' (' + (actor.kind || 'unbekannt') + ')', text + (o.contact ? ('\nKontakt: ' + String(o.contact).slice(0, 200)) : ''));
    } catch (e) {}
  }
  await Audit.record({ kind: 'handoff', status: 'handoff', tool: 'handoff_to_team', agent: ctx.agent, actor: actor, channel: ctx.channel, traceId: ctx.traceId, code: reason.slice(0, 40) });
  await Metrics.bump('finn.handoff');
  try { await require('../handled').record('team', actor.id, 'finn_handoff'); } catch (e) {}
  return { ok: true, ref: v ? v.ref : null, vorgangId: v ? v.id : null };
}

module.exports = { create, contextText };
