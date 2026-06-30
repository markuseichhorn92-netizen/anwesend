'use strict';

/**
 * Push-Benachrichtigungen für die eigene App (Capacitor) – über Firebase Cloud
 * Messaging (FCM HTTP v1). EIN Sende-Weg für iOS UND Android: Firebase stellt
 * iOS-Pushes über deinen bei Firebase hinterlegten APNs-Schlüssel zu, sodass wir
 * serverseitig nur die FCM-API ansprechen müssen (reines HTTPS, kein HTTP/2).
 *
 * Nur node:crypto + fetch, keine Dependency. „Schläft" (hasPush=false), bis ein
 * Firebase-Service-Account konfiguriert ist – die App läuft also unverändert weiter,
 * solange Push noch nicht eingerichtet wurde.
 *
 * Env (aus der Service-Account-JSON, Firebase Console → Projekteinstellungen →
 * Dienstkonten → „Neuen privaten Schlüssel generieren"):
 *   FCM_PROJECT_ID    -> Feld "project_id"
 *   FCM_CLIENT_EMAIL  -> Feld "client_email"
 *   FCM_PRIVATE_KEY   -> Feld "private_key" (mehrzeilig; in Vercel als ein Wert
 *                        einfügen – literal "\n" werden hier in echte Zeilenumbrüche
 *                        zurückübersetzt).
 */

const crypto = require('node:crypto');
const { hasStore, redisPipeline } = require('./store');

const PROJECT_ID = process.env.FCM_PROJECT_ID || '';
const CLIENT_EMAIL = process.env.FCM_CLIENT_EMAIL || '';
const PRIVATE_KEY = (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const hasPush = !!(PROJECT_ID && CLIENT_EMAIL && PRIVATE_KEY && hasStore);

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Geräte-Token je Mitglied (Upstash) ──
function tokKey(memberId) { return 'push:tok:' + memberId; }
function metaKey(token) { return 'push:meta:' + token; }

async function registerToken(memberId, token, platform) {
  if (!hasStore || !memberId || !token) return false;
  await redisPipeline([
    ['SADD', tokKey(memberId), String(token)],
    ['SET', metaKey(token), JSON.stringify({ memberId: String(memberId), platform: String(platform || ''), at: Date.now() })],
  ]);
  return true;
}
async function unregisterToken(memberId, token) {
  if (!hasStore || !token) return false;
  const cmds = [['DEL', metaKey(token)]];
  if (memberId) cmds.unshift(['SREM', tokKey(memberId), String(token)]);
  await redisPipeline(cmds);
  return true;
}
async function tokensFor(memberId) {
  if (!hasStore || !memberId) return [];
  const [list] = await redisPipeline([['SMEMBERS', tokKey(memberId)]]);
  return Array.isArray(list) ? list : [];
}

// ── Google-OAuth2-Access-Token (für FCM v1), zwischengespeichert in Upstash ──
async function googleAccessToken() {
  const [cached] = await redisPipeline([['GET', 'push:gtoken']]);
  if (cached) return cached;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signature = b64url(crypto.createSign('RSA-SHA256').update(header + '.' + claim).sign(PRIVATE_KEY));
  const jwt = header + '.' + claim + '.' + signature;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('oauth_failed:' + r.status);
  const ttl = Math.max(60, (j.expires_in || 3600) - 60);
  await redisPipeline([['SET', 'push:gtoken', j.access_token, 'EX', String(ttl)]]);
  return j.access_token;
}

async function sendToToken(accessToken, token, msg) {
  const message = { token: token };
  if (msg.title || msg.body) message.notification = { title: String(msg.title || ''), body: String(msg.body || '') };
  const data = {};
  if (msg.url) data.url = String(msg.url);
  if (msg.data) Object.keys(msg.data).forEach((k) => { data[k] = String(msg.data[k]); });
  if (Object.keys(data).length) message.data = data;
  message.android = { notification: { sound: 'default' } };
  message.apns = { payload: { aps: { sound: 'default' } } };
  const r = await fetch('https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(PROJECT_ID) + '/messages:send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message }),
  });
  const t = await r.text().catch(() => '');
  return { ok: r.ok, status: r.status, body: t.slice(0, 300) };
}

// Push an alle Geräte eines Mitglieds. Abgemeldete Tokens (404) werden entfernt.
// Liefert { ok, sent, results } oder { ok:false, error }.
async function sendToMember(memberId, msg) {
  if (!hasPush) return { ok: false, error: 'no_push' };
  const tokens = await tokensFor(memberId);
  if (!tokens.length) return { ok: false, error: 'no_tokens' };
  let accessToken;
  try { accessToken = await googleAccessToken(); } catch (e) { return { ok: false, error: e.message }; }
  const results = [];
  for (const tk of tokens) {
    let res;
    try { res = await sendToToken(accessToken, tk, msg || {}); } catch (e) { res = { ok: false, error: e.message }; }
    if (res.status === 404) { try { await unregisterToken(memberId, tk); } catch (e) {} }
    results.push({ ok: !!res.ok, status: res.status || 0 });
  }
  return { ok: results.some((r) => r.ok), sent: results.filter((r) => r.ok).length, results: results };
}

// Push an ein Mitglied UNTER Beachtung seiner Einstellungen.
// category: 'pushPostfach' | 'pushTermin' | 'pushKonto' | 'pushNews' (optional).
// Sendet nur, wenn Hauptschalter (push) und die jeweilige Kategorie an sind.
async function notifyMember(memberId, category, msg) {
  if (!hasPush) return { ok: false, error: 'no_push' };
  try {
    const Prefs = require('./prefs');
    const p = await Prefs.getPrefs(memberId);
    if (p.push === false) return { ok: false, error: 'push_off' };
    if (category && p[category] === false) return { ok: false, error: 'category_off' };
  } catch (e) {}
  return sendToMember(memberId, msg || {});
}

module.exports = { hasPush, registerToken, unregisterToken, tokensFor, sendToMember, notifyMember };
