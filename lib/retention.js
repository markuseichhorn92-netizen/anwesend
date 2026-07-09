'use strict';

/**
 * Rückholung / Win-back: Angebots-Rahmen + rechtssichere Angebote.
 * ----------------------------------------------------------------
 * - „Rahmen" = die vom Studio-Inhaber festgelegten Höchstwerte, die die KI beim
 *   Verhandeln NIE überschreiten darf (max. Rabatt %, freie Wochen, Aktivierungs-
 *   gebühr erlassen, Pause). Ein Angebot wird beim Erstellen HART gegen den Rahmen
 *   validiert – über die Grenze geht technisch nichts raus.
 * - „Angebot" = ein konkretes Rückhol-Angebot an ein Mitglied mit eindeutigem
 *   Annahme-Link. Der Kunde nimmt es auf einer eigenen Seite an; wir speichern
 *   Zeitpunkt + IP + User-Agent als Nachweis (Rechtssicherheit).
 *
 * Keys (Upstash KV):
 *   wb:frame                 JSON des Rahmens (einzeln)
 *   wb:oseq                  INCR-Zähler für Angebots-IDs
 *   wb:offer:<id>            JSON des Angebots
 *   wb:offer:tok:<token>     -> <id>  (öffentliche Suche per Token)
 *   wb:offer:idx             ZSET, score = createdAt, member = <id>
 *
 * Grundsatz wie im Bestand: wirft NIE. Ohne Store -> Defaults / keine Persistenz.
 */

const crypto = require('node:crypto');
const { redisPipeline, hasStore } = require('./store');

const FRAME_KEY = 'wb:frame';
const OSEQ = 'wb:oseq';
const OIDX = 'wb:offer:idx';
const oKey = (id) => 'wb:offer:' + id;
const tKey = (tok) => 'wb:offer:tok:' + tok;

const OFFER_TTL_DAYS = 14;

// ── Rahmen ──────────────────────────────────────────────────────────────────
const FRAME_DEFAULT = {
  active: false,          // Rückholung aktiv?
  autopilot: false,       // KI antwortet im Rahmen selbstständig
  maxDiscountPct: 0,      // max. Rabatt in %
  maxDiscountWeeks: 0,    // für so viele Wochen
  maxFreeWeeks: 0,        // max. gratis Trainingswochen
  waiveActivation: false, // Aktivierungsgebühr (39 €) darf erlassen werden
  maxPauseWeeks: 0,       // max. Beitragspause statt Kündigung
  notes: '',              // freie Leitplanken/Ton für die KI
  updatedAt: 0, updatedBy: '',
};
function num(v, max) { let n = Math.floor(Number(v)); if (!isFinite(n) || n < 0) n = 0; if (max != null && n > max) n = max; return n; }

function normalizeFrame(f) {
  f = (f && typeof f === 'object') ? f : {};
  return {
    active: !!f.active,
    autopilot: !!f.autopilot,
    maxDiscountPct: num(f.maxDiscountPct, 100),
    maxDiscountWeeks: num(f.maxDiscountWeeks, 260),
    maxFreeWeeks: num(f.maxFreeWeeks, 52),
    waiveActivation: !!f.waiveActivation,
    maxPauseWeeks: num(f.maxPauseWeeks, 52),
    notes: String(f.notes || '').slice(0, 1200),
    updatedAt: f.updatedAt || 0,
    updatedBy: String(f.updatedBy || '').slice(0, 80),
  };
}
async function getFrame() {
  if (!hasStore) return Object.assign({}, FRAME_DEFAULT);
  let s = null;
  try { [s] = await redisPipeline([['GET', FRAME_KEY]]); } catch (e) {}
  if (!s) return Object.assign({}, FRAME_DEFAULT);
  try { return normalizeFrame(JSON.parse(s)); } catch (e) { return Object.assign({}, FRAME_DEFAULT); }
}
async function setFrame(frame, by) {
  const f = normalizeFrame(frame);
  f.updatedAt = Date.now();
  if (by) f.updatedBy = String(by).slice(0, 80);
  if (hasStore) { try { await redisPipeline([['SET', FRAME_KEY, JSON.stringify(f)]]); } catch (e) {} }
  return f;
}

