'use strict';

/**
 * FINN Journeys – eingehende WhatsApp-Nachricht, VOR jedem anderen Routing.
 * -----------------------------------------------------------------------------
 * Läuft in beiden Webhooks (Meta + Twilio) für jede Nachricht – unabhängig von
 * JOURNEYS=1, denn das 24-h-Fenster und STOP gelten für alle Wege:
 *
 *   1. 24-h-Fenster merken (jr:win)
 *   2. Schlüsselwörter, die nicht an die KI gehen:
 *        STOP / STOPP / ABMELDEN      -> Abmeldung (beide Einwilligungen, Sperrliste)
 *        START                        -> Wieder-Anmeldung
 *        START <CODE>                 -> Opt-in aus der App/Mail: Nummer beweist sich selbst
 *        JA / NEIN auf eine offene Frage (jr:ask) -> Einwilligung ja/nein
 *   3. Antwort auf eine Journey-Nachricht zählen (KPI „replied")
 *
 * Rückgabe { consumed:boolean, kind }. consumed = true -> der Webhook reicht die
 * Nachricht NICHT an KI/Team-Routing weiter (sie wird nur still protokolliert).
 * Wirft nie.
 */

const KV = require('../finn/kv');
const Phone = require('../phone');
const Window = require('./window');
const Consent = require('./consent');
const Store = require('./store');
const Config = require('./config');
const KPI = require('./kpi');

const STOP_RE = /^\s*(?:stop+|stopp|abmelden|abbestellen|abmeldung|unsubscribe|keine\s+nachrichten(?:\s+mehr)?)\s*[.!]*\s*$/i;
const START_RE = /^\s*(?:start|anmelden|wieder\s+anmelden)\s*[.!]*\s*$/i;
const CODE_RE = /^\s*start\s+([A-Za-z0-9]{6,8})\s*[.!]*\s*$/i;
const YES_RE = /^\s*(?:ja|jo|jap|yes|gern|gerne|ja,?\s*gerne?|ja,?\s*bitte|ja\s*klar|klar|ok|okay|passt|👍)\s*[.!]*\s*$/i;
const NO_RE = /^\s*(?:nein|ne|nö|no|nein,?\s*danke|lieber\s*nicht|kein\s*interesse)\s*[.!]*\s*$/i;

const ASK_TTL = 14 * 86400;
const CODE_TTL_DEFAULT = 30 * 60;
const LAST_WINDOW = 72 * 3600 * 1000;

const TXT = {
  stop: 'Alles klar – du bekommst von Fit-Inn keine automatischen WhatsApp-Nachrichten mehr (keine Erinnerungen, keine Tipps). Wenn du uns schreibst, antworten wir dir natürlich weiterhin. Mit „START" meldest du dich jederzeit wieder an.',
  start: 'Schön, dass du wieder dabei bist! 🙌 Du bekommst wieder Terminerinnerungen und ab und zu Motivation und Tipps von uns – höchstens zwei Nachrichten pro Woche. Abmelden geht jederzeit mit „STOP".',
  codeBoth: 'Danke{name}! 🙌 Deine Nummer ist jetzt mit deinem Fit-Inn-Konto verbunden. Du bekommst Terminerinnerungen und ab und zu Motivation und Tipps – höchstens zwei Nachrichten pro Woche. Abmelden geht jederzeit mit „STOP".',
  codeService: 'Danke{name}! 🙌 Deine Nummer ist jetzt mit deinem Fit-Inn-Konto verbunden. Wir erinnern dich hier an deine Termine. Abmelden geht jederzeit mit „STOP".',
  codeBad: 'Dieser Code ist leider abgelaufen. Öffne in der Fit-Inn-App noch einmal „WhatsApp verbinden" – dann bekommst du einen neuen.',
  yes: 'Super, danke! 💪 Dann melde ich mich hier ab und zu mit Motivation und Tipps – höchstens zwei Nachrichten pro Woche. Abmelden geht jederzeit mit „STOP".',
  yesService: 'Super, danke! Dann erinnere ich dich hier an deine Termine. Abmelden geht jederzeit mit „STOP".',
  no: 'Alles klar, dann schreibe ich dir nur, wenn es um deine Termine geht. 👍',
};

