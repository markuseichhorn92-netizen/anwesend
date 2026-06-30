'use strict';

/**
 * Apple Push (APNs) – Versand an iOS-Geräte über das HTTP/2-API von Apple,
 * mit Token-Authentifizierung (.p8-Schlüssel, ES256-JWT). Kein Firebase nötig:
 * die App registriert über @capacitor/push-notifications direkt einen APNs-Token.
 *
 * „Schläft" (hasApns=false), bis die Env-Variablen gesetzt sind:
 *   APNS_KEY_ID       Key-ID des .p8-Schlüssels (Apple Developer → Keys)
 *   APNS_TEAM_ID      Team-ID (Apple Developer, oben rechts)
 *   APNS_BUNDLE_ID    Bundle-ID der App (z. B. de.fitinn.portal)
 *   APNS_PRIVATE_KEY  Inhalt der .p8-Datei (mehrzeilig; literal "\n" werden
 *                     in echte Zeilenumbrüche zurückübersetzt)
 *   APNS_ENV          optional 'sandbox' (Debug-Builds) – sonst Produktion
 */

const crypto = require('node:crypto');
let http2; try { http2 = require('node:http2'); } catch (e) { http2 = null; }

const KEY_ID = process.env.APNS_KEY_ID || '';
const TEAM_ID = process.env.APNS_TEAM_ID || '';
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || process.env.APNS_TOPIC || '';
const P8 = (process.env.APNS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const HOST = process.env.APNS_ENV === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';

const hasApns = !!(KEY_ID && TEAM_ID && BUNDLE_ID && P8 && http2);

function b64url(x) { return Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

let _jwt = null, _jwtAt = 0;
function authToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_jwt && (now - _jwtAt) < 3000) return _jwt;   // < 50 Min wiederverwenden
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID }));
  const claim = b64url(JSON.stringify({ iss: TEAM_ID, iat: now }));
  const sig = crypto.createSign('SHA256').update(header + '.' + claim).sign({ key: P8, dsaEncoding: 'ieee-p1363' });
  _jwt = header + '.' + claim + '.' + b64url(sig);
  _jwtAt = now;
  return _jwt;
}

// Sendet an genau ein iOS-Gerät. Liefert { ok, status }.
// status 410 / 400(BadDeviceToken) => Token ungültig (Aufrufer entfernt ihn).
function sendOne(token, msg) {
  return new Promise(function (resolve) {
    if (!hasApns) return resolve({ ok: false, status: 0 });
    let client;
    try { client = http2.connect(HOST); } catch (e) { return resolve({ ok: false, status: 0 }); }
    let done = false;
    const finish = function (r) { if (done) return; done = true; try { client.close(); } catch (e) {} resolve(r); };
    client.on('error', function () { finish({ ok: false, status: 0 }); });
    const aps = { alert: { title: String(msg.title || ''), body: String(msg.body || '') }, sound: 'default' };
    const payloadObj = { aps: aps };
    if (msg.url) payloadObj.url = String(msg.url);
    const payload = JSON.stringify(payloadObj);
    let req;
    try {
      req = client.request({
        ':method': 'POST', ':path': '/3/device/' + token,
        'authorization': 'bearer ' + authToken(),
        'apns-topic': BUNDLE_ID, 'apns-push-type': 'alert', 'apns-priority': '10',
      });
    } catch (e) { return finish({ ok: false, status: 0 }); }
    let status = 0, body = '';
    req.on('response', function (h) { status = h[':status'] || 0; });
    req.on('data', function (d) { body += d; });
    req.on('end', function () { finish({ ok: status === 200, status: status, body: body.slice(0, 200) }); });
    req.on('error', function () { finish({ ok: false, status: 0 }); });
    req.setTimeout(8000, function () { try { req.close(); } catch (e) {} finish({ ok: false, status: 0 }); });
    req.end(payload);
  });
}

module.exports = { hasApns, sendOne };
