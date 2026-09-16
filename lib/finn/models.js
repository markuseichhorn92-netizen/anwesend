'use strict';

/**
 * FINN – Provider-Abstraktion und Modell-Routing.
 * -----------------------------------------------------------------------------
 * Alle Agenten sprechen über `chat(task, payload)`. Darunter liegt der bestehende
 * Provider-Pfad lib/ai.messagesRaw (Bedrock EU-Profil + Guardrail je Scope,
 * Anthropic direkt nur außerhalb der Produktion). Es gibt bewusst KEINEN
 * Fallback auf einen guardrail-freien Pfad: schlägt der Provider fehl, gibt es
 * {ok:false} – der Orchestrator antwortet dann ehrlich und übergibt.
 *
 * Routing nach Aufgabe:
 *   route    – Intent-Klassifikation, kurz, günstig      -> MODEL
 *   chat     – Kundendialog mit Tools                     -> MODEL
 *   analysis – längere Auswertungen (Team, Retention)     -> MODEL_ANALYSIS
 *   plan     – strukturierte Planung                      -> MODEL_PLAN
 *
 * Retry: genau ein Wiederholungsversuch bei transienten Fehlern (429/5xx/Timeout),
 * nie bei Sicherheitsblocks.
 */

const AI = require('../ai');
const Metrics = require('./metrics');

const TASKS = { route: { maxTokens: 200, temperature: 0 }, chat: { maxTokens: 900, temperature: 0.2 }, analysis: { maxTokens: 1400, temperature: 0.2 }, plan: { maxTokens: 1400, temperature: 0.2 } };

function modelFor(task) {
  if (task === 'analysis') return AI.MODEL_ANALYSIS || AI.MODEL;
  if (task === 'plan') return AI.MODEL_PLAN || AI.MODEL;
  return AI.MODEL;
}
function available() { return !!AI.hasAI; }
function transient(r) {
  if (!r) return false;
  if (/guardrail|bedrock_required|no_ai|unsafe/i.test(String(r.error || ''))) return false;   // Konfiguration/Sicherheit – Wiederholen hilft nicht
  return r.status === 429 || (r.status >= 500 && r.status < 600) || /timeout|abort|ECONN|throttl/i.test(String(r.error || ''));
}

// payload: { system, messages, tools?, tool_choice?, securityScope, maxTokens?, temperature? }
async function chat(task, payload) {
  if (!available()) return { ok: false, error: 'no_ai' };
  const cfg = TASKS[task] || TASKS.chat;
  const req = Object.assign({ model: modelFor(task), maxTokens: cfg.maxTokens, temperature: cfg.temperature }, payload || {});
  let r = await AI.messagesRaw(req);
  if (!r.ok && transient(r) && !/unsafe/.test(String(r.error || ''))) { await Metrics.bump('finn.ai.retry'); r = await AI.messagesRaw(req); }
  if (!r.ok) await Metrics.bump('finn.error.ai');
  return r;
}

module.exports = { chat, modelFor, available, TASKS, transient };
