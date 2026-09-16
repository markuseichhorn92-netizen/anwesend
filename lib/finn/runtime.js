'use strict';

/**
 * FINN – Agent-Runtime (ein Lauf eines Agenten).
 * -----------------------------------------------------------------------------
 * Baut den System-Prompt (Marke, Antwortregeln, Agent, Live-Kontext, Wissen),
 * führt die Tool-Schleife (max. MAX_STEPS) über lib/finn/models -> lib/ai aus und
 * setzt dabei die Sicherheitsregeln durch:
 *   • Tools nur aus der Registry, nur die des Agenten, nur mit Capability
 *   • LOW läuft sofort; MEDIUM/HIGH erzeugt einen Bestätigungsvorschlag und
 *     beendet den Lauf – das Modell kann nichts „einfach machen"
 *   • Tool-Ergebnisse gehen als unvertrauenswürdige Daten zurück (hardenPayload)
 *   • Das Modell darf nie behaupten, etwas sei ausgeführt – die Runtime formuliert
 *     den Bestätigungs-/Ergebnistext selbst
 *
 * Ergebnis: { ok, text, link, confirm, handoff, agent, steps, toolsUsed, error }
 */

const Models = require('./models');
const Tools = require('./tools');
const Confirm = require('./confirm');
const Agents = require('./agents');
const Knowledge = require('./knowledge');
const ML = require('./magicline');
const U = require('./util');

const MAX_STEPS = 6;
const TOOL_RESULT_MAX = 3500;

const BRAND = [
  'Du bist FINN, der digitale Assistent von Fit-Inn Trier (Fitnessstudio, Auf Hirtenberg 8, 54296 Trier, Tel. 0651 308524, info@fit-inn-trier.de).',
  'Ton: freundlich, klar, auf Augenhöhe, „du". Kurze Absätze, keine Floskeln, höchstens ein Emoji.',
  'Sprache: Deutsch. Antworte so kurz wie möglich, aber vollständig; bei mehreren Optionen als nummerierte Liste.',
  'Ehrlichkeit: Erfinde keine Daten, Preise, Fristen oder Termine. Was du nicht über ein Werkzeug oder den Kontext weißt, sagst du offen – und bietest den Weg zum Team an.',
  'Live-Daten aus den Werkzeugen haben Vorrang vor der Wissensbasis.',
  'Aktionen: Rufe für Änderungen das passende Werkzeug auf. Das System zeigt der Person davor eine Bestätigung. Behaupte NIE, etwas sei erledigt oder gebucht – du schlägst vor, das System bestätigt und führt aus.',
  'Fehlt dir eine Angabe für ein Werkzeug, frage gezielt nach (eine Frage pro Nachricht).',
  'Wenn ein Werkzeug „forbidden" oder „unavailable" meldet: erkläre ohne Technik, dass das gerade nicht direkt geht, und biete die Übergabe ans Team an (handoff_to_team) – erfinde keinen anderen Weg.',
  'Gesundheitsangaben: Nur aufgreifen, wenn die Person sie selbst nennt; keine Diagnosen, keine Therapieempfehlung.',
  'App-Navigation: Wenn ein Bereich der App hilft, hänge GENAU EINEN Marker ans Ende: [[screen:ID]] mit ID aus: home, data, contract, account, appt, checkins, postfach, help, settings, card, referral, inbody, figur.',
].join('\n');

function liveBlock(ctx) {
  // Bereits vom Aufrufer geladen (api/member/coach.js liefert memberDetails) oder aus dem Tool-Layer.
  return (async () => {
    if (ctx.live) return ctx.live;
    if (!ctx.actor || ctx.actor.kind !== 'member') return '';
    if (!ML.mockOn()) {
      try { const Coach = require('../../api/member/coach'); const d = await Coach.memberDetails(ctx.actor.id); return d && d.text ? d.text : ''; } catch (e) { return ''; }
    }
    const lines = [];
    try { const c = await ML.contract.get(ctx.actor.id); if (c.ok) lines.push('Vertrag: Tarif ' + (c.data.rateName || '—') + ', Status ' + (c.data.cancelled ? 'gekündigt' : (c.data.active ? 'aktiv' : 'beendet')) + (c.data.nextCancellationDate ? (', nächstmögliche Kündigung zum ' + c.data.nextCancellationDate) : '')); } catch (e) {}
    try { const a = await ML.appointments.mine(ctx.actor.id); if (a.ok) lines.push('Nächste Termine: ' + (a.data.length ? a.data.slice(0, 3).map((x) => x.title + ' am ' + U.fmtDT(x.start)).join('; ') : 'keine gebucht')); } catch (e) {}
    return lines.join('\n');
  })();
}