// ── Angebot gegen den Rahmen prüfen (HARTE Grenze) ──────────────────────────
function normalizeDetails(d) {
  d = (d && typeof d === 'object') ? d : {};
  return {
    discountPct: num(d.discountPct),
    discountWeeks: num(d.discountWeeks),
    freeWeeks: num(d.freeWeeks),
    waiveActivation: !!d.waiveActivation,
    pauseWeeks: num(d.pauseWeeks),
    summary: String(d.summary || '').slice(0, 600),
  };
}
// Liefert { ok, violations:[...] }. ok=false => Angebot überschreitet den Rahmen.
function validateOffer(details, frame) {
  const d = normalizeDetails(details);
  const f = normalizeFrame(frame);
  const v = [];
  if (!f.active) v.push('Rückholung ist nicht aktiviert.');
  if (d.discountPct > f.maxDiscountPct) v.push('Rabatt ' + d.discountPct + '% über dem Rahmen (max ' + f.maxDiscountPct + '%).');
  if (d.discountPct > 0 && d.discountWeeks > f.maxDiscountWeeks) v.push('Rabattdauer ' + d.discountWeeks + ' Wochen über dem Rahmen (max ' + f.maxDiscountWeeks + ').');
  if (d.freeWeeks > f.maxFreeWeeks) v.push('Freie Wochen ' + d.freeWeeks + ' über dem Rahmen (max ' + f.maxFreeWeeks + ').');
  if (d.waiveActivation && !f.waiveActivation) v.push('Aktivierungsgebühr-Erlass ist im Rahmen nicht erlaubt.');
  if (d.pauseWeeks > f.maxPauseWeeks) v.push('Pause ' + d.pauseWeeks + ' Wochen über dem Rahmen (max ' + f.maxPauseWeeks + ').');
  const empty = !d.discountPct && !d.freeWeeks && !d.waiveActivation && !d.pauseWeeks;
  if (empty) v.push('Das Angebot enthält keine Leistung.');
  return { ok: v.length === 0, violations: v, details: d };
}
// Menschlich lesbare Zusammenfassung der Angebotsleistung.
function describeOffer(details) {
  const d = normalizeDetails(details);
  const parts = [];
  if (d.discountPct) parts.push(d.discountPct + '% Rabatt' + (d.discountWeeks ? ' für ' + d.discountWeeks + ' Wochen' : ''));
  if (d.freeWeeks) parts.push(d.freeWeeks + ' Wochen gratis Training');
  if (d.waiveActivation) parts.push('Aktivierungsgebühr (39 €) erlassen');
  if (d.pauseWeeks) parts.push('Beitragspause bis zu ' + d.pauseWeeks + ' Wochen');
  return parts.join(' · ');
}

// ── Angebote anlegen / lesen / annehmen ─────────────────────────────────────
async function createOffer(opts) {
  opts = opts || {};
  const frame = await getFrame();
  const check = validateOffer(opts.details, frame);
  if (!check.ok) return { ok: false, error: 'out_of_frame', violations: check.violations };
  if (!hasStore) return { ok: false, error: 'no_store' };
  let id = 0;
  try { const r = await redisPipeline([['INCR', OSEQ]]); id = (r && r[0]) || 0; } catch (e) {}
  if (!id) return { ok: false, error: 'seq_failed' };
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const offer = {
    id: id, token: token,
    memberId: String(opts.memberId || ''),
    memberName: String(opts.memberName || '').slice(0, 120),
    details: check.details,
    summary: describeOffer(check.details),
    message: String(opts.message || '').slice(0, 2000),
    status: 'sent',
    createdAt: now, createdBy: String(opts.createdBy || '').slice(0, 80),
    expiresAt: now + OFFER_TTL_DAYS * 86400000,
    acceptedAt: 0, acceptIp: '', acceptUa: '', decidedVia: '',
  };
  try {
    await redisPipeline([
      ['SET', oKey(id), JSON.stringify(offer)],
      ['SET', tKey(token), String(id)],
      ['ZADD', OIDX, String(now), String(id)],
    ]);
  } catch (e) { return { ok: false, error: 'store_failed' }; }
  return { ok: true, offer: offer };
}
async function getOffer(id) {
  if (!hasStore || !id) return null;
  let s = null; try { [s] = await redisPipeline([['GET', oKey(id)]]); } catch (e) {}
  if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; }
}
async function getOfferByToken(token) {
  if (!hasStore || !token) return null;
  let id = null; try { [id] = await redisPipeline([['GET', tKey(token)]]); } catch (e) {}
  if (!id) return null;
  return getOffer(id);
}
function isExpired(offer) { return !!(offer && offer.expiresAt && Date.now() > offer.expiresAt); }

// Kunde entscheidet über den Annahme-Link. decision: 'accept' | 'decline'.
async function decideOffer(token, decision, meta) {
  const offer = await getOfferByToken(token);
  if (!offer) return { ok: false, error: 'not_found' };
  if (offer.status === 'accepted') return { ok: true, already: true, offer: offer };
  if (offer.status === 'declined') return { ok: false, error: 'declined', offer: offer };
  if (isExpired(offer)) { offer.status = 'expired'; try { await redisPipeline([['SET', oKey(offer.id), JSON.stringify(offer)]]); } catch (e) {} return { ok: false, error: 'expired', offer: offer }; }
  meta = meta || {};
  offer.status = (decision === 'accept') ? 'accepted' : 'declined';
  offer.acceptedAt = Date.now();
  offer.acceptIp = String(meta.ip || '').slice(0, 60);
  offer.acceptUa = String(meta.ua || '').slice(0, 300);
  offer.decidedVia = 'link';
  try { await redisPipeline([['SET', oKey(offer.id), JSON.stringify(offer)]]); } catch (e) { return { ok: false, error: 'store_failed' }; }
  return { ok: true, offer: offer };
}
async function listOffers(limit) {
  if (!hasStore) return [];
  let ids = []; try { [ids] = await redisPipeline([['ZRANGE', OIDX, '0', '-1']]); } catch (e) {}
  ids = Array.isArray(ids) ? ids.slice(-(limit || 60)).reverse() : [];
  if (!ids.length) return [];
  let res = []; try { res = await redisPipeline(ids.map((id) => ['GET', oKey(id)])); } catch (e) {}
  const out = [];
  (res || []).forEach((s) => { if (s) { try { out.push(JSON.parse(s)); } catch (e) {} } });
  return out;
}

module.exports = {
  getFrame, setFrame, normalizeFrame, FRAME_DEFAULT,
  validateOffer, describeOffer, normalizeDetails,
  createOffer, getOffer, getOfferByToken, decideOffer, listOffers, isExpired,
  OFFER_TTL_DAYS, hasStore,
};
