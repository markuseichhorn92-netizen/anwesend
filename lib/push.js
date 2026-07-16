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
const Apns = require('./apns');

// PEM-Schlüssel robust normalisieren – egal ob er als eine Zeile, mit literal
// "\n", mit echten Umbrüchen oder mit "\r\n" in der Env landet. Verhindert den
// OpenSSL-3-Fehler „DECODER routines::unsupported" (gleiche Logik wie in apns.js).
function normalizePem(raw) {
  let s = String(raw || '').replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  if (!s) return '';
  let header = 'PRIVATE KEY';
  let body;
  const m = s.match(/-----BEGIN ([^-]+)-----([\s\S]*?)-----END [^-]+-----/);
  if (m) { header = m[1].trim(); body = m[2]; } else { body = s; }
  body = body.replace(/\s+/g, '');
  const wrapped = body.match(/.{1,64}/g);
  if (!wrapped) return s;
  return '-----BEGIN ' + header + '-----\n' + wrapped.join('\n') + '\n-----END ' + header + '-----\n';
}

const PROJECT_ID = process.env.FCM_PROJECT_ID || '';
const CLIENT_EMAIL = process.env.FCM_CLIENT_EMAIL || '';
const PRIVATE_KEY = normalizePem(process.env.FCM_PRIVATE_KEY || '');

const hasFcm = !!(PROJECT_ID && CLIENT_EMAIL && PRIVATE_KEY && hasStore);   // Android (+ optional iOS)
const hasPush = hasStore && (hasFcm || Apns.hasApns);                      // Versand möglich?

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Geräte-Token je Mitglied (Upstash) ──
function tokKey(memberId) { return 'push:tok:' + memberId; }
function metaKey(token) { return 'push:meta:' + token; }

