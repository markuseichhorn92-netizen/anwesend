'use strict';

/**
 * Zugangsmedien (Chip / Karte / Band) eines Kunden – Magicline Open API.
 * ---------------------------------------------------------------------
 * 403-feste Wrapper (Scope CUSTOMER_ACCESS_MEDIUM_WRITE bzw. das passende
 * READ-Pendant). Werfen NIE.
 *
 * WICHTIG – ANNAHME (nicht sicher verifiziert):
 *   Liste:     GET  /v1/customers/{id}/access-media        (bzw. /accessmedia)
 *   Sperren:   POST /v1/customers/{id}/access-media/{mid}/block
 *   Entsperren:POST /v1/customers/{id}/access-media/{mid}/unblock
 *   Ausgeben:  POST /v1/customers/{id}/access-media         { number?, type? }
 *
 * Die exakten Endpunkte und Feldnamen sind UNSICHER. Daher wird NICHT geraten,
 * sondern die plausibelsten Pfade werden versucht und bei 403/404/Fehler/unbe-
 * kannter Antwort degradiert: Lesen -> { available:false }, Schreiben ->
 * { ok:false, forbidden } (der Handler fällt dann auf einen Inbox-Vorgang +
 * Studio-Mail zurück, der Wunsch geht also nie verloren). Es wird NIE geworfen
 * und NIE gecrasht. Feldnamen werden robust normalisiert (id, Nummer/Label,
 * Status aktiv/gesperrt, Typ Chip/Karte/Band).
 */

const M = require('./members');

// Plausibelste Basis-Pfade für die Zugangsmedien eines Kunden (mehrere Schreib-
// weisen, da der exakte Endpunkt unsicher ist). Reihenfolge = Priorität.
function bases(cid) {
  const c = encodeURIComponent(cid);
  return [
    '/customers/' + c + '/access-media',
    '/customers/' + c + '/accessmedia',
  ];
}

// Antwort-Body robust auf ein Array bringen (Liste kann direkt ein Array sein
// oder unter result/items/accessMedia/content/data hängen). Sonst null.
function toArray(j) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return null;
  const cand = j.result || j.items || j.accessMedia || j.accessMedium || j.media || j.content || j.data;
  return Array.isArray(cand) ? cand : null;
}

// id robust ziehen (id/mediumId/accessMediumId/uuid/number/chipId).
function pickId(m) {
  return m.id != null ? m.id
    : (m.mediumId != null ? m.mediumId
    : (m.accessMediumId != null ? m.accessMediumId
    : (m.uuid != null ? m.uuid
    : (m.chipId != null ? m.chipId
    : (m.number != null ? m.number
    : (m.serialNumber != null ? m.serialNumber : null))))));
}

// Anzeige-Label robust ziehen (Nummer/Name/Kennung).
function pickLabel(m) {
  const v = m.number || m.mediumNumber || m.chipNumber || m.serialNumber
    || m.label || m.name || m.identifier || m.code || (m.id != null ? m.id : null);
  return String(v == null ? 'Zugangsmedium' : v);
}

// Typ robust ziehen (Chip/Karte/Band); leer -> null.
function pickType(m) {
  const t = m.type || m.mediumType || m.kind || m.deviceType || m.category || null;
  return t ? String(t) : null;
}

// Status auf 'aktiv' | 'gesperrt' normalisieren – robust über Flags und Statustext.
function pickStatus(m) {
  if (m.blocked === true || m.locked === true || m.isBlocked === true || m.disabled === true) return 'gesperrt';
  if (m.active === false || m.enabled === false || m.valid === false) return 'gesperrt';
  const st = String(m.status || m.state || m.mediumStatus || '').toUpperCase();
  if (/BLOCK|LOCK|SPERR|INACTIVE|DISABLED|DEACTIV|INVALID/.test(st)) return 'gesperrt';
  return 'aktiv';   // Default: aktiv (unbekannte/positive Zustände)
}

// Ein Roh-Zugangsmedium auf ein schlankes, stabiles Objekt eindampfen.
function normItem(m) {
  m = m || {};
  const out = { id: pickId(m), label: pickLabel(m), status: pickStatus(m) };
  const type = pickType(m);
  if (type) out.type = type;
  return out;
}

