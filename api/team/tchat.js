'use strict';

/**
 * Team-Backend: Team-Chat (1:1 zwischen Mitarbeitern, z. B. für Schichttausch).
 *   GET                 -> { ok, me, threads:[{key, other, shiftStr, last, updatedAt}] }
 *   GET ?with=<empId>   -> { ok, me, thread:{key, other, shiftStr, messages, updatedAt}|null }
 *   POST { with, withName?, withInitials?, text, shiftStr? } -> { ok, me, thread }
 *
 * Admin ohne employeeId chattet mit Pseudo-Identität { id:'admin', name:'Studio',
 * initials:'ST' }. Ohne Store leere Daten, wirft nie.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const SH = require('../../lib/shifts');
const M = require('../../lib/members');   // readBody

function chatIdent(sess) {
  if (sess && sess.employeeId != null && String(sess.employeeId).trim() !== '') {
    const name = String(sess.user || 'Trainer');
    return { id: String(sess.employeeId).trim(), name: name, initials: SH.initialsOf(name) };
  }
  return { id: 'admin', name: 'Studio', initials: 'ST' };
}

// Thread fürs Frontend aufbereiten: Gegenüber ("other") relativ zu mir.
function publicThread(t, meId, withMessages) {
  if (!t) return null;
  const other = (t.a && String(t.a.id) === String(meId)) ? t.b : t.a;
  const out = {
    key: t.key || null,
    other: other || null,
    shiftStr: t.shiftStr || '',
    updatedAt: t.updatedAt || 0,
  };
  const msgs = Array.isArray(t.messages) ? t.messages : [];
  if (withMessages) out.messages = msgs;
  else out.last = msgs.length ? msgs[msgs.length - 1] : null;
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'shifts.manage', res)) return;
  const me = chatIdent(sess);

  if (req.method === 'GET') {
    let withId = null;
    try { withId = new URL(req.url, 'http://x').searchParams.get('with'); } catch (e) {}
    if (withId && String(withId).trim()) {
      const t = await SH.getThread(me.id, String(withId).trim());
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, me: me, thread: publicThread(t, me.id, true) }));
    }
    let threads = [];
    try { threads = await SH.listThreads(me.id); } catch (e) { threads = []; }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, me: me, threads: threads.map((t) => publicThread(t, me.id, false)) }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }

  if (!SH.hasStore) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, disabled: true, message: 'Speicher nicht verfügbar – Team-Chat ist deaktiviert.' }));
  }

  const withId = String((body && body.with) || '').trim();
  const text = String((body && body.text) || '').trim();
  if (!withId) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_with' })); }
  if (!text) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte eine Nachricht eingeben.' })); }
  if (withId === me.id) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Du kannst dir nicht selbst schreiben.' })); }

  const other = {
    id: withId,
    name: String((body && body.withName) || '').trim() || ('Mitarbeiter ' + withId),
    initials: String((body && body.withInitials) || '').trim() || SH.initialsOf(body && body.withName),
  };
  const t = await SH.postMessage(me, other, text, body && body.shiftStr);
  if (!t) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Nachricht konnte nicht gesendet werden.' })); }
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, me: me, thread: publicThread(t, me.id, true) }));
};
