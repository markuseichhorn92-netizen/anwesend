'use strict';

/**
 * Team-Backend-Authentifizierung.
 * --------------------------------
 * Einfaches, sicheres Login fürs Studio-Team: ein gemeinsames Passwort
 * (Env-Var TEAM_PASSWORD) -> serverseitige Session (KV, wie bei Mitgliedern).
 * Token nur per Bearer-Header; Session in KV (revozierbar, Ablauf 12 h).
 *
 * Bewusst kein Passwort im Code/Repo (öffentlich!) — nur als Env-Var.
 * Wird später auf Einzel-Accounts erweitert; die Schnittstelle bleibt gleich.
 */

const crypto = require('node:crypto');
const { redisPipeline, hasStore } = require('./store');

const PASSWORD = process.env.TEAM_PASSWORD || '';
const TTL = parseInt(process.env.TEAM_SESSION_TTL || '', 10) || (60 * 60 * 12);   // 12 h

const hasTeamAuth = !!PASSWORD && hasStore;

function safeEqual(a, b) {
  try {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch (e) { return false; }
}

function verifyPassword(pw) {
  return !!PASSWORD && safeEqual(pw, PASSWORD);
}

// user: Identitäts-Objekt ODER String (rückwärtskompatibel).
//   Objekt -> so speichern (plus at);  String -> { user:<string>, at } (wie bisher).
async function createSession(user, ttlSec) {
  if (!hasStore) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const ttl = (ttlSec && ttlSec > 0) ? Math.floor(ttlSec) : TTL;
  const ident = (user && typeof user === 'object')
    ? Object.assign({}, user, { at: Date.now() })
    : { user: user || 'team', at: Date.now() };
  await redisPipeline([['SET', 'tsess:' + token, JSON.stringify(ident), 'EX', String(ttl)]]);
  return token;
}

async function getSession(token) {
  if (!token || !hasStore) return null;
  const [v] = await redisPipeline([['GET', 'tsess:' + token]]);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}

async function destroySession(token) {
  if (!token || !hasStore) return;
  try { await redisPipeline([['DEL', 'tsess:' + token]]); } catch (e) {}
}

function bearer(req) {
  const a = req.headers['authorization'] || '';
  return a.replace(/^Bearer\s+/i, '').trim() || null;
}

// Bequemer Guard: liefert die Team-Session oder null.
async function requireTeam(req) {
  return getSession(bearer(req));
}

// Rolle einer Session bestimmen. Angestellte (Trainer-Login) tragen immer
// role:'trainer'; der Passwort-Login setzt role:'admin'. Alt-/Passwort-Sessions
// ohne role-Feld gelten bewusst als Admin (nur der Passwort-Weg konnte je
// role-lose Sessions erzeugen) – so verliert niemand mitten in der 12-h-Sitzung
// seine Rechte, während echte Trainer nie versehentlich Admin werden.
function roleOf(sess) {
  if (!sess) return null;
  return sess.role || 'admin';
}
function isAdmin(sess) { return roleOf(sess) === 'admin'; }

module.exports = {
  hasTeamAuth, verifyPassword, createSession, getSession, destroySession,
  bearer, requireTeam, roleOf, isAdmin, TTL,
};
