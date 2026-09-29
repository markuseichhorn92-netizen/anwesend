'use strict';

/**
 * FINN Journeys – Sende-Pipeline. Trägt den Automatik-Modus: jede Regel hier ist
 * eine harte Sperre, keine Empfehlung.
 * -----------------------------------------------------------------------------
 * send(st, { journey, step, tpl, vars, buttons? }, now)
 *   -> { status:'sent'|'dry'|'deferred'|'skipped'|'failed', reason?, retryAt?, via?, id? }
 *
 * Reihenfolge:
 *   1. Hauptschalter, Nummer vorhanden/gültig
 *   2. Sperrliste (STOP) und Einwilligung passend zur Kategorie der Vorlage
 *   3. Sperren: gekündigt, offener Kündigungs-/Widerrufs-/Beschwerde-Vorgang,
 *      Übergabe ans Team < 7 Tage, Zahlungsproblem < 30 Tage (nur Motivation),
 *      minderjährig (nur Motivation), Tag „kein Kontakt"
 *   4. Ruhezeiten (verschieben)
 *   5. Kappen: Motivation 1/Tag, 2/7 Tage, 4/28 Tage (inkl. Push-Anstoß);
 *      Service 3/Tag (verschieben)
 *   6. Fenster offen -> normale Nachricht (kostenlos, mit Knöpfen);
 *      zu -> freigegebene Vorlage; keine Vorlage -> überspringen („no_template")
 *   7. Probelauf (JOURNEYS_MODE≠auto oder Nummer nicht auf der Testliste) -> jr:dry
 *   8. Versand, Eintrag im WhatsApp-Vorgang, Zustellstatus verfolgen, Kennzahlen
 * Keine Nachrichteninhalte in Logs – nur Journey, Schritt, Weg, Ergebnis.
 */

const KV = require('../finn/kv');
const Phone = require('../phone');
const Config = require('./config');
const Consent = require('./consent');
const Window = require('./window');
const Quiet = require('./quiet');
const Templates = require('./templates');
const KPI = require('./kpi');

const DAY = 86400000;
const CAPS = { marketing: { day: 1, week: 2, month: 4 }, invite: { day: 1, week: 2, month: 4 }, service: { day: 3 } };
const BLOCK_TYPES = { kuendigung: 1, widerruf: 1 };
const OUT_TTL = 7 * 86400;
const DRY_CAP = 300;

function varsObj(v) { return Array.isArray(v) ? v.reduce((o, x, i) => { o[i + 1] = x; return o; }, {}) : Object.assign({}, v || {}); }
function log(o) { try { console.log('[journeys]', JSON.stringify(o)); } catch (e) {} }

function sentOf(st, cats) { return (Array.isArray(st.sent) ? st.sent : []).filter((x) => x && x.at && cats.indexOf(x.cat) >= 0 && x.via !== 'dry'); }

// Kappen: Rückgabe = frühester erlaubter Zeitpunkt (ms) oder null, wenn jetzt ok.
async function capRetry(st, cat, now) {
  const c = CAPS[cat] || CAPS.marketing;
  if (cat === 'service') {
    const today = sentOf(st, ['service']).filter((x) => Quiet.sameDay(x.at, now));
    return today.length >= c.day ? Quiet.nextDayStart(now) : null;
  }
  const list = sentOf(st, ['marketing', 'invite']);
  let extra = 0;
  // Push-Anstoß (lib/nudge.js) zählt als Kontakt dieser Woche.
  if (st.cid) { try { if ((await KV.get('nudge:sent:' + st.cid)) != null) extra = 1; } catch (e) {} }
  if (list.some((x) => Quiet.sameDay(x.at, now))) return Quiet.nextDayStart(now);
  const w = list.filter((x) => now - x.at < 7 * DAY).sort((a, b) => a.at - b.at);
  if (w.length + extra >= c.week) return w.length ? w[0].at + 7 * DAY : now + 7 * DAY;
  const m = list.filter((x) => now - x.at < 28 * DAY).sort((a, b) => a.at - b.at);
  if (m.length + extra >= c.month) return m.length ? m[0].at + 28 * DAY : now + 7 * DAY;
  return null;
}

