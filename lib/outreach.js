'use strict';

/**
 * Rundnachricht (Broadcast) + Direktnachricht fürs Team-Backend.
 * ------------------------------------------------------------------
 * Das Team kann eine Push-/E-Mail-Nachricht an ein Segment senden oder einem
 * einzelnen Mitglied direkt schreiben. Alles best-effort und 403-/fehlersicher
 * (wirft NIE), respektiert Einwilligung + Anti-Spam.
 *
 * Enumerations-Realität: Ohne den Magicline-Scope MEMBER_LIST_READ (bewusst
 * nicht angefragt) gibt es KEIN vollständiges Mitglieder-Verzeichnis. Der
 * Empfänger-Pool ist deshalb die Vereinigung aus
 *   (a) App-Nutzern mit Push  -> Push.allPushMembers()
 *   (b) Mitgliedern mit Vorgängen -> Inbox.listAll()
 * dedupliziert. Segmente werden aus diesem Pool klassifiziert (außer 'app',
 * das direkt der Push-Liste entspricht).
 *
 * Graceful Degradation:
 *   - Push nur über Push.notifyMember(id,'pushNews'|'pushPostfach', …) – das
 *     respektiert die Einwilligung des Mitglieds und „schläft" ohne Push-Setup.
 *   - E-Mail nur an Mitglieder mit hinterlegter Adresse (Mail „schläft" ohne Key).
 *   - Die Sende-Menge ist auf CAP (500) Empfänger begrenzt; ist die Menge
 *     gekappt, meldet das Ergebnis capped:true.
 */

const Push = require('./push');
const Inbox = require('./inbox');
const M = require('./members');
const Mail = require('./mail');
const WA = require('./whatsapp');
const { renderEmail } = require('./emailTemplate');
const Magic = require('./magic');
const Churn = require('./churn');
const Receipts = require('./receipts');

const CAP = 500;            // max. Empfänger je Rundnachricht (Anti-Spam / Kostenbremse)
const POOL_CAP = 1200;      // max. zu klassifizierende Kandidaten (Magicline-Reads begrenzen)
const CLASSIFY_SLICE = 6;   // begrenzte Nebenläufigkeit bei der Segment-Klassifizierung
const SEND_SLICE = 8;       // begrenzte Nebenläufigkeit beim Versand
const INBOX_LIMIT = 1000;   // wie tief in den globalen Vorgangs-Index gelesen wird
const INACTIVE_DAYS = 14;   // ab so vielen Tagen ohne Check-in gilt jemand als inaktiv
const PUBLIC_BASE = Magic.PUBLIC_BASE || 'https://mitglieder.fit-inn-trier.de';

// Nebenläufigkeit begrenzen: items in Slices abarbeiten, fn wirft nie (gekapselt).
async function mapLimited(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const slice = items.slice(i, i + limit);
    let res = [];
    try { res = await Promise.all(slice.map(fn)); } catch (e) { res = []; }
    for (const r of res) out.push(r);
  }
  return out;
}

// Bekannter Empfänger-Pool = Push-Mitglieder ∪ Inbox-Mitglieder, dedupliziert
// (Strings). Reihenfolge: Push-Nutzer zuerst, dann Vorgangs-Mitglieder (neueste
// zuerst). Auf POOL_CAP begrenzt. 403-/fehlersicher.
async function knownMemberPool() {
  const set = new Set();
  try {
    const push = await Push.allPushMembers();
    if (Array.isArray(push)) push.forEach((id) => { if (id != null) set.add(String(id)); });
  } catch (e) {}
  try {
    const all = await Inbox.listAll({ limit: INBOX_LIMIT });
    if (Array.isArray(all)) all.forEach((v) => { const mid = v && v._memberId; if (mid != null) set.add(String(mid)); });
  } catch (e) {}
  return Array.from(set).slice(0, POOL_CAP);
}

// Gehört ein Mitglied ins Segment? Jeder Zugriff ist gekapselt (403/Fehler -> false).
async function matchesSegment(id, segment) {
  if (segment === 'inactive') {
    let ct = null; try { ct = await M.getContract(id); } catch (e) { ct = null; }
    if (!ct || ct.active === false) return false;             // nur mit aktivem Vertrag
    let days = null; try { days = await M.daysSinceLastCheckin(id, { pages: 1 }); } catch (e) { days = null; }
    return typeof days === 'number' && days >= INACTIVE_DAYS;
  }
  if (segment === 'risk') {
    let a = null; try { a = await Churn.assess(id); } catch (e) { a = null; }
    return !!(a && a.level && a.level !== 'niedrig');
  }
  if (segment === 'former') {
    let ct = null; try { ct = await M.getContract(id); } catch (e) { ct = null; }
    return !!(ct && (ct.active === false || ct.reversed || ct.cancelled));
  }
  return false;   // unbekanntes Segment
}

