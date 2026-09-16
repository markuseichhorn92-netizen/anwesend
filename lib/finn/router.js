'use strict';

/**
 * FINN – Intent-Erkennung / Routing.
 * -----------------------------------------------------------------------------
 * Regelbasiert und deterministisch (testbar, kostenlos). Reihenfolge:
 *   1. Eskalation (Beschwerde, Recht, Notfall, Geldstreit, Wunsch nach Mensch) -> handoff
 *   2. Fachliche Muster (Vertrag, Zahlung, Termin, Zugang, Dokument, Stammdaten, Studio, Support, Lead)
 *   3. Kontext: bleibt beim letzten Agenten, wenn die Nachricht eine kurze Folge-
 *      antwort ist („ja", „2", „morgen 10 Uhr") und kein neues Thema erkennbar ist
 *   4. Standard: concierge (Mitglied/Team) bzw. lead (Website)
 * Optional (FINN_LLM_ROUTER=1): bei niedriger Sicherheit fragt ein kleines
 * Modell mit erzwungenem Tool-Aufruf nach – ohne Tools, ohne Kundendaten.
 *
 * Kündigen ist KEINE Eskalation: das erledigt der Vertragsagent mit Bestätigung
 * (im WhatsApp-Bestand lief das bisher an einen Menschen; der Orchestrator kann
 * das je Kanal weiter so halten, siehe channels.js).
 */

const Agents = require('./agents');

const ESCALATE = [
  /beschwer/i, /unzufrieden/i, /anwalt/i, /\bklage\b/i, /verklag/i, /betrug/i, /abzock/i,
  /r[uü]ck(erstatt|zahl)/i, /geld\s*zur[uü]ck/i, /inkasso/i, /(doppelt|zu\s*viel|falsch)\s*(abgebucht|abgezogen)/i,
  /todesfall/i, /verstorben/i, /\bunfall/i, /notfall/i, /suizid/i, /selbstmord/i,
  /(mitarbeiter|mensch(en)?|kollege|kollegin|jemand(en)?)\s*(sprechen|reden|erreichen)/i,
  /(ruf|ruft|rufen)\s+mich\b/i, /r[uü]ckruf/i, /zur[uü]ckrufen/i, /pers[oö]nlich\s*sprechen/i, /echte[rn]?\s+mensch/i,
];

const RULES = [
  { agent: 'retention', re: /(überleg|ueberleg|denk).{0,30}k[uü]ndig|zu\s*teuer|lohnt\s*sich\s*nicht|bin\s*lange\s*nicht|keine\s*zeit\s*mehr|motivation|nicht\s*mehr\s*(hin|kommen)/i, actors: ['member'] },
  { agent: 'contract', re: /k[uü]ndig|widerruf|beitragspause|pausier|\bpause\b|vertrag|laufzeit|zusatzmodul|\bmodul|tarif|mitgliedschaft|verl[aä]nger|frist/i },
  { agent: 'payment', re: /\biban\b|bankverbindung|bank\b|lastschrift|\bsepa\b|beitragskonto|beitr[aä]ge?\b|zahlung|abgebucht|abbuchung|mahnung|offene[rn]?\s*(betrag|posten)|saldo|rechnung(?!skopie)|kontonummer|bezahl/i },
  { agent: 'appointment', re: /termin|buch(en|ung)|stornier|absagen|umbuch|verschieb|slot|stoffwechsel|einf[uü]hrungstraining|einweisung|trainingsplanung|beratung/i },
  { agent: 'access', re: /\bchip\b|karte\b|\bband\b|zugang|eingang|drehkreuz|einchecken|check-?in|gesperrt|verloren|t[uü]r\b|reinkommen/i },
  { agent: 'document', re: /dokument|vertragskopie|unterlagen|bescheinigung|nachweis|\bpdf\b|rechnungskopie|attest|teilnahmebest/i },
  { agent: 'member', re: /adresse|umgezogen|umzug|e-?mail|telefon(nummer)?|handynummer|daten\s*(ändern|aendern|aktualisieren)|newsletter|werbung|einwilligung|geburtsdatum|name\s*(ändern|aendern)/i },
  { agent: 'studio', re: /öffnungszeit|oeffnungszeit|geöffnet|geoeffnet|\boffen\b|wann\s*habt|auslastung|\bvoll\b|wie\s*viele\s*(leute|personen)|feiertag|kurs|sauna|parkplatz|parken|anfahrt|wo\s*seid\s*ihr|dusch/i },
  { agent: 'support', re: /\bapp\b|login|anmeld|einlog|passwort|code\s*(kommt|bekomm)|fehler|geht\s*nicht|funktioniert\s*nicht|absturz|st[uü]rzt|problem|face\s*id|bug/i },
  { agent: 'lead', re: /probetraining|interessier|mitglied\s*werden|preise|kosten|was\s*kostet|angebot|anmelden\s*(als|bei)|neu\s*hier/i, actors: ['lead', 'member', 'team'] },
];

