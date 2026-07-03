'use strict';

/**
 * /api/team/access-medium   (Authorization: Bearer <Team-Token>)
 * Team-Backend: Zugangsmedium (Chip / Karte / Band) EINES Mitglieds sehen und
 * sperren/entsperren bzw. neu ausgeben (Scope CUSTOMER_ACCESS_MEDIUM_WRITE) –
 * über die 403-festen Wrapper in lib/mlAccessMedium. Das Team handelt hier FÜR
 * ein Mitglied, daher kommt die Mitglieds-ID aus Query bzw. Body.
 *
 *   GET ?memberId=…  -> { ok:true, available, items:[{id,label,status,type?}] }
 *                       (available:false -> die UI blendet die Karte aus)
 *
 *   POST { memberId, action:'block'|'unblock'|'issue', mediumId?, number?, type?, label? }
 *     -> WRITE-FIRST: erst die Open API versuchen. Bei Erfolg sofort bestätigen
 *        ({ via:'magicline' }) und einen abgeschlossenen Inbox-Vorgang anlegen.
 *        Bei 403/Fehler FALLBACK: Inbox-Vorgang + Studio-Mail mit dem Wunsch
 *        ({ via:'fallback' }) – der Wunsch geht NIE verloren. Nie werfen.
 *
 * Graceful Degradation ist zentral: die exakten Magicline-Endpunkte sind unsicher
 * (siehe lib/mlAccessMedium). Der Fallback greift also immer dann, wenn die
 * Aktion über die API nicht sauber durchgeht.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');          // readBody, rateLimit, getMember
const AM = require('../../lib/mlAccessMedium');    // 403-feste Wrapper
const Inbox = require('../../lib/inbox');
const SR = require('../../lib/studioReply');

// Aktion -> Vergangenheits-Verb (für Bestätigung/Texte).
const DONE = { block: 'gesperrt', unblock: 'entsperrt', issue: 'ausgegeben' };
// Aktion -> Wunsch-Verb (für den Fallback ans Studio).
const WISH = { block: 'sperren', unblock: 'entsperren', issue: 'ausgeben' };

function initials(name) {
  const p = String(name || '').trim().split(/\s+/);
  const s = ((p[0] || '')[0] || '') + ((p[p.length - 1] || '')[0] || '');
  return (s || 'M').toUpperCase();
}
function who(m) {
  m = m || {};
  return (((m.firstName || '') + ' ' + (m.lastName || '')).trim() || 'Mitglied')
    + (m.customerNumber ? (' (' + m.customerNumber + ')') : '')
    + (m.email ? (' · ' + m.email) : '');
}
// Snapshot fürs Team-Backend (Name/Nr/Initialen/…), damit der Vorgang in der
// globalen Inbox sauber angezeigt wird.
function snapshot(m, memberId) {
  m = m || {};
  const name = ((m.firstName || '') + ' ' + (m.lastName || '')).trim() || ('Mitglied ' + memberId);
  return {
    name: name, nr: m.customerNumber || null, initials: initials(name),
    email: m.email || null, phone: m.phonePrivate || m.phoneMobile || m.phoneBusiness || null,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  // ── GET: Zugangsmedien des Mitglieds ──
  if (req.method === 'GET') {
    let memberId = null;
    try { memberId = new URL(req.url, 'http://x').searchParams.get('memberId'); } catch (e) {}
    if (memberId == null || String(memberId).trim() === '') {
      res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_memberId' }));
    }
    let list;
    try { list = await AM.listAccessMedia(memberId); } catch (e) { list = { available: false }; }
    const available = !!(list && list.available);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, available: available, items: available ? (list.items || []) : [] }));
  }

  // ── POST: sperren / entsperren / neu ausgeben ──
  if (req.method === 'POST') {
    const body = await M.readBody(req);
    const memberId = body.memberId;
    if (memberId == null || String(memberId).trim() === '') {
      res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_memberId' }));
    }
    const action = (['block', 'unblock', 'issue'].indexOf(body.action) >= 0) ? body.action : null;
    if (!action) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte eine gültige Aktion wählen.' }));
    }
    const mediumIdRaw = body.mediumId;
    const mediumId = (typeof mediumIdRaw === 'number') ? mediumIdRaw : String(mediumIdRaw == null ? '' : mediumIdRaw).trim();
    if ((action === 'block' || action === 'unblock') && (mediumId === '' || mediumId == null)) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kein Zugangsmedium ausgewählt.' }));
    }
    const number = String(body.number == null ? '' : body.number).slice(0, 60).trim();
    const type = String(body.type == null ? '' : body.type).slice(0, 40).trim();
    const label = String(body.label == null ? '' : body.label).slice(0, 80).trim();
    // Bezeichnung fürs Protokoll: ausgewähltes Medium bzw. neue Nummer.
    const mediumText = label || (action === 'issue' ? (number || 'neues Medium') : ('#' + mediumId));

    // Leichter Spam-Schutz: max. 30 Aktionen pro Stunde je Mitglied.
    if (!(await M.rateLimit('access-medium:' + memberId, 30, 3600))) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Anfragen. Bitte später erneut.' }));
    }

    let m = null; try { m = await M.getMember(memberId); } catch (e) {}
    const snap = snapshot(m, memberId);

    // ── WRITE-FIRST: echte Aktion über die Open API versuchen ──
    let r;
    try {
      if (action === 'block') r = await AM.blockAccessMedium(memberId, mediumId);
      else if (action === 'unblock') r = await AM.unblockAccessMedium(memberId, mediumId);
      else r = await AM.issueAccessMedium(memberId, { number: number, type: type });
    } catch (e) { r = { ok: false, forbidden: false }; }

    if (r && r.ok) {
      // Erfolg -> abgeschlossenen Vorgang ins Postfach (protokolliert die Aktion).
      try {
        await Inbox.addVorgang(memberId, {
          type: 'allgemein',
          subject: 'Zugangsmedium ' + DONE[action],
          status: 'abgeschlossen',
          systemText: 'Zugangsmedium „' + mediumText + '" ' + DONE[action] + '.',
          member: snap,
        });
      } catch (e) {}
      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true, via: 'magicline',
        message: 'Zugangsmedium ' + DONE[action] + ' · Magicline',
      }));
    }

    // ── FALLBACK: Wunsch als Vorgang sichern + Studio benachrichtigen ──
    let vorgang = null;
    try {
      vorgang = await Inbox.addVorgang(memberId, {
        type: 'allgemein',
        subject: 'Zugangsmedium ' + WISH[action],
        systemText: 'Das Team möchte das Zugangsmedium „' + mediumText + '" ' + WISH[action] + '. '
          + 'Der Wunsch wurde ans Studio übergeben und wird dort erledigt.',
        member: snap,
      });
    } catch (e) {}

    const text = 'Zugangsmedium ' + WISH[action] + ' – aus dem Team-Backend\n\n'
      + 'Mitglied: ' + who(m || {}) + '\n'
      + 'Kundennr.: ' + ((m && m.customerNumber) || '—') + '\n'
      + 'Kunden-ID: ' + memberId + '\n'
      + 'Aktion: ' + WISH[action] + '\n'
      + (action === 'issue'
        ? ('Neue Nummer: ' + (number || '(vom Studio zu vergeben)') + (type ? ('\nTyp: ' + type) : '') + '\n')
        : ('Medium: ' + mediumText + (mediumId ? (' (ID ' + mediumId + ')') : '') + '\n'))
      + '\n'
      + 'Bitte in Magicline erledigen: das Zugangsmedium ' + WISH[action] + '.';

    try {
      await SR.notifyStudio({
        member: m || { id: memberId }, vorgang: vorgang,
        subject: '🔑 Zugangsmedium ' + WISH[action] + ' – ' + who(m || {}),
        text: text,
      });
    } catch (e) {}

    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true, via: 'fallback',
      message: 'Wunsch ans Studio übergeben.',
    }));
  }

  res.statusCode = 405;
  return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