async function buildSystem(ctx, agent, message) {
  const parts = [BRAND];
  const today = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' }).format(new Date());
  parts.push('Heute ist ' + today + '. Kanal: ' + (ctx.channel || 'web') + (ctx.channel === 'whatsapp' ? ' (kurze Nachrichten, keine Markdown-Tabellen).' : '.'));
  parts.push('DEIN BEREICH (' + agent.name + '): ' + agent.system);
  if (ctx.actor && ctx.actor.kind === 'member') {
    parts.push('Die Person ist ein serverseitig angemeldetes Mitglied' + (ctx.member && ctx.member.firstName ? (', Vorname ' + ctx.member.firstName) : '') + '. Alle Werkzeuge arbeiten automatisch mit dieser Person – frage nie nach Name oder Mitgliedsnummer.');
  } else if (ctx.actor && ctx.actor.kind === 'team') {
    parts.push('Du arbeitest für ein angemeldetes Teammitglied' + (ctx.customerId ? (' zum Kunden mit Id ' + ctx.customerId) : '') + '. Minimiere angezeigte Personendaten auf die Aufgabe.');
  } else {
    parts.push('Die Person ist nicht angemeldet (Website-Besucher). Du hast keinen Zugriff auf Mitgliedsdaten und fragst auch nicht danach.');
  }
  const live = await liveBlock(ctx);
  if (live) parts.push('LIVE-DATEN DER PERSON (aus Magicline, maßgeblich):\n' + live);
  if (ctx.memoryText) parts.push(ctx.memoryText);
  try { const k = await Knowledge.contextFor(message, 3); if (k) parts.push(k); } catch (e) {}
  return parts.join('\n\n');
}

function historyMessages(history) {
  const out = [];
  (Array.isArray(history) ? history : []).slice(-8).forEach((h) => {
    if (!h || !h.text) return;
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    // Zwei gleiche Rollen hintereinander zusammenziehen (API verlangt Wechsel).
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + String(h.text).slice(0, 1500);
    else out.push({ role: role, content: String(h.text).slice(0, 1500) });
  });
  if (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

function toolResultText(r) {
  if (!r) return JSON.stringify({ ok: false, error: 'unavailable' });
  const o = { ok: !!r.ok };
  if (r.ok) o.data = r.data; else { o.error = r.error || 'failed'; if (r.forbidden) o.hint = 'Recht fehlt – Übergabe ans Team anbieten'; if (r.detail) o.detail = r.detail; }
  return U.clip(JSON.stringify(o), TOOL_RESULT_MAX);
}

async function run(o) {
  const ctx = o.ctx, agent = Agents.get(o.agent) || Agents.get('concierge');
  ctx.agent = agent.key;
  ctx.agentPath = (ctx.agentPath || []).concat([agent.key]);
  ctx.attempted = ctx.attempted || [];
  const message = String(o.message || '').trim();
  const allowed = await Tools.toolsFor(ctx);
  const tools = allowed.filter((t) => agent.tools.indexOf(t.name) >= 0);
  const system = await buildSystem(ctx, agent, message);
  const messages = historyMessages(o.history);
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content += '\n' + message;
  else messages.push({ role: 'user', content: message });

  let text = '', link = null, handoff = null, confirm = null, steps = 0;
  const toolsUsed = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    steps++;
    const r = await Models.chat('chat', { system: system, messages: messages, tools: tools.length ? tools : undefined, securityScope: ctx.securityScope || 'member' });
    if (!r.ok) return { ok: false, error: r.error || 'ai_failed', agent: agent.key, steps: steps, toolsUsed: toolsUsed };
    const content = Array.isArray(r.content) ? r.content : [];
    const texts = content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();
    const uses = content.filter((b) => b.type === 'tool_use');
    if (texts) text = texts;
    if (!uses.length) break;

    messages.push({ role: 'assistant', content: content });
    const results = [];
    for (const tu of uses) {
      const res = await Tools.execute(ctx, tu.name, tu.input || {}, {});
      toolsUsed.push(tu.name);
      ctx.attempted.push({ tool: tu.name, status: res.needsConfirm ? 'vorgeschlagen' : (res.ok ? 'ok' : (res.forbidden ? 'kein Recht' : (res.error || 'fehler'))) });
      if (res.needsConfirm) {
        const p = await Confirm.propose(ctx, res.tool, res.args, res.preview, res.risk);
        if (!p.ok) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ ok: false, error: 'confirmation_unavailable', hint: 'Übergabe ans Team anbieten' }) });
          continue;
        }
        confirm = { id: p.id, preview: p.preview, risk: p.risk, tool: p.tool, expiresAt: p.expiresAt };
        break;
      }
      if (res.ok && res.data && res.data.handoff) handoff = { ref: res.data.ref || null };
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: toolResultText(res) });
    }
    if (confirm) break;
    messages.push({ role: 'user', content: results });
  }

  if (confirm) {
    // Der Bestätigungstext kommt von der Runtime, nicht vom Modell.
    const lead = text ? (text.replace(/\[\[\s*screen\s*:[^\]]*\]\]/gi, '').trim() + '\n\n') : '';
    text = lead + (confirm.risk === 'HIGH' ? 'Bitte bestätige ausdrücklich:\n' : 'Soll ich das so machen?\n') + '→ ' + confirm.preview;
  }
  try { const Coach = require('../../api/member/coach'); const p = Coach.extractLink(text); text = p.text; link = ctx.actor && ctx.actor.kind === 'member' ? p.link : null; } catch (e) { text = String(text).replace(/\[\[\s*screen\s*:[^\]]*\]\]/gi, '').trim(); }
  if (!text) text = confirm ? ('→ ' + confirm.preview) : (handoff ? 'Ich habe dein Anliegen ans Team übergeben – jemand meldet sich bei dir.' : U.safeMessage('failed'));
  return { ok: true, text: text, link: link, confirm: confirm, handoff: handoff, agent: agent.key, steps: steps, toolsUsed: toolsUsed };
}

module.exports = { run, buildSystem, historyMessages, BRAND, MAX_STEPS };