// ── Liste der Zugangsmedien ──
// -> { available:true, items:[{id,label,status,type?}] } | { available:false }
async function listAccessMedia(customerId) {
  const paths = bases(customerId);
  for (let i = 0; i < paths.length; i++) {
    let r;
    try { r = await M.ml('GET', paths[i]); } catch (e) { continue; }
    if (!r) continue;
    if (r.status === 401 || r.status === 403) return { available: false };   // Scope fehlt -> ausblenden
    if (r.status === 200) {
      const arr = toArray(r.json);
      if (!arr) return { available: false };                                 // unbekannte Form -> degradieren
      const items = arr.map(normItem).filter(function (x) { return x.id != null; });
      return { available: true, items: items };
    }
    // 404/anderes -> nächsten Kandidaten-Pfad versuchen
  }
  return { available: false };
}

// Mehrere Schreib-Versuche der Reihe nach: erster 2xx -> ok. 401/403 -> forbidden
// (Scope fehlt, weitere Versuche zwecklos). 404 -> nächster Pfad. Wirft nie.
async function tryWrite(attempts) {
  let forbidden = false, lastStatus = 0, lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    let r;
    try { r = await M.ml(a.method || 'POST', a.path, a.body); }
    catch (e) { lastErr = String((e && e.message) || e).slice(0, 200); continue; }
    if (!r) continue;
    if (r.status >= 200 && r.status < 300) return { ok: true, forbidden: false, status: r.status, error: null };
    if (r.status === 401 || r.status === 403) {
      forbidden = true; lastStatus = r.status;
      lastErr = (r.text ? String(r.text).slice(0, 200) : 'forbidden');
      break;
    }
    lastStatus = r.status;
    lastErr = (r.text ? String(r.text).slice(0, 200) : ('status_' + r.status));
    // 404/anderes -> nächsten Kandidaten-Pfad versuchen
  }
  return { ok: false, forbidden: forbidden, status: lastStatus, error: lastErr || 'failed' };
}

// ── Zugangsmedium sperren ──  -> { ok, forbidden, status, error }
async function blockAccessMedium(customerId, mediumId) {
  const c = encodeURIComponent(customerId), m = encodeURIComponent(mediumId);
  return tryWrite([
    { method: 'POST', path: '/customers/' + c + '/access-media/' + m + '/block', body: {} },
    { method: 'POST', path: '/customers/' + c + '/accessmedia/' + m + '/block', body: {} },
    { method: 'PUT', path: '/customers/' + c + '/access-media/' + m + '/status', body: { status: 'BLOCKED' } },
  ]);
}

// ── Zugangsmedium entsperren ──  -> { ok, forbidden, status, error }
async function unblockAccessMedium(customerId, mediumId) {
  const c = encodeURIComponent(customerId), m = encodeURIComponent(mediumId);
  return tryWrite([
    { method: 'POST', path: '/customers/' + c + '/access-media/' + m + '/unblock', body: {} },
    { method: 'POST', path: '/customers/' + c + '/accessmedia/' + m + '/unblock', body: {} },
    { method: 'PUT', path: '/customers/' + c + '/access-media/' + m + '/status', body: { status: 'ACTIVE' } },
  ]);
}

// ── Neues Zugangsmedium ausgeben ──  -> { ok, forbidden, status, error }
// opts: { number?, type? }  (beide optional; das Studio kann die Nummer auch selbst vergeben)
async function issueAccessMedium(customerId, opts) {
  opts = opts || {};
  const c = encodeURIComponent(customerId);
  const body = {};
  if (opts.number != null && String(opts.number).trim() !== '') body.number = String(opts.number).trim();
  if (opts.type != null && String(opts.type).trim() !== '') body.type = String(opts.type).trim();
  return tryWrite([
    { method: 'POST', path: '/customers/' + c + '/access-media', body: body },
    { method: 'POST', path: '/customers/' + c + '/accessmedia', body: body },
  ]);
}

module.exports = { listAccessMedia, blockAccessMedium, unblockAccessMedium, issueAccessMedium };
