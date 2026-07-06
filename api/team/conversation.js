'use strict';

/**
 * Einzelner Vorgang im Team-Backend.
 *   GET  ?m=<memberId>&id=<vorgangId>   -> voller Thread (markiert team-gelesen)
 *   POST { m, id, action, … }           -> Aktion ausführen, aktualisierten Vorgang zurück
 *
 * Aktionen:
 *   reply    { text }                 -> Antwort an Mitglied (kanalbewusst: Portal/E-Mail/WhatsApp)
 *   status   { value }                -> teamStatus (neu|bearbeitung|wartet|abgeschlossen)
 *   priority { value }                -> hoch|mittel|niedrig
 *   assignee { value|null }           -> Zuweisung (freier Name, Alt-Format)
 *   assign   { assigneeId, assigneeName } -> Zuweisung an Magicline-Mitarbeiter ({id,name}; leer = entfernen)
 *   note     { text }                 -> interne Notiz (nur Team)
 *   close                             -> Vorgang abschließen
 *   reopen                            -> wieder öffnen
 *   read                              -> als (team-)gelesen markieren
 */

const TA = require('../../lib/teamAuth');
const Inbox = require('../../lib/inbox');
const M = require('../../lib/members');
const SR = require('../../lib/studioReply');
const View = require('../../lib/teamView');
const LF = require('../../lib/leadflow');

// Absender (Telefon/E-Mail) eines Vorgangs künftig einem Kunden zuordnen, damit
// eingehende Nachrichten nicht wieder ein neues Ticket öffnen. Nie auf Pseudo-IDs
// ("wa…") mappen. Wirft nie.
const CONV_EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
function emailFromVorgang(v) {
  const texts = (((v && v.messages) || []).filter((mm) => mm.from === 'member').map((mm) => String(mm.text || '')));
  for (const t of texts) { const mm = t.match(CONV_EMAIL_RE); if (mm) return mm[0]; }
  return null;
}
async function rememberSender(v, memberId, snap) {
  try {
    if (!memberId || /^wa/i.test(String(memberId))) return;
    const nm = (snap && snap.name) || (v && v.member && v.member.name) || null;
    const nr = (snap && snap.nr) || (v && v.member && v.member.nr) || null;
    const data = { id: String(memberId), name: nm, nr: nr };
    const ph = (v && v.phone) ? String(v.phone).replace(/[^\d]/g, '') : '';
    if (ph) await LF.linkPhone(ph, data);
    const email = emailFromVorgang(v) || (snap && snap.email) || (v && v.member && v.member.email) || null;
    if (email) await LF.linkEmail(email, data);
  } catch (e) {}
}

// Snapshot nachladen, falls am Vorgang noch keiner hängt.
async function ensureSnapshot(memberId, v) {
  if (v && v.member && v.member.name) return v;
  try {
    const mm = await M.getMember(memberId);
    const s = View.snapshotFromMember(mm);
    if (s) { v.member = s; await Inbox.setMemberSnapshot(memberId, v.id, s); }
  } catch (e) {}
  return v;
}