const FOLLOWUP = /^\s*(ja|jo|jep|jap|nein|ne|nö|ok|okay|passt|gerne|gern|bitte|danke|stimmt|genau|richtig|klar|[0-9]{1,2}|[0-9]{1,2}[.:][0-9]{2}(\s*uhr)?|morgen|übermorgen|heute|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b[\s\S]{0,40}$/i;

function ruleMatch(text, actorKind) {
  for (const r of RULES) {
    if (r.actors && r.actors.indexOf(actorKind) < 0) continue;
    if (r.re.test(text)) return r.agent;
  }
  return null;
}

// -> { agent, confidence:'high'|'medium'|'low', escalate:boolean, reason }
function route(text, ctx, memo) {
  text = String(text || '');
  const kind = (ctx && ctx.actor && ctx.actor.kind) || 'member';
  const last = memo && memo.agent && Agents.get(memo.agent) ? memo.agent : null;
  if (ESCALATE.some((re) => re.test(text))) return { agent: 'handoff', confidence: 'high', escalate: true, reason: 'sensitive' };
  const hit = ruleMatch(text, kind);
  if (hit) {
    const a = Agents.get(hit);
    if (a && a.actors.indexOf(kind) >= 0) return { agent: hit, confidence: 'high', escalate: false, reason: 'rule' };
  }
  if (last && (FOLLOWUP.test(text) || text.length < 25)) return { agent: last, confidence: 'medium', escalate: false, reason: 'followup' };
  if (last && (memo && memo.pending)) return { agent: last, confidence: 'medium', escalate: false, reason: 'pending' };
  const def = kind === 'lead' ? 'lead' : 'concierge';
  return { agent: def, confidence: 'low', escalate: false, reason: 'default' };
}

// Optionaler Modell-Router bei niedriger Sicherheit (nur Agentennamen, keine Kundendaten).
async function routeWithModel(text, ctx, memo) {
  const base = route(text, ctx, memo);
  if (base.confidence !== 'low' || process.env.FINN_LLM_ROUTER !== '1') return base;
  try {
    const Models = require('./models');
    const kind = (ctx && ctx.actor && ctx.actor.kind) || 'member';
    const keys = Agents.forActor(kind).map((a) => a.key);
    const r = await Models.chat('route', {
      system: 'Ordne die Nachricht genau einem Agenten zu. Antworte nur über das Tool.',
      messages: [{ role: 'user', content: 'Agenten: ' + Agents.forActor(kind).map((a) => a.key + ' = ' + a.purpose).join('; ') + '\n\nNachricht:\n' + text.slice(0, 600) }],
      tools: [{ name: 'route', description: 'Agent wählen', input_schema: { type: 'object', properties: { agent: { type: 'string', enum: keys } }, required: ['agent'] } }],
      tool_choice: { type: 'tool', name: 'route' },
      securityScope: ctx && ctx.securityScope,
    });
    const tu = r.ok && (r.content || []).find((b) => b.type === 'tool_use');
    if (tu && tu.input && keys.indexOf(tu.input.agent) >= 0) return { agent: tu.input.agent, confidence: 'medium', escalate: false, reason: 'model' };
  } catch (e) {}
  return base;
}

module.exports = { route, routeWithModel, ESCALATE, RULES, FOLLOWUP };
