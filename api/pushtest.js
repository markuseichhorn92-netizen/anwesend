'use strict';

/**
 * TEMPORÄRER Push-Test (nach Gebrauch wieder entfernen!).
 * Team-passwortgeschützt. Listet ALLE Mitglieder mit registriertem Push-Token
 * (samt Plattform) und schickt jedem eine Test-Push. So sehen wir unabhängig von
 * der Mitgliedsnummer, welche Geräte (iOS/Android) registriert sind.
 *
 * Aufruf: https://mitglieder.fit-inn-trier.de/api/pushtest -> Passwort-Formular
 */

// redeploy-marker v4
const TA = require('../lib/teamAuth');
const Push = require('../lib/push');
const Apns = require('../lib/apns');
const { redisPipeline } = require('../lib/store');

function readRaw(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}

// Alle Mitglieder-IDs mit Push-Token ermitteln -> [{ id, count, platforms }].
async function registeredMembers() {
  let keys = [];
  try { const [k] = await redisPipeline([['KEYS', 'push:tok:*']]); keys = Array.isArray(k) ? k : []; } catch (e) {}
  const out = [];
  for (const key of keys) {
    const id = String(key).replace(/^push:tok:/, '');
    let toks = [];
    try { const [t] = await redisPipeline([['SMEMBERS', key]]); toks = Array.isArray(t) ? t : []; } catch (e) {}
    if (!toks.length) continue;
    const platforms = [];
    for (const tk of toks) {
      let plat = '?';
      try { const [v] = await redisPipeline([['GET', 'push:meta:' + tk]]); if (v) { const meta = JSON.parse(v); plat = (meta && meta.platform) || '?'; } } catch (e) {}
      platforms.push(plat);
    }
    out.push({ id, count: toks.length, platforms });
  }
  return out;
}

const FORM = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px">'
  + '<h2>Push-Test</h2><p>Team-Passwort eingeben:</p>'
  + '<form method="post"><input type="password" name="pw" autofocus style="width:100%;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:8px">'
  + '<button style="margin-top:12px;padding:12px 18px;font-size:16px;border:0;border-radius:8px;background:#0e6072;color:#fff">Test-Push an alle Geräte</button></form></body>';

module.exports = async function handler(req, res) {
  let pw = '';
  if (req.method === 'POST') { const raw = await readRaw(req); pw = new URLSearchParams(raw).get('pw') || ''; }
  if (!TA.verifyPassword(pw)) {
    if (req.method === 'POST') { res.statusCode = 401; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('unauthorized'); }
    res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(FORM);
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const members = await registeredMembers();
  const lines = ['=== Push-Test (alle registrierten Geräte) ===', ''];
  lines.push('Server konfiguriert (hasPush): ' + Push.hasPush);
  lines.push('Apple/APNs aktiv (hasApns): ' + Apns.hasApns);
  lines.push('APNS_ENV: ' + (process.env.APNS_ENV || 'production'));
  lines.push('Firebase/FCM aktiv (FCM_*): ' + !!(process.env.FCM_PROJECT_ID && process.env.FCM_CLIENT_EMAIL && process.env.FCM_PRIVATE_KEY));
  lines.push('');
  if (!members.length) {
    lines.push('>>> Es ist KEIN Push-Token registriert (App hat noch keinen Token geschickt).');
    res.statusCode = 200; return res.end(lines.join('\n'));
  }
  lines.push('Registrierte Mitglieder (' + members.length + '):');
  for (const m of members) {
    let result;
    try { result = await Push.sendToMember(m.id, { title: 'Fit-Inn Trier', body: 'Test-Push – läuft! 🎉', url: 'https://mitglieder.fit-inn-trier.de/mitglieder' }); }
    catch (e) { result = { ok: false, error: String((e && e.message) || e) }; }
    lines.push('  • ID ' + m.id + ' – ' + m.count + ' Token (' + m.platforms.join(', ') + ') → ' + JSON.stringify(result));
  }
  lines.push('', '>>> „ok:true" = von Apple/Google angenommen. Schau aufs jeweilige Gerät.');
  res.statusCode = 200;
  return res.end(lines.join('\n'));
};