/**
 * Empfänger-IDs eines Segments (Strings), auf CAP begrenzt. Wirft nie.
 *   'app'      -> alle App-Nutzer mit Push (Push.allPushMembers())
 *   'inactive' -> bekannte Mitglieder mit aktivem Vertrag, >= 14 Tage nicht da
 *   'risk'     -> bekannte Mitglieder mit Churn-Level != 'niedrig'
 *   'former'   -> bekannte Mitglieder mit inaktivem/gekündigtem/widerrufenem Vertrag
 */
async function recipients(segment) {
  segment = String(segment || 'app');

  // 'app' braucht keine Magicline-Reads – direkt die Push-Liste.
  if (segment === 'app') {
    let push = [];
    try { push = await Push.allPushMembers(); } catch (e) { push = []; }
    const uniq = Array.from(new Set((push || []).map((id) => String(id))));
    return uniq.slice(0, CAP);
  }

  // Restliche Segmente: Pool klassifizieren (begrenzte Nebenläufigkeit).
  const pool = await knownMemberPool();
  const keep = [];
  await mapLimited(pool, CLASSIFY_SLICE, async (id) => {
    if (keep.length >= CAP) return null;                      // früh aufhören, wenn Cap erreicht
    let ok = false;
    try { ok = await matchesSegment(id, segment); } catch (e) { ok = false; }
    if (ok) keep.push(id);
    return null;
  });
  return keep.slice(0, CAP);
}

// Eine Rundnachricht-/Direkt-E-Mail an EIN Mitglied (nur wenn Adresse vorhanden).
// Liefert true bei erfolgreichem Versand. Wirft nie.
async function sendMailTo(id, title, body) {
  if (!Mail.hasMail) return { ok: false, id: null };
  let m = null;
  try { m = await M.getMember(id); } catch (e) { m = null; }
  const email = m && m.email;
  if (!email) return { ok: false, id: null };
  const firstName = (m && m.firstName) || '';
  let link = PUBLIC_BASE + '/';
  try { link = await Magic.memberLink(id, 'home'); } catch (e) {}
  // Absätze am Leerzeilen-Trenner bilden (renderEmail escaped alle Werte selbst).
  const paragraphs = String(body).split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const em = renderEmail({
    name: firstName || null,
    eyebrow: 'Fit-Inn Trier',
    headline: title,
    intro: paragraphs.length ? paragraphs : [String(body)],
    button: { label: 'Zum Mitgliederbereich', href: link },
    footer: 'member',
    preheader: title,
  });
  try {
    const r = await Mail.sendMailRaw({ to: email, subject: title, text: em.text, html: em.html });
    return { ok: !!(r && r.ok), id: (r && r.id) || null };
  } catch (e) { return { ok: false, id: null }; }
}

// Eine WhatsApp-Freitext-Nachricht an EIN Mitglied. Business-initiiert über eine
// genehmigte Freitext-Vorlage ({{1}} = body). Nur wenn eine Freitext-Vorlage konfiguriert
// ist (WA.hasWaText) UND das Mitglied eine Handynummer hat – sonst still übersprungen.
// Nimmt robust die erste vorhandene Nummer (Mobil bevorzugt). Wirft nie.
async function waOne(id, text) {
  if (!WA.hasWaText) return { ok: false, id: null };
  let m = null;
  try { m = await M.getMember(id); } catch (e) { m = null; }
  const phone = m && (m.phonePrivateMobile || m.phoneMobile || m.phonePrivate || m.phoneBusiness);
  if (!phone) return { ok: false, id: null };
  try { const r = await WA.sendFreeText(phone, text); return { ok: !!(r && r.ok), id: (r && r.id) || null }; } catch (e) { return { ok: false, id: null }; }
}

/**
 * Rundnachricht an ein Segment senden. Iteriert Empfänger in Slices; zählt
 * Push/E-Mail/WhatsApp. Wirft nie.
 * opts: { segment, title, body, channels:{push?, email?, whatsapp?} }
 * -> { recipients, pushSent, mailSent, waSent, capped }
 */
