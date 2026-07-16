'use strict';

/**
 * Team-Posteingang: Liste aller Vorgänge über alle Mitglieder.
 *   GET (Bearer Team-Token) -> { ok, conversations:[…], counts:{…} }
 *
 * Reichert fehlende Member-Snapshots (Name/Nr) gekappt aus Magicline an und
 * persistiert sie am Vorgang (selbstheilend, ohne die Liste auszubremsen).
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const Inbox = require('../../lib/inbox');
const M = require('../../lib/members');
const View = require('../../lib/teamView');

const ENRICH_CAP = 12;   // max. Magicline-Abfragen pro Listenaufruf

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'conversations.manage', res)) return;
  if (!Inbox.hasStore) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, conversations: [], counts: { all: 0, open: 0, neu: 0, done: 0 }, disabled: true }));
  }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const all = await Inbox.listAll({ limit: 400 });

  // Fehlende Snapshots sammeln (eindeutige Mitglieder), gekappt nachladen.
  const need = [];
  const seen = {};
  for (const v of all) {
    const mid = v._memberId;
    if (mid && !seen[mid] && (!v.member || !v.member.name)) { seen[mid] = 1; need.push(mid); }
  }
  const snaps = {};
  await Promise.all(need.slice(0, ENRICH_CAP).map(async (mid) => {
    try { const mm = await M.getMember(mid); const s = View.snapshotFromMember(mm); if (s) snaps[mid] = s; } catch (e) {}
  }));
  // In-Memory anwenden + persistieren (best effort, klein gehalten).
  const persists = [];
  for (const v of all) {
    if ((!v.member || !v.member.name) && snaps[v._memberId]) {
      v.member = snaps[v._memberId];
      persists.push(Inbox.setMemberSnapshot(v._memberId, v.id, snaps[v._memberId]).catch(() => {}));
    }
  }
  if (persists.length) { try { await Promise.all(persists); } catch (e) {} }

  const conversations = all.map(View.listItem);
  const counts = {
    all: all.length,
    open: all.filter((v) => v.teamStatus !== 'abgeschlossen').length,
    neu: all.filter((v) => v.teamStatus === 'neu').length,
    done: all.filter((v) => v.teamStatus === 'abgeschlossen').length,
    unread: all.filter((v) => v.teamUnread).length,
  };
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, conversations, counts }));
};