async function blocked(st, cat, now) {
  const f = st.facts || {};
  if (f.invalidPhone) return 'invalid_phone';
  if (f.cancelled && st.kind === 'member') return 'cancelled';
  if (f.handoffAt && now - f.handoffAt < 7 * DAY) return 'handoff';
  if (cat !== 'service') {
    if (f.paymentIssueAt && now - f.paymentIssueAt < 30 * DAY) return 'payment';
    if (f.minor) return 'minor';
  }
  if (st.cid && /^[0-9]{1,12}$/.test(String(st.cid))) {
    try {
      const Tags = require('../tags');
      const tags = (await Tags.getTags(st.cid)).map((t) => String(t).toLowerCase());
      if (tags.some((t) => /kein\s*kontakt/.test(t))) return 'tag_no_contact';
    } catch (e) {}
    try {
      const Inbox = require('../inbox');
      const list = await Inbox.list(st.cid);
      if ((list || []).some((v) => v && BLOCK_TYPES[v.type] && v.status !== 'abgeschlossen')) return 'open_case';
    } catch (e) {}
  }
  return null;
}

// Offenen WhatsApp-Vorgang finden oder still anlegen (kein Team-Alarm).
async function inboxFor(st, phone) {
  const Inbox = require('../inbox');
  const m = st.inbox || st.cid || ('wa' + phone);
  let list = [];
  try { list = await Inbox.list(m); } catch (e) {}
  let v = (list || []).find((x) => x.channel === 'whatsapp' && x.status !== 'abgeschlossen') || null;
  if (!v) {
    const name = st.firstName || '';
    v = await Inbox.addVorgang(m, {
      type: 'whatsapp', channel: 'whatsapp', phone: phone,
      member: { name: name || ('+' + phone), nr: null, initials: (name ? name[0] : 'W').toUpperCase(), phone: phone, lead: st.kind === 'lead' || undefined },
      subject: 'WhatsApp' + (name ? (' · ' + name) : ''), systemText: 'WhatsApp-Verlauf (FINN-Journeys).',
      notifyTeam: false, teamUnread: false, teamStatus: 'wartet', status: 'beantwortet',
    });
  }
  return v ? { m: String(m), v: v } : null;
}
// Nachricht als Team-Bubble „FINN · Journey" ablegen – ohne Push ans Mitglied
// (es hat sie ja gerade per WhatsApp bekommen) und ohne Team-Alarm.
async function logToInbox(st, phone, text, journey, providerId) {
  try {
    const Inbox = require('../inbox');
    const box = await inboxFor(st, phone);
    if (!box) return;
    const v = await Inbox.get(box.m, box.v.id) || box.v;
    const at = Date.now();
    v.messages = v.messages || [];
    v.messages.push({ from: 'team', text: String(text || '').slice(0, 4000), at: at, author: 'FINN · Journey', ch: 'whatsapp', st: 'sent', jr: String(journey || '') });
    v.updatedAt = at;
    await Inbox.save(box.m, v);
    if (providerId) { try { await require('../receipts').track(providerId, { m: box.m, v: v.id, at: at }); } catch (e) {} }
  } catch (e) {}
}

function isDryFor(phone) {
  if (Config.mode() !== 'auto') return true;
  const tn = Config.testNumbers();
  return tn.length > 0 && tn.indexOf(phone) < 0;
}

async function recordSent(st, phone, o, via, id, now, cat) {
  st.sent = (st.sent || []).concat([{ at: now, j: o.journey, s: o.step, cat: cat, via: via }]);
  if (id) await KV.set('jr:out:' + id, { subj: st.subj, j: o.journey, s: o.step, via: via, p: phone, at: now }, OUT_TTL);
  try { await require('./inbound').noteSent(phone, o.journey, o.step); } catch (e) {}
}

