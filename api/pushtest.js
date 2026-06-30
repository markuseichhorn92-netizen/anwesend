'use strict';

/**
 * TEMPORÄRER Push-Test (nach Gebrauch wieder entfernen!).
 * Team-passwortgeschützt. Zeigt, ob Push serverseitig konfiguriert ist, wie viele
 * Geräte-Tokens für das Mitglied hinterlegt sind, und schickt eine Test-Push.
 *
 * Aufruf: https://mitglieder.fit-inn-trier.de/api/pushtest  -> Passwort-Formular
 *   optional ?customerId=… (sonst DEMO_CUSTOMER_ID)
 */

const M = require('../lib/members');
const TA = require('../lib/teamAuth');
const Push = require('../lib/push');
const Apns = require('../lib/apns');

function readRaw(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}

const FORM = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px">'
  + '<h2>Push-Test</h2><p>Team-Passwort eingeben:</p>'
  + '<form method="post"><input type="password" name="pw" autofocus style="width:100%;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:8px">'
  + '<button style="margin-top:12px;padding:12px 18px;font-size:16px;border:0;border-radius:8px;background:#0e6072;color:#fff">Test-Push senden</button></form></body>';

module.exports = async function handler(req, res) {
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { url = { searchParams: { get: () => '' } }; }
  const q = (k) => (url.searchParams.get && url.searchParams.get(k)) || '';

  let pw = q('pw'); let bodyParams = null;
  if (req.method === 'POST') {
    const raw = await readRaw(req);
    bodyParams = new URLSearchParams(raw);
    pw = bodyParams.get('pw') || pw;
  }
  if (!TA.verifyPassword(pw)) {
    if (req.method === 'POST') { res.statusCode = 401; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('unauthorized'); }
    res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(FORM);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const cid = q('customerId') || (bodyParams && bodyParams.get('customerId')) || process.env.DEMO_CUSTOMER_ID || '';
  const lines = ['=== Push-Test ===', 'customerId=' + (cid || '—'), ''];
  lines.push('Server konfiguriert (hasPush): ' + Push.hasPush);
  lines.push('Apple/APNs aktiv (hasApns): ' + Apns.hasApns);
  lines.push('APNS_ENV: ' + (process.env.APNS_ENV || 'production'));

  if (!cid) { lines.push('', 'Keine Kunden-ID. Mit ?customerId=… aufrufen.'); res.statusCode = 200; return res.end(lines.join('\n')); }

  let tokens = [];
  try { tokens = await Push.tokensFor(cid); } catch (e) {}
  lines.push('Registrierte Geräte-Tokens: ' + tokens.length);
  if (!tokens.length) {
    lines.push('', '>>> Noch KEIN Geräte-Token. Heißt: Die App auf dem iPhone hat noch keinen Push-Token registriert.');
    lines.push('    Prüfen: Push-Capability in Xcode + neu gebaut + App geöffnet + „Mitteilungen erlauben" bestätigt + eingeloggt.');
    res.statusCode = 200; return res.end(lines.join('\n'));
  }

  let result;
  try { result = await Push.sendToMember(cid, { title: 'Fit-Inn Trier', body: 'Test-Push – läuft! 🎉', url: 'https://mitglieder.fit-inn-trier.de/mitglieder' }); }
  catch (e) { result = { ok: false, error: String((e && e.message) || e) }; }
  lines.push('', 'Sende-Ergebnis: ' + JSON.stringify(result));
  lines.push('', result && result.ok ? '>>> Gesendet! Schau aufs iPhone.' : '>>> Versand nicht erfolgreich – Details oben (Status/Fehler).');
  res.statusCode = 200;
  return res.end(lines.join('\n'));
};
