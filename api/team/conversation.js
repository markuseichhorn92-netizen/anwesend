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
 *   assignee { value|null }           -> Zuweisung
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
  } else if (action === 'priority') {
    v = await Inbox.setMeta(m, id, { priority: body.value }) || v;
  } else if (action === 'assignee') {
    v = await Inbox.setMeta(m, id, { assignee: body.value || null }) || v;
  } else if (action === 'note') {
    const nv = await Inbox.addNote(m, id, { text: body.text, author: author });
    if (!nv) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Notiz ist leer.' })); }
    v = nv;
  } else if (action === 'close') {
    v = await Inbox.resolve(m, id) || v;
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
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, reassigned: true, memberId: String(to), id: moved.id, conversation: View.fullConversation(moved, to) }));
  } else {
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
  }

  await ensureSnapshot(m, v);
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, conversation: View.fullConversation(v, m) }));
};
