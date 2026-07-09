'use strict';

/**
 * Öffentliche Angebots-Seite (Rückholung).   KEIN Login – Zugang nur per Token.
 *
 *   GET  ?token=…                    -> { ok, offer:{memberName,summary,details,status,expired,validUntil,studio} }
 *   POST { token, action:'accept'|'decline' }
 *        -> { ok, status }           Annahme/Ablehnung mit Zeitstempel + IP als Nachweis.
 *
 * Bei Annahme wird zusätzlich eine interne Aufgabe „Deal in Magicline umsetzen"
 * angelegt. Der rechtssichere Nachweis (Zeitpunkt, IP, User-Agent) liegt im
 * Angebots-Datensatz (lib/retention).
 */

const M = require('../lib/members');
const R = require('../lib/retention');
const Todos = require('../lib/todos');

const STUDIO = { name: 'Fit-Inn Trier', addr: 'Auf Hirtenberg 8, 54296 Trier', mail: 'info@fit-inn-trier.de', tel: '0651 308524' };

function clientIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown'; }
function pub(o) {
  return {
    memberName: o.memberName || '',
    summary: o.summary || '',
    details: o.details || {},
    status: o.status,
    expired: R.isExpired(o) && o.status === 'sent',
    validUntil: o.expiresAt || 0,
    acceptedAt: o.acceptedAt || 0,
    studio: STUDIO,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    let token = ''; try { token = new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch (e) {}
    if (!token) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'no_token' })); }
    const o = await R.getOfferByToken(token);
    if (!o) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, offer: pub(o) }));
  }

  if (req.method === 'POST') {
    const ip = clientIp(req);
    if (!(await M.rateLimit('offer-decide:' + ip, 30, 3600))) {
      res.statusCode = 429; return res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
    }
    const body = await M.readBody(req);
    const token = String(body.token || '').trim();
    const action = body.action === 'decline' ? 'decline' : 'accept';
    if (!token) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'no_token' })); }

    const r = await R.decideOffer(token, action, { ip: ip, ua: String(req.headers['user-agent'] || '') });
    if (!r.ok && !r.already) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, error: r.error || 'failed', status: (r.offer && r.offer.status) || null }));
    }
    const offer = r.offer;
    // Bei Annahme: interne Aufgabe fürs Team – Deal in Magicline eintragen.
    if (action === 'accept' && offer && !r.already) {
      try {
        await Todos.addTodo({ text: 'Rückhol-Deal in Magicline umsetzen: ' + (offer.memberName || ('Mitglied ' + offer.memberId)) + ' – ' + offer.summary + ' (angenommen ' + new Date(offer.acceptedAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) + ')' });
      } catch (e) {}
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, status: offer ? offer.status : (action === 'accept' ? 'accepted' : 'declined') }));
  }

  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
