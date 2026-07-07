'use strict';

/**
 * POST /api/team/winback   (Bearer Team-Token)
 *   { id, offer?, note? }  -> Eine Rückholaktion dokumentieren.
 *
 * Zweck: Wenn das Team einem (kündigenden/abwandernden) Mitglied ein
 * Rückhol-Angebot macht, halten wir das nachvollziehbar fest:
 *   1) Eintrag in die Magicline-Kundenhistorie
 *      (POST /communications/{id}/threads, Scope COMMUNICATION_WRITE) –
 *      derselbe Weg, über den wir schon Team-Antworten protokollieren.
 *      Best effort: fehlt der Scope (403) oder schlägt es fehl, bleibt
 *      magiclineLogged:false, der Rest läuft trotzdem.
 *   2) Interne Team-Notiz am jüngsten Vorgang des Mitglieds (falls vorhanden).
 *   3) Statistik-Vermerk (Handled.record 'team' … 'rueckholung').
 *
 * Die API kann KEIN Angebot (Rabatt/Tarif) automatisch buchen – das bleibt
 * ein reines Festhalten. Wirft nie; -> { ok, magiclineLogged, localLogged }.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');
const Inbox = require('../../lib/inbox');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const b = await M.readBody(req);
  const id = String(b.id || '').trim();
  const offer = String(b.offer || '').trim();
  const note = String(b.note || '').trim();
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Kein Mitglied angegeben.' })); }
  const desc = [offer, note].filter(Boolean).join(' — ');
  if (!desc) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte kurz beschreiben, was angeboten wurde.' })); }

  const author = (sess && sess.user) || 'Team';
  const content = ('Rückholaktion angeboten: ' + desc).slice(0, 4000);

  // Anti-Spam: max. 20 Vermerke je Mitglied pro Stunde.
  if (!(await M.rateLimit('team-winback:' + id, 20, 3600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Vermerke – bitte kurz warten.' }));
  }

  // 1) Magicline-Kundenhistorie (best effort; Pseudo-IDs 'wa…' = WhatsApp-Leads überspringen).
  let magiclineLogged = false;
  if (!/^wa/i.test(id)) {
    try {
      const r = await M.ml('POST', '/communications/' + encodeURIComponent(id) + '/threads', {
        communicationThreadStatus: 'ONGOING',
        subject: 'Rückholaktion',
        content: content,
        communicationDirection: 'OUTGOING',
        communicationChannel: 'OTHER',
        agent: String(author).slice(0, 80),
      });
      magiclineLogged = !!(r && r.status >= 200 && r.status < 300);
    } catch (e) {}
  }

  // 2) Interne Team-Notiz am jüngsten Vorgang (falls vorhanden) – unser eigener Beleg.
  let localLogged = false;
  try {
    const list = await Inbox.list(id);
    if (list && list.length) {
      const v = await Inbox.addNote(id, list[0].id, { text: content, author: author });
      localLogged = !!v;
    }
  } catch (e) {}

  // 3) Statistik-Vermerk (best effort).
  try { require('../../lib/handled').record('team', id, 'rueckholung'); } catch (e) {}

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, magiclineLogged: magiclineLogged, localLogged: localLogged }));
};
