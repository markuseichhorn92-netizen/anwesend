'use strict';

/**
 * Rückholung (Team, nur Admin).   Authorization: Bearer <team-token>
 *
 *   GET                              -> { ok, frame, offers }
 *   POST { action:'set-frame', frame } -> { ok, frame }
 *   POST { action:'create-offer', memberId, memberName, details, message }
 *        -> { ok, offer:{id,summary,url,status}, sent }  |  { ok:false, error:'out_of_frame', violations }
 *
 * „Rahmen" = Höchstwerte für die KI-Verhandlung (lib/retention). Ein Angebot wird
 * HART gegen den Rahmen geprüft; nur innerhalb wird es erstellt und mit einem
 * eindeutigen Annahme-Link an das Mitglied geschickt (Postfach + Push/Mail/WA).
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');
const R = require('../../lib/retention');
const Outreach = require('../../lib/outreach');

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return proto + '://' + host;
}
function offerUrl(req, token) { return baseUrl(req) + '/angebot?token=' + encodeURIComponent(token); }

// Offer fürs Team aufbereiten (ohne Token nach außen streuen ist ok – Team darf ihn sehen).
function pubOffer(req, o) {
  return {
    id: o.id, memberId: o.memberId, memberName: o.memberName,
    summary: o.summary, details: o.details, status: o.status,
    createdAt: o.createdAt, acceptedAt: o.acceptedAt || 0,
    url: offerUrl(req, o.token),
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!TA.isAdmin(sess)) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }

  if (req.method === 'GET') {
    const frame = await R.getFrame();
    const offers = (await R.listOffers(60)).map((o) => pubOffer(req, o));
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, frame: frame, offers: offers }));
  }

  if (req.method === 'POST') {
    const body = await M.readBody(req);
    const action = String(body.action || '');

    if (action === 'set-frame') {
      const frame = await R.setFrame(body.frame || {}, sess.user || '');
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, frame: frame }));
    }

    if (action === 'create-offer') {
      const memberId = String(body.memberId || '').trim();
      if (!memberId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_member' })); }
      // Anti-Spam pro Mitglied.
      if (!(await M.rateLimit('wb-offer:' + memberId, 6, 3600))) {
        res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Zu viele Angebote an dieses Mitglied – bitte kurz warten.' }));
      }
      const created = await R.createOffer({
        memberId: memberId,
        memberName: body.memberName || '',
        details: body.details || {},
        message: body.message || '',
        createdBy: sess.user || '',
      });
      if (!created.ok) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: false, error: created.error || 'create_failed', violations: created.violations || [] }));
      }
      const offer = created.offer;
      const url = offerUrl(req, offer.token);
      // Nachricht (Verhandlungstext) + Annahme-Link ans Mitglied.
      const intro = String(body.message || '').trim();
      const bodyText = (intro ? intro + '\n\n' : '')
        + 'Dein persönliches Angebot: ' + offer.summary + '\n\n'
        + 'Zum Ansehen & verbindlich Annehmen: ' + url + '\n\n'
        + 'Das Angebot ist ' + R.OFFER_TTL_DAYS + ' Tage gültig.';
      let sent = { ok: false, via: [] };
      try { sent = await Outreach.sendDirect(memberId, { title: 'Ein Angebot für dich', body: bodyText, channels: { push: true } }); } catch (e) {}
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, offer: { id: offer.id, summary: offer.summary, url: url, status: offer.status }, sent: !!(sent && sent.ok), via: (sent && sent.via) || [] }));
    }

    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
  }

  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