async function sendBroadcast(opts) {
  opts = opts || {};
  const segment = String(opts.segment || 'app');
  const title = String(opts.title || '').slice(0, 160).trim();
  const body = String(opts.body || '').slice(0, 2000).trim();
  const ch = opts.channels || {};
  let wantPush = !!ch.push;
  let wantEmail = !!ch.email;
  const wantWa = !!ch.whatsapp;
  if (!wantPush && !wantEmail && !wantWa) wantPush = true;   // sinnvoller Default: mind. Push

  const result = { recipients: 0, pushSent: 0, mailSent: 0, waSent: 0, capped: false };
  if (!title || !body) return result;

  let ids = [];
  try { ids = await recipients(segment); } catch (e) { ids = []; }
  result.recipients = ids.length;
  result.capped = ids.length >= CAP;              // Cap voll -> vermutlich gekappt
  if (!ids.length) return result;

  const pushUrl = PUBLIC_BASE + '/';
  await mapLimited(ids, SEND_SLICE, async (id) => {
    if (wantPush) {
      try {
        const r = await Push.notifyMember(id, 'pushNews', { title: title, body: body, url: pushUrl });
        if (r && r.ok) result.pushSent++;
      } catch (e) {}
    }
    if (wantEmail) {
      try { const r = await sendMailTo(id, title, body); if (r && r.ok) result.mailSent++; } catch (e) {}
    }
    if (wantWa && WA.hasWaText) {
      try { const r = await waOne(id, body); if (r && r.ok) result.waSent++; } catch (e) {}
    }
    return null;
  });
  return result;
}

/**
 * Direktnachricht an EIN Mitglied. Legt einen Inbox-Vorgang (type 'allgemein',
 * teamText=body) an -> erscheint im Postfach; Push via notifyMember('pushPostfach'),
 * optional E-Mail. Wirft nie.
 * opts: { title?, body, channels:{push?, email?, whatsapp?} }
 * -> { ok, via:[…] }   via aus 'inbox' | 'push' | 'email' | 'whatsapp'
 */
async function sendDirect(memberId, opts) {
  opts = opts || {};
  const id = String(memberId || '').trim();
  const title = String(opts.title || '').slice(0, 160).trim();
  const body = String(opts.body || '').slice(0, 4000).trim();
  const ch = opts.channels || {};
  const wantEmail = !!ch.email;
  const wantPush = ch.push !== false;             // Default: Push an (Postfach-Hinweis)
  const out = { ok: false, via: [] };
  if (!id || !body) return out;

  // 1) Inbox-Vorgang -> landet im Postfach des Mitglieds (Team hat geschrieben).
  let v = null;
  try {
    v = await Inbox.addVorgang(id, {
      type: 'allgemein',
      subject: title || 'Nachricht vom Fit-Inn',
      teamText: body,
      status: 'beantwortet',
      teamStatus: 'wartet',
      teamUnread: false,
    });
  } catch (e) { v = null; }
  if (v) { out.ok = true; out.via.push('inbox'); }

  // 2) Push (pushPostfach) – respektiert Einwilligung, „schläft" ohne Setup.
  if (wantPush) {
    try {
      const r = await Push.notifyMember(id, 'pushPostfach', {
        title: title || 'Neue Nachricht vom Fit-Inn',
        body: body.slice(0, 160),
        url: PUBLIC_BASE + '/',
      });
      if (r && r.ok) { out.ok = true; out.via.push('push'); }
    } catch (e) {}
  }

  // Für den Zustell-/Lesestatus: welcher externe Kanal + Provider-ID zählt (WhatsApp bevorzugt).
  let sentCh = null, sentId = null;

  // 3) Optional E-Mail (nur mit hinterlegter Adresse).
  if (wantEmail) {
    try {
      const r = await sendMailTo(id, title || 'Nachricht vom Fit-Inn', body);
      if (r && r.ok) { out.ok = true; out.via.push('email'); sentCh = 'email'; sentId = r.id; }
    } catch (e) {}
  }

  // 4) Optional WhatsApp (Freitext-Vorlage; nur mit Handynummer + konfigurierter Vorlage).
  if (ch.whatsapp) {
    try {
      const r = await waOne(id, body);
      if (r && r.ok) { out.ok = true; out.via.push('whatsapp'); sentCh = 'whatsapp'; sentId = r.id; }
    } catch (e) {}
  }

  // Kanal + Anfangsstatus an der Team-Nachricht markieren + (falls ID) für die Status-Webhooks tracken.
  if (v && sentCh) {
    try {
      const mm = (v.messages || []).slice().reverse().find((x) => x && x.from === 'team');
      if (mm) {
        mm.ch = sentCh; if (!mm.st) mm.st = 'sent';
        await Inbox.save(id, v);
        if (sentId) { try { await Receipts.track(sentId, { m: id, v: v.id, at: mm.at }); } catch (e) {} }
      }
    } catch (e) {}
  }
  return out;
}

module.exports = { recipients, sendBroadcast, sendDirect };