function firstNameOf(n) { const f = String(n || '').trim().split(/\s+/)[0] || ''; return /^[A-Za-zÄÖÜäöüß'’-]{2,20}$/.test(f) ? f : ''; }

async function sendReply(phone, text) {
  try { const WA = require('../whatsapp'); if (!WA.hasWhatsApp) return null; const r = await WA.sendText(phone, text); return r && r.ok !== false ? r : null; } catch (e) { return null; }
}
async function logSilently(o, text, note) {
  if (!o.memberId || !o.vorgangId) return;
  try {
    const Inbox = require('../inbox');
    await Inbox.reply(o.memberId, o.vorgangId, String(o.text || ''), null, { notifyTeam: false });
    if (note) await Inbox.addNote(o.memberId, o.vorgangId, { author: 'FINN', text: note + (text ? ('\n\nAutomatische Antwort: ' + text) : '') });
  } catch (e) {}
}
// Offene FINN-Bestätigung dieses WhatsApp-Gesprächs verwerfen (STOP gewinnt).
async function dropPending(o) {
  if (!o.vorgangId) return;
  try { const Memory = require('../finn/memory'); await Memory.set('whatsapp', 'wa:' + o.vorgangId, { pending: null }); } catch (e) {}
}

// ── Opt-in-Codes (START <CODE>) ──
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { const b = require('node:crypto').randomBytes(6); let s = ''; for (let i = 0; i < 6; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length]; return s; }
// cid = Kunden-Id aus einer geprüften Sitzung; types = ['service'] | ['service','marketing'].
async function createCode(cid, types, ttlSec, src) {
  if (!Store.isMemberId(cid)) return null;
  const t = (Array.isArray(types) ? types : []).filter((x) => Consent.TYPES.indexOf(x) >= 0);
  if (!t.length) return null;
  const code = newCode();
  const ok = await KV.set('jr:code:' + code, { cid: String(cid), types: t, src: String(src || 'app').slice(0, 20), at: Date.now() }, ttlSec || CODE_TTL_DEFAULT);
  return ok ? code : null;
}
function waLink(code) {
  const num = Phone.canon(process.env.WA_PUBLIC_NUMBER || process.env.TWILIO_WHATSAPP_FROM || '');
  return num ? ('https://wa.me/' + num + '?text=' + encodeURIComponent('START ' + code)) : null;
}

// ── Offene Frage (Einladung, Lead-Agent) ──
async function ask(phone, types, src, subj) {
  const p = Phone.canon(phone); if (!p) return false;
  return !!(await KV.set('jr:ask:' + p, { types: types, src: String(src || 'ask').slice(0, 20), subj: subj || null, at: Date.now() }, ASK_TTL));
}
async function pendingAsk(phone) { const p = Phone.canon(phone); return p ? KV.getJSON('jr:ask:' + p) : null; }

// Nach einer Journey-Nachricht: wer antwortet binnen 72 h, zählt als „replied".
async function noteSent(phone, journey, step) {
  const p = Phone.canon(phone); if (!p) return;
  await KV.set('jr:last:' + p, { j: journey, s: step, at: Date.now() }, 7 * 86400);
}

async function onInbound(o) {
  o = o || {};
  const p = Phone.canon(o.phone);
  if (!p) return { consumed: false };
  try { await Window.touch(p); } catch (e) {}
  const text = String(o.text || '').trim();
  const cid = Store.isMemberId(o.memberId) ? String(o.memberId) : null;

  try {
    // 1) STOP – immer, egal ob Journeys laufen.
    if (STOP_RE.test(text)) {
      await Consent.withdraw(p, null, { src: 'whatsapp_stop', cid: cid });
      await Consent.suppress(p);
      await KV.del('jr:ask:' + p);
      await dropPending(o);
      await KPI.bump('all', 'optout');
      const r = await sendReply(p, TXT.stop);
      await logSilently(o, r ? TXT.stop : null, 'Per WhatsApp abgemeldet (STOP): keine automatischen Nachrichten mehr.');
      return { consumed: true, kind: 'stop' };
    }
    // 2) START <CODE> – Opt-in aus der App/Mail, bindet die Nummer an das Konto.
    const cm = text.match(CODE_RE);
    if (cm) {
      const code = cm[1].toUpperCase();
      const rec = await KV.getJSON('jr:code:' + code);
      if (!rec || !rec.cid) { const r = await sendReply(p, TXT.codeBad); await logSilently(o, r ? TXT.codeBad : null, 'Opt-in-Code unbekannt oder abgelaufen.'); return { consumed: true, kind: 'code_bad' }; }
      await KV.del('jr:code:' + code);
      await Consent.grant(p, rec.types, { src: 'code_' + (rec.src || 'app'), cid: rec.cid });
      try { await require('../leadflow').linkPhone(p, { id: rec.cid, name: o.name || null, nr: null }); } catch (e) {}
      await Store.linkPhone(p, rec.cid);
      const st = await Store.loadOrCreate(rec.cid);
      if (st) { st.phone = p; if (!st.firstName) st.firstName = firstNameOf(o.name) || null; await Store.save(st); }
      await KPI.bump('all', 'optin');
      const name = st && st.firstName ? (', ' + st.firstName) : '';
      const msg = (rec.types.indexOf('marketing') >= 0 ? TXT.codeBoth : TXT.codeService).replace('{name}', name);
      const r = await sendReply(p, msg);
      await logSilently(o, r ? msg : null, 'WhatsApp verbunden (Opt-in per Code aus ' + (rec.src || 'App') + ').');
      return { consumed: true, kind: 'code', cid: rec.cid };
    }
    // 3) START – Wieder-Anmeldung.
    if (START_RE.test(text)) {
      await Consent.grant(p, ['service', 'marketing'], { src: 'whatsapp_start', cid: cid });
      await KPI.bump('all', 'optin');
      const r = await sendReply(p, TXT.start);
      await logSilently(o, r ? TXT.start : null, 'Per WhatsApp wieder angemeldet (START).');
      return { consumed: true, kind: 'start' };
    }
    // 4) Ja/Nein auf eine offene Frage.
    const pend = await pendingAsk(p);
    if (pend && (YES_RE.test(text) || NO_RE.test(text))) {
      await KV.del('jr:ask:' + p);
      if (YES_RE.test(text)) {
        await Consent.grant(p, pend.types || ['marketing'], { src: 'ask_' + (pend.src || 'ja'), cid: cid });
        await KPI.bump(pend.src === 'invite' ? 'invite' : 'all', 'optin');
        const msg = (pend.types || []).indexOf('marketing') >= 0 ? TXT.yes : TXT.yesService;
        const r = await sendReply(p, msg);
        await logSilently(o, r ? msg : null, 'Einwilligung per WhatsApp erteilt (' + (pend.types || []).join(', ') + ').');
        return { consumed: true, kind: 'optin' };
      }
      const r = await sendReply(p, TXT.no);
      await logSilently(o, r ? TXT.no : null, 'Einladung zu WhatsApp-Tipps abgelehnt.');
      return { consumed: true, kind: 'optin_no' };
    }
    // 5) Antwort auf eine Journey-Nachricht zählen (einmal je Sendung).
    const last = await KV.getJSON('jr:last:' + p);
    if (last && last.j && !last.counted && Date.now() - (last.at || 0) < LAST_WINDOW) {
      last.counted = true; await KV.set('jr:last:' + p, last, 7 * 86400);
      await KPI.bump(last.j, 'replied');
    }
    // 6) Bekanntes Mitglied: Nummer merken (für Journeys), sobald Journeys laufen.
    // Nur wenn die Nummer noch niemandem gehört: auch Magicline-LEADS haben eine numerische
    // Kunden-Id – ein laufendes Interessenten-Gespräch darf dadurch nicht zum Mitglied werden.
    if (cid && Config.tracking() && !(await Store.forPhone(p))) { await Store.linkPhone(p, cid); }
  } catch (e) { /* nie den Webhook stören */ }
  return { consumed: false };
}

module.exports = { onInbound, createCode, waLink, ask, pendingAsk, noteSent, STOP_RE, START_RE, CODE_RE, YES_RE, NO_RE, TXT };
