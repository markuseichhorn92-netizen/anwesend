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
const AI = require('../../lib/ai');
const Outreach = require('../../lib/outreach');

// KI-Vorschlag hart auf den Rahmen begrenzen (Sicherheitsnetz, egal was die KI liefert).
function clampToFrame(d, f) {
  d = R.normalizeDetails(d);
  return {
    discountPct: Math.min(d.discountPct, f.maxDiscountPct || 0),
    discountWeeks: Math.min(d.discountWeeks, f.maxDiscountWeeks || 0),
    freeWeeks: Math.min(d.freeWeeks, f.maxFreeWeeks || 0),
    waiveActivation: !!(d.waiveActivation && f.waiveActivation),
    pauseWeeks: Math.min(d.pauseWeeks, f.maxPauseWeeks || 0),
  };
}

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
    message: o.message || '',           // die tatsächlich versandte Nachricht (Nachvollziehbarkeit)
    createdBy: o.createdBy || '',        // wer/was das Angebot erstellt hat (Name oder „KI")
    createdAt: o.createdAt, acceptedAt: o.acceptedAt || 0,
    acceptIp: o.acceptIp || '',          // Nachweis bei Annahme
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
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, frame: frame, offers: offers, stored: R.hasStore }));
  }

  if (req.method === 'POST') {
    const body = await M.readBody(req);
    const action = String(body.action || '');

    if (action === 'set-frame') {
      const frame = await R.setFrame(body.frame || {}, sess.user || '');
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, frame: frame, stored: R.hasStore }));
    }

    // KI-Vorschlag fürs Angebot + persönliche Ansprache (füllt den Komponisten vor).
    if (action === 'suggest-offer') {
      const memberId = String(body.memberId || '').trim();
      const frame = await R.getFrame();
      if (!frame.active) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'inactive' })); }
      if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai' })); }
      let name = String(body.memberName || ''), rateName = '', status = '';
      try { const m = await M.getMember(memberId); if (m) { const nm = ((m.firstName || '') + ' ' + (m.lastName || '')).trim(); if (nm) name = nm; } } catch (e) {}
      try { const ct = await M.getContract(memberId); if (ct) { rateName = ct.rateName || ''; status = ct.active === false ? 'ehemalig/beendet' : (ct.cancelled ? 'gekündigt' : 'aktiv'); } } catch (e) {}
      const sug = await AI.winbackSuggest({ name: name, rateName: rateName, status: status, frame: frame });
      if (!sug.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'ai_failed' })); }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, details: clampToFrame(sug.details, frame), message: sug.message }));
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