async function registerToken(memberId, token, platform) {
  if (!hasStore || !memberId || !token) return false;
  const tok = String(token);
  const newId = String(memberId);

  // Kontowechsel auf demselben Gerät: gehörte der Token vorher einem ANDEREN
  // Mitglied, wird er zuerst aus dessen Zuordnung entfernt – sonst bekäme das
  // alte Konto weiterhin Push-Nachrichten des neuen Nutzers aufs Gerät.
  let prevId = null;
  try {
    const [meta] = await redisPipeline([['GET', metaKey(tok)]]);
    if (meta) { const m = JSON.parse(meta); prevId = m && m.memberId ? String(m.memberId) : null; }
  } catch (e) { /* Meta unlesbar -> wie unbekannter Token behandeln */ }

  const cmds = [];
  if (prevId && prevId !== newId) cmds.push(['SREM', tokKey(prevId), tok]);
  // Falls das Gerät vorher als TEAM-Gerät registriert war (Kontowechsel
  // Team -> Mitglied), auch aus dem Team-Pool entfernen.
  cmds.push(['SREM', TEAM_TOKENS, tok], ['DEL', teamMetaKey(tok)]);
  cmds.push(
    ['SADD', tokKey(newId), tok],
    ['SET', metaKey(tok), JSON.stringify({ memberId: newId, platform: String(platform || ''), at: Date.now() })],
    // Mitglieder-Index: App-Nutzer mit mind. einem Gerät (für Cron/Nudges aufzählbar).
    ['SADD', 'push:members', newId],
  );
  await redisPipeline(cmds);   // ein Pipeline-Aufruf: alte Zuordnungen raus + neue rein

  // Index-Pflege fürs vorherige Mitglied (best effort).
  if (prevId && prevId !== newId) {
    try {
      const [rest] = await redisPipeline([['SMEMBERS', tokKey(prevId)]]);
      if (!Array.isArray(rest) || rest.length === 0) {
        await redisPipeline([['SREM', 'push:members', prevId]]);
      }
    } catch (e) { /* optional */ }
  }
  return true;
}
async function unregisterToken(memberId, token) {
  if (!hasStore || !token) return false;
  const cmds = [['DEL', metaKey(token)]];
  if (memberId) cmds.unshift(['SREM', tokKey(memberId), String(token)]);
  await redisPipeline(cmds);
  // Best-effort Pruning: hat das Mitglied keine Tokens mehr, aus dem Index nehmen.
  if (memberId) {
    try {
      const [rest] = await redisPipeline([['SMEMBERS', tokKey(memberId)]]);
      if (!Array.isArray(rest) || rest.length === 0) {
        await redisPipeline([['SREM', 'push:members', String(memberId)]]);
      }
    } catch (e) { /* Index-Pflege ist optional, Fehler ignorieren */ }
  }
  return true;
}
// Alle App-Nutzer mit mind. einem registrierten Gerät (Mitglieder-IDs als Strings).
async function allPushMembers() {
  if (!hasStore) return [];
  try {
    const [list] = await redisPipeline([['SMEMBERS', 'push:members']]);
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}
async function tokensFor(memberId) {
  if (!hasStore || !memberId) return [];
  const [list] = await redisPipeline([['SMEMBERS', tokKey(memberId)]]);
  return Array.isArray(list) ? list : [];
}
async function platformOf(token) {
  try { const [v] = await redisPipeline([['GET', metaKey(token)]]); if (v) { const m = JSON.parse(v); return (m && m.platform) || ''; } } catch (e) {}
  return '';
}

// ── Geräte-Token des Studio-Teams (gemeinsamer Pool, App-weit) ──
// Anders als bei Mitgliedern gibt es keine Einzel-ID: alle angemeldeten
// Team-Geräte teilen sich einen Set, sodass eine Mitglieder-Nachricht das
// ganze Team erreicht. Meta hält Plattform + wer (nur zur Diagnose).
const TEAM_TOKENS = 'push:team:tokens';
function teamMetaKey(token) { return 'push:team:meta:' + token; }

async function registerTeamToken(token, platform, who) {
  if (!hasStore || !token) return false;
  const tok = String(token);
  // Kontowechsel Mitglied -> Team auf demselben Gerät: alte Mitglieds-Zuordnung
  // zuerst lösen, damit keine Mitglieder-Pushs mehr auf dem Team-Gerät landen.
  let prevMember = null;
  try {
    const [meta] = await redisPipeline([['GET', metaKey(tok)]]);
    if (meta) { const m = JSON.parse(meta); prevMember = m && m.memberId ? String(m.memberId) : null; }
  } catch (e) {}
  const cmds = [];
  if (prevMember) cmds.push(['SREM', tokKey(prevMember), tok], ['DEL', metaKey(tok)]);
  cmds.push(
    ['SADD', TEAM_TOKENS, tok],
    ['SET', teamMetaKey(tok), JSON.stringify({ platform: String(platform || ''), who: String(who || '').slice(0, 80), at: Date.now() })],
  );
  await redisPipeline(cmds);
  if (prevMember) {
    try {
      const [rest] = await redisPipeline([['SMEMBERS', tokKey(prevMember)]]);
      if (!Array.isArray(rest) || rest.length === 0) await redisPipeline([['SREM', 'push:members', prevMember]]);
    } catch (e) { /* optional */ }
  }
  return true;
}
async function unregisterTeamToken(token) {
  if (!hasStore || !token) return false;
  await redisPipeline([['SREM', TEAM_TOKENS, String(token)], ['DEL', teamMetaKey(token)]]);
  return true;
}
async function teamTokens() {
  if (!hasStore) return [];
  try { const [l] = await redisPipeline([['SMEMBERS', TEAM_TOKENS]]); return Array.isArray(l) ? l : []; }
  catch (e) { return []; }
}
async function teamPlatformOf(token) {
  try { const [v] = await redisPipeline([['GET', teamMetaKey(token)]]); if (v) { const m = JSON.parse(v); return (m && m.platform) || ''; } } catch (e) {}
  return '';
}
// Push an ALLE registrierten Team-Geräte. Tote Tokens (404/410) werden entfernt.
async function sendToTeam(msg) {
  if (!hasPush) return { ok: false, error: 'no_push' };
  const tokens = await teamTokens();
  if (!tokens.length) return { ok: false, error: 'no_tokens' };
  let accessToken = null;
  const results = [];
  for (const tk of tokens) {
    const plat = await teamPlatformOf(tk);
    let res;
    if (plat === 'ios' && Apns.hasApns) {
      try { res = await Apns.sendOne(tk, msg || {}); } catch (e) { res = { ok: false, status: 0, error: e.message }; }
      if (res.status === 410 || res.status === 400) { try { await unregisterTeamToken(tk); } catch (e) {} }
    } else if (hasFcm) {
      try { if (!accessToken) accessToken = await googleAccessToken(); res = await sendToToken(accessToken, tk, msg || {}); } catch (e) { res = { ok: false, status: 0, error: e.message }; }
      if (res.status === 404) { try { await unregisterTeamToken(tk); } catch (e) {} }
    } else {
      res = { ok: false, status: 0, error: 'no_route(plat=' + (plat || '?') + ')' };
    }
    results.push({ ok: !!res.ok, status: res.status || 0 });
  }
  return { ok: results.some((r) => r.ok), sent: results.filter((r) => r.ok).length, results: results };
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
  let accessToken = null;
  const results = [];
  for (const tk of tokens) {
    const plat = await platformOf(tk);
    let res;
    if (plat === 'ios' && Apns.hasApns) {
      // iOS -> Apple Push direkt
      try { res = await Apns.sendOne(tk, msg || {}); } catch (e) { res = { ok: false, status: 0, error: e.message }; }
      if (res.status === 410 || res.status === 400) { try { await unregisterToken(memberId, tk); } catch (e) {} }
    } else if (hasFcm) {
      // Android (oder unbekannt) -> FCM
      try { if (!accessToken) accessToken = await googleAccessToken(); res = await sendToToken(accessToken, tk, msg || {}); } catch (e) { res = { ok: false, status: 0, error: e.message }; }
      if (res.status === 404) { try { await unregisterToken(memberId, tk); } catch (e) {} }
    } else {
      res = { ok: false, status: 0, error: 'no_route(plat=' + (plat || '?') + ')' };
    }
    const entry = { ok: !!res.ok, status: res.status || 0 };
    if (res.error) entry.error = res.error;
    if (res.body) entry.body = res.body;
    results.push(entry);
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

module.exports = {
  hasPush, registerToken, unregisterToken, tokensFor, sendToMember, notifyMember, allPushMembers,
  registerTeamToken, unregisterTeamToken, teamTokens, sendToTeam,
};