async function send(st, o, now) {
  now = now || Date.now();
  o = o || {};
  const tpl = Templates.get(o.tpl);
  if (!tpl) return { status: 'skipped', reason: 'unknown_template' };
  const cat = tpl.consent;                        // service | marketing | invite
  const J = o.journey || tpl.journey;
  if (!Config.on()) return { status: 'skipped', reason: 'off' };
  const phone = Phone.canon(st && st.phone);
  if (!phone) return { status: 'skipped', reason: 'no_phone' };

  // 2. STOP + Einwilligung
  const con = await Consent.get(phone);
  if (con.suppressed) return { status: 'skipped', reason: 'stop' };
  if (cat === 'invite') {
    if (con.marketing) return { status: 'skipped', reason: 'already_consented' };
    if ((await KV.get('jr:inv:' + phone)) != null) return { status: 'skipped', reason: 'already_invited' };
  } else if (cat === 'marketing' ? !con.marketing : !con.service) {
    return { status: 'skipped', reason: 'no_consent' };
  }
  // 3. Sperren
  const b = await blocked(st, cat, now);
  if (b) return { status: 'skipped', reason: b };
  // 4. Ruhezeiten
  if (!Quiet.allowed(now, cat)) return { status: 'deferred', reason: 'quiet', retryAt: Quiet.nextAllowed(now, cat) };
  // 5. Kappen
  const capAt = await capRetry(st, cat, now);
  if (capAt) return { status: 'deferred', reason: 'cap', retryAt: Quiet.nextAllowed(capAt, cat) };
  // 6. Weg wählen
  const text = Templates.render(o.tpl, o.vars);
  const open = await Window.isOpen(phone, now);
  const cfg = await Config.load();
  const tc = (cfg.templates || {})[o.tpl] || {};
  let WA = null; try { WA = require('../whatsapp'); } catch (e) {}
  // Twilio: nur eine von Meta freigegebene (oder von Hand zugeordnete) Vorlage.
  const canTpl = !!(WA && ((WA.hasTwilio && Templates.sidUsable(tc)) || (!WA.hasTwilio && WA.hasMeta && tc.meta)));
  let via = open ? 'session' : (canTpl ? 'template' : null);
  if (!via) { await KPI.bump(J, 'no_template', now); return { status: 'skipped', reason: 'no_template' }; }

  // 7. Probelauf
  if (isDryFor(phone) || !(WA && WA.hasWhatsApp)) {
    // Vorschau ohne Namen: der Vorname wird durch einen Platzhalter ersetzt.
    const preview = Templates.render(o.tpl, Object.assign({}, varsObj(o.vars), { 1: '{Vorname}' }));
    await KV.lpush('jr:dry', { at: now, j: J, s: o.step, tpl: o.tpl, via: via, cat: cat, subj: st.kind === 'lead' ? 'lead' : 'member', text: preview.slice(0, 400) }, DRY_CAP, 14 * 86400);
    await recordSent(st, phone, { journey: J, step: o.step }, 'dry', null, now, cat);
    await KPI.bump(J, 'dry', now);
    log({ ev: 'dry', j: J, s: o.step, via: via });
    return { status: 'dry', via: via };
  }

  // 8. Versand
  let r = null;
  try {
    if (via === 'session') {
      const btn = (o.buttons || tpl.buttons || []).filter(Boolean);
      if (btn.length >= 2 && WA.hasWaButtons) {
        r = await WA.sendButtons(phone, { body: text, options: btn.slice(0, 3).map((t, i) => ({ id: 'jr:' + J + ':' + o.step + ':' + i, title: t })) });
        if (!r || r.ok === false) r = await WA.sendText(phone, text + '\n\n' + btn.slice(0, 3).map((t, i) => (i + 1) + ') ' + t).join('\n'));
      } else {
        r = await WA.sendText(phone, btn.length >= 2 ? (text + '\n\n' + btn.slice(0, 3).map((t, i) => (i + 1) + ') ' + t).join('\n')) : text);
      }
    } else if (WA.hasTwilio) {
      r = await WA.twilioSendTemplate(phone, tc.sid, Templates.twilioVars(o.tpl, o.vars));
    } else {
      const v = Templates.twilioVars(o.tpl, o.vars);
      r = await WA.sendTemplate(phone, tc.meta, tc.lang || 'de', Object.keys(v).sort((a, b) => a - b).map((k) => v[k]));
    }
  } catch (e) { r = { ok: false, error: 'exception' }; }

  if (!r || r.ok === false) {
    await KPI.bump(J, 'failed', now);
    log({ ev: 'fail', j: J, s: o.step, via: via, st: r && r.status ? r.status : null });
    try { await require('./sendlog').add({ at: now, subj: st.subj, j: J, s: o.step, tpl: o.tpl, via: via, cat: cat, phone: phone, err: 'provider' + (r && r.status ? '_' + r.status : '') }); } catch (e) {}
    const transient = !r || !r.status || r.status === 429 || r.status >= 500;
    return transient ? { status: 'deferred', reason: 'provider', retryAt: now + 30 * 60 * 1000 } : { status: 'failed', reason: 'provider' };
  }
  await recordSent(st, phone, { journey: J, step: o.step }, via, r.id || null, now, cat);
  if (cat === 'invite') await KV.set('jr:inv:' + phone, String(now), 3 * 365 * 86400);
  await logToInbox(st, phone, text, J, r.id || null);
  try { await require('./sendlog').add({ at: now, subj: st.subj, j: J, s: o.step, tpl: o.tpl, via: via, cat: cat, id: r.id || null, phone: phone }); } catch (e) {}
  await KPI.bump(J, 'sent', now); await KPI.bump(J, cat === 'service' ? 'sent_service' : 'sent_marketing', now);
  log({ ev: 'sent', j: J, s: o.step, via: via, cat: cat });
  return { status: 'sent', via: via, id: r.id || null };
}

async function dryLog(n) { return KV.lrangeJSON('jr:dry', 0, Math.max(1, Math.min(300, n || 50)) - 1); }

module.exports = { send, capRetry, blocked, dryLog, CAPS, isDryFor, inboxFor };