// Team-Antwort zusätzlich in der Magicline-Kundenhistorie protokollieren
// (Scope COMMUNICATION_WRITE). Best effort: Fehler (z. B. 403 ohne Scope)
// werden still geschluckt – die Antwort an den Client hängt NICHT davon ab.
// Pseudo-Mitglieder ("wa…" = WhatsApp-Leads) haben keine Magicline-ID -> überspringen.
const CRM_CHANNEL = { whatsapp: 'TEXT_MESSAGE', email: 'EMAIL', portal: 'CHAT' };
async function logToMagicline(memberId, v, text, channel, author) {
  try {
    if (!memberId || /^wa/.test(String(memberId))) return;
    await M.ml('POST', '/communications/' + encodeURIComponent(memberId) + '/threads', {
      communicationThreadStatus: 'ONGOING',
      subject: (((v && v.subject) || 'Vorgang') + ((v && v.ref) ? (' ' + v.ref) : '')).slice(0, 200),
      content: String(text || '').slice(0, 4000),
      communicationDirection: 'OUTGOING',
      communicationChannel: CRM_CHANNEL[channel] || 'OTHER',
      agent: String(author || 'Team').slice(0, 80),
    });
  } catch (e) {}
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Inbox.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, disabled: true })); }

  // ── GET: Thread laden ──
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const m = url.searchParams.get('m'); const id = url.searchParams.get('id');
    let v = await Inbox.get(m, id);
    if (!v) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
    await ensureSnapshot(m, v);
    await Inbox.markTeamRead(m, id);
    v.teamUnread = false;
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, conversation: View.fullConversation(v, m) }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const m = body.m; const id = body.id; const action = body.action;
  if (!m || !id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_ids' })); }

  let v = await Inbox.get(m, id);
  if (!v) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
  const prevTeamStatus = v && v.teamStatus;   // für die „automatisch bearbeitet"-Statistik (team)

  const author = sess.user === 'team' ? 'Team' : String(sess.user || 'Team');

  if (action === 'reply') {
    if (!(await M.rateLimit('team-reply:' + m, 60, 3600))) {
      res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Antworten – bitte kurz warten.' }));
    }
    const text = String(body.text || '').trim();
    if (!text) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte gib eine Nachricht ein.' })); }
    const wantCh = (body.channel === 'whatsapp' || body.channel === 'email') ? body.channel : undefined;
    const r = await SR.applyOwnerReply(m, id, text, { channel: wantCh, author: author });
    if (!r || !r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Antwort konnte nicht zugestellt werden.' })); }
    v = await Inbox.get(m, id);
    await logToMagicline(m, v, text, r.channel || 'portal', author);
    if (wantCh && r.channel && r.channel !== wantCh) {
      // Gewünschter Kanal war nicht möglich -> auf den anderen ausgewichen (UI informieren).
      await ensureSnapshot(m, v);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, channelUsed: r.channel, channelFallback: true, conversation: View.fullConversation(v, m) }));
    }
    if (r.channel === null) {
      await ensureSnapshot(m, v);
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, channelUsed: null, conversation: View.fullConversation(v, m) }));
    }
  } else if (action === 'status') {
    v = await Inbox.setMeta(m, id, { teamStatus: body.value }) || v;
    if (body.value === 'abgeschlossen' && prevTeamStatus !== 'abgeschlossen') { try { require('../../lib/handled').record('team', m, 'vorgang'); } catch (e) {} }
  } else if (action === 'priority') {
    v = await Inbox.setMeta(m, id, { priority: body.value }) || v;
  } else if (action === 'assignee') {
    v = await Inbox.setMeta(m, id, { assignee: body.value || null }) || v;
  } else if (action === 'assign') {
    // Mitarbeiter-Zuweisung (Auswahl aus /api/team/employees). Leer -> Zuweisung entfernen.
    const aid = body.assigneeId != null ? String(body.assigneeId).trim() : '';
    const aname = String(body.assigneeName || '').trim().slice(0, 80);
    v.assignee = (aid || aname) ? { id: aid || null, name: aname || null } : null;
    v.updatedAt = Date.now();
    v = await Inbox.save(m, v) || v;
  } else if (action === 'note') {
    const nv = await Inbox.addNote(m, id, { text: body.text, author: author });
    if (!nv) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Notiz ist leer.' })); }
    v = nv;
  } else if (action === 'close') {
    v = await Inbox.resolve(m, id) || v;
    if (prevTeamStatus !== 'abgeschlossen') { try { require('../../lib/handled').record('team', m, 'vorgang'); } catch (e) {} }
  } else if (action === 'reopen') {
    v = await Inbox.setMeta(m, id, { teamStatus: 'bearbeitung' }) || v;
  } else if (action === 'read') {
    v = await Inbox.markTeamRead(m, id) || v;
  } else if (action === 'reassign') {
    const to = String(body.to || '').trim();
    if (!to) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen Zielkunden wählen.' })); }
    if (to === String(m)) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Der Vorgang ist diesem Kunden bereits zugeordnet.' })); }
    // Snapshot fürs Ziel: bevorzugt aus dem Suchergebnis, sonst frisch aus Magicline.
    let snap = (body.snapshot && body.snapshot.name) ? body.snapshot : null;
    if (!snap) { try { const mm = await M.getMember(to); snap = View.snapshotFromMember(mm); } catch (e) {} }
    const moved = await Inbox.reassign(m, id, to, snap);
    if (!moved) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Zuordnung fehlgeschlagen.' })); }
    // Absender (Nummer/E-Mail) dieses Vorgangs künftig dem Zielkunden zuordnen.
    await rememberSender(v, to, snap);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, reassigned: true, memberId: String(to), id: moved.id, conversation: View.fullConversation(moved, to) }));
  } else if (action === 'merge') {
    // Diesen Vorgang (fromM,fromId) in den aktuellen (m,id) zusammenführen.
    const fromM = String(body.fromM || '').trim();
    const fromId = String(body.fromId || '').trim();
    if (!fromM || !fromId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen zweiten Vorgang wählen.' })); }
    if (fromM === String(m) && fromId === String(id)) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen anderen Vorgang wählen.' })); }
    const fromV = await Inbox.get(fromM, fromId);
    const merged = await Inbox.merge(fromM, fromId, m, id);
    if (!merged) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Zusammenführen fehlgeschlagen.' })); }
    // Absender des zusammengeführten Vorgangs künftig diesem Kunden zuordnen (kein Pseudo).
    await rememberSender(fromV, m, merged.member);
    await ensureSnapshot(m, merged);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, merged: true, conversation: View.fullConversation(merged, m) }));
  } else {
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
  }

  await ensureSnapshot(m, v);
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, conversation: View.fullConversation(v, m) }));
};
