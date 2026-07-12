'use strict';

/**
 * Aktions-Links (Team → Mitglied): geburtsdatum-gesicherter Auto-Login-Deeplink.
 * ------------------------------------------------------------------------------
 * Das Team erzeugt für ein Mitglied einen Link zu einer konkreten Selbst-Service-
 * Aktion (Zahlungsdaten, Adresse, Vertrag, Pause, Kündigung, Dokumente). Öffnet
 * das Mitglied den Link, fragt das Portal EINMAL das Geburtsdatum ab; stimmt es,
 * wird eine echte Mitglieder-Sitzung geprägt und direkt zur Aktion navigiert.
 *
 * Sicherheit:
 *  - Token = crypto.randomBytes(24) hex (48 Zeichen, hohe Entropie).
 *  - Geburtsdatum als zweiter Faktor: der Link allein reicht nicht.
 *  - Max. MAX_ATTEMPTS Fehlversuche pro Token, danach wird er gelöscht.
 *  - Einmal-Nutzung: nach erfolgreichem Login wird der Token verbraucht (DEL).
 *  - Ablauf nach ACTION_LINK_TTL_DAYS (Redis EX + expliziter exp-Check).
 *  - Bewusst getrennt vom bestehenden `?mlt=`-Flow (login-magic.js), der ohne
 *    Geburtsdatum auto-einloggt und von ~18 E-Mail-Flows genutzt wird.
 *
 * KV-Key:  alink:<token>  ->  { id, action, screen, sub, exp, attempts, createdAt, createdBy }
 * Grundsatz wie im Bestand: wirft nie nach außen; ohne Store keine Persistenz.
 */

const crypto = require('node:crypto');
const M = require('./members');
const { redisPipeline, hasStore } = require('./store');

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://mitglieder.fit-inn-trier.de').replace(/\/+$/, '');
const TTL_DAYS = Math.max(1, parseInt(process.env.ACTION_LINK_TTL_DAYS, 10) || 7);
const TTL_SEC = TTL_DAYS * 86400;
const MAX_ATTEMPTS = 5;

// Aktion → Ziel-Screen im Portal (+ optionaler Sub-Flow, den der Boot-Code öffnet).
const ACTIONS = {
  payment:   { label: 'Zahlungsdaten & Bankverbindung ändern', screen: 'data',     sub: 'iban' },
  address:   { label: 'Adresse & Kontaktdaten ändern',         screen: 'data',     sub: '' },
  contract:  { label: 'Vertrag ansehen',                       screen: 'contract', sub: '' },
  pause:     { label: 'Mitgliedschaft pausieren',              screen: 'contract', sub: 'pause' },
  cancel:    { label: 'Mitgliedschaft kündigen',               screen: 'contract', sub: 'cancel' },
  documents: { label: 'Dokumente ansehen & hochladen',         screen: 'contract', sub: 'docs' },
};
function actionMeta(a) { return ACTIONS[a] || null; }

const key = (t) => 'alink:' + t;

async function save(token, rec, ttlSec) {
  try { await redisPipeline([['SET', key(token), JSON.stringify(rec), 'EX', String(Math.max(1, Math.floor(ttlSec)))]]); return true; }
  catch (e) { return false; }
}
async function get(token) {
  if (!token || !hasStore) return null;
  let v = null; try { [v] = await redisPipeline([['GET', key(token)]]); } catch (e) {}
  if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; }
}
async function del(token) { if (hasStore) { try { await redisPipeline([['DEL', key(token)]]); } catch (e) {} } }

// Team erzeugt einen Link. Liefert { ok, token, url, action, label, expiresAt }.
async function create(opts) {
  opts = opts || {};
  const meta = actionMeta(opts.action);
  if (!meta) return { ok: false, error: 'bad_action' };
  const id = String(opts.memberId || '').trim();
  if (!id) return { ok: false, error: 'no_member' };
  if (!hasStore) return { ok: false, error: 'no_store' };
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const rec = {
    id: id, action: opts.action, screen: meta.screen, sub: meta.sub,
    exp: now + TTL_SEC * 1000, attempts: 0,
    createdAt: now, createdBy: String(opts.createdBy || '').slice(0, 80),
  };
  if (!(await save(token, rec, TTL_SEC))) return { ok: false, error: 'store_failed' };
  return { ok: true, token: token, url: PUBLIC_BASE + '/mitglieder?alt=' + token, action: opts.action, label: meta.label, expiresAt: rec.exp };
}

// Öffentliche Vorschau (kein PII): nur ob gültig + welche Aktion, für die Bestätigungsseite.
async function peek(token) {
  const rec = await get(token);
  if (!rec) return { ok: false, error: 'not_found' };
  if (rec.exp && Date.now() > rec.exp) { await del(token); return { ok: false, error: 'expired' }; }
  const meta = actionMeta(rec.action) || {};
  return { ok: true, action: rec.action, label: meta.label || '' };
}

// Geburtsdatum prüfen und – bei Treffer – eine Mitglieder-Sitzung prägen.
// Liefert { ok, token(session), screen, sub, memberId } | { ok:false, error, attemptsLeft }.
async function verify(token, birthdate) {
  const rec = await get(token);
  if (!rec) return { ok: false, error: 'not_found' };
  if (rec.exp && Date.now() > rec.exp) { await del(token); return { ok: false, error: 'expired' }; }
  if ((rec.attempts || 0) >= MAX_ATTEMPTS) { await del(token); return { ok: false, error: 'locked', attemptsLeft: 0 }; }

  let member = null; try { member = await M.getMember(rec.id); } catch (e) {}
  const want = member ? M.isoDate(member.dateOfBirth) : '';
  const got = M.isoDate(birthdate);
  if (!want || !got || want !== got) {
    rec.attempts = (rec.attempts || 0) + 1;
    if (rec.attempts >= MAX_ATTEMPTS) { await del(token); return { ok: false, error: 'locked', attemptsLeft: 0 }; }
    const ttl = Math.max(1, Math.floor((rec.exp - Date.now()) / 1000));
    await save(token, rec, ttl);   // Restlaufzeit beibehalten
    return { ok: false, error: 'birthdate', attemptsLeft: Math.max(0, MAX_ATTEMPTS - rec.attempts) };
  }

  await del(token);                                       // Einmal-Nutzung: Token verbrauchen
  let session = null;
  try { session = await M.createSession(rec.id, 2592000); } catch (e) {}   // 30 Tage (wie „Angemeldet bleiben")
  if (!session) return { ok: false, error: 'session_failed' };
  const meta = actionMeta(rec.action) || {};
  return { ok: true, token: session, memberId: rec.id, screen: rec.screen || meta.screen || 'home', sub: rec.sub || meta.sub || '' };
}

module.exports = {
  create, peek, verify, actionMeta, ACTIONS,
  TTL_DAYS, MAX_ATTEMPTS, PUBLIC_BASE, hasStore,
};
