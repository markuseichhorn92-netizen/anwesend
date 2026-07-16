'use strict';

/**
 * /api/admin/off-warmup   — 1-Klick-Katalog-Vorbefüllung (Betreiber-only).
 * -------------------------------------------------------------------------
 * Lädt die meistgescannten Deutschland-Produkte (nach unique_scans_n) über die
 * öffentliche Open-Food-Facts-Suche in den Produktkatalog (Upstash). Damit trifft
 * nach dem Launch fast jeder reale Scan lokal, ohne live viele OFF-Aufrufe.
 *
 * Timeout-sicher: pro Aufruf genau EINE OFF-Suchseite (100 Produkte), gebündelt
 * geschrieben. Die HTML-Antwort lädt sich per Meta-Refresh selbst weiter, bis das
 * Ziel erreicht ist – so genügt EIN Link-Aufruf; der Fortschritt läuft von selbst.
 *
 * Schutz (wie seed.js/nudge.js): Secret aus OFF_WARMUP_KEY | SEED_SECRET |
 * RECORD_SECRET, als ?key=… / ?secret=… oder Bearer. Ohne gesetztes Secret: 503.
 *
 * Aufruf:  /api/admin/off-warmup?key=<SECRET>[&limit=1000][&reset=1][&format=json]
 * Cursor liegt in Upstash (off:warmup:page / :kept) – fortsetzbar & idempotent.
 * Doku/Lizenz: docs/OPEN-FOOD-FACTS.md (ODbL).
 */

const OFF = require('../../lib/openFoodFacts');
const Catalog = require('../../lib/foodCatalog');
const { redisPipeline, hasStore } = require('../../lib/store');

const PAGE_SIZE = 100;
const REFRESH_SEC = 7;          // OFF-Suchlimit (10/min) schonen: 1 Suche / ~7 s
const COUNTRY_TAG = { de: 'germany', at: 'austria', ch: 'switzerland' };
const KEY_PAGE = 'off:warmup:page';
const KEY_KEPT = 'off:warmup:kept';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

async function fetchPage(page, countryTag) {
  const url = OFF.BASE + '/cgi/search.pl?action=process&json=1&sort_by=unique_scans_n'
    + '&page_size=' + PAGE_SIZE + '&page=' + page
    + '&tagtype_0=countries&tag_contains_0=contains&tag_0=' + encodeURIComponent(countryTag)
    + '&fields=' + OFF.PRODUCT_FIELDS;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 8000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': OFF.USER_AGENT, Accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status };
    const j = await res.json();
    return { ok: true, products: Array.isArray(j.products) ? j.products : [] };
  } catch (e) { clearTimeout(timer); return { ok: false, error: (e && e.name) || 'network' }; }
}

function page_(title, bodyHtml, refreshUrl) {
  const meta = refreshUrl ? '<meta http-equiv="refresh" content="' + REFRESH_SEC + ';url=' + esc(refreshUrl) + '">' : '';
  return '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + '</title>' + meta
    + '<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a4958;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center}'
    + '.c{max-width:460px;padding:34px 26px;text-align:center}.big{font-size:44px;font-weight:900;letter-spacing:-1px;margin:8px 0}'
    + '.bar{height:12px;border-radius:8px;background:rgba(255,255,255,.15);overflow:hidden;margin:18px 0 8px}.fill{height:100%;background:#7fe3a8;border-radius:8px}'
    + 'a.btn{display:inline-block;margin-top:18px;background:#fff;color:#0a4958;font-weight:800;text-decoration:none;padding:13px 22px;border-radius:14px}'
    + '.muted{color:#aed0d6;font-weight:600;font-size:14px;line-height:1.5}</style></head><body><div class="c">' + bodyHtml + '</div></body></html>';
}

module.exports = async function handler(req, res) {
  const SECRET = process.env.OFF_WARMUP_KEY || process.env.SEED_SECRET || process.env.RECORD_SECRET || '';
  const u = new URL(req.url, 'http://localhost');
  const wantJson = u.searchParams.get('format') === 'json';
  const send = function (status, html) { res.statusCode = status; res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(html); };
  const sendJson = function (status, obj) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };

  // ── Auth ── Secret verpflichtend, AUSSCHLIESSLICH per Authorization-Header
  // (Query-Parameter landen in Logs/Historie und werden nicht mehr akzeptiert).
  if (!SECRET) { return wantJson ? sendJson(503, { ok: false, error: 'not_configured' }) : send(503, page_('Warmup', '<div class="big">🔒</div><div class="muted">Nicht eingerichtet: bitte <b>OFF_WARMUP_KEY</b> als Environment-Variable setzen.</div>')); }
  const provided = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!provided || !require('../../lib/cronAuth').safeEqual(provided, SECRET)) { return wantJson ? sendJson(401, { ok: false, error: 'unauthorized' }) : send(401, page_('Warmup', '<div class="big">⛔</div><div class="muted">Falscher oder fehlender Schlüssel (Authorization: Bearer &lt;key&gt;).</div>')); }

  if (!hasStore) { return wantJson ? sendJson(503, { ok: false, error: 'no_store' }) : send(503, page_('Warmup', '<div class="big">⚠️</div><div class="muted">Kein Speicher (Upstash/KV) verbunden.</div>')); }
  if (!OFF.hasContact) { return wantJson ? sendJson(503, { ok: false, error: 'no_contact' }) : send(503, page_('Warmup', '<div class="big">✉️</div><div class="muted">Bitte <b>OPENFOODFACTS_CONTACT_EMAIL</b> setzen (echte Adresse).</div>')); }

  const country = String(u.searchParams.get('country') || 'de').toLowerCase();
  const countryTag = COUNTRY_TAG[country] || country;
  const target = Math.max(PAGE_SIZE, Math.min(3000, parseInt(u.searchParams.get('limit'), 10) || 1000));
  const selfUrl = '/api/admin/off-warmup?key=' + encodeURIComponent(provided) + '&limit=' + target + '&country=' + encodeURIComponent(country);

  // ── Reset ──
  if (u.searchParams.get('reset') === '1') {
    try { await redisPipeline([['DEL', KEY_PAGE], ['DEL', KEY_KEPT]]); } catch (e) {}
    return wantJson ? sendJson(200, { ok: true, reset: true }) : send(200, page_('Warmup', '<div class="big">↺</div><div class="muted">Zurückgesetzt.</div><a class="btn" href="' + esc(selfUrl) + '">Jetzt starten</a>'));
  }

  // ── Cursor lesen (ein Roundtrip) ──
  let page = 1, kept = 0;
  try { const r = await redisPipeline([['GET', KEY_PAGE], ['GET', KEY_KEPT]]); if (r[0]) page = parseInt(r[0], 10) || 1; if (r[1]) kept = parseInt(r[1], 10) || 0; } catch (e) {}

  // ── Fertig? ──
  if (kept >= target) {
    const doneBody = '<div class="big">✅ Fertig</div><div class="muted"><b>' + kept + '</b> Produkte im Katalog. Barcode-Scans treffen jetzt fast immer sofort.</div>'
      + '<a class="btn" href="' + esc(selfUrl + '&reset=1') + '">Erneut / mehr laden</a>';
    return wantJson ? sendJson(200, { ok: true, done: true, kept: kept }) : send(200, page_('Warmup fertig', doneBody));
  }

  // ── Eine Seite verarbeiten ──
  const r = await fetchPage(page, countryTag);
  if (!r.ok) {
    const body = '<div class="big">⏳</div><div class="muted">Open Food Facts ist gerade kurz belegt (' + esc(r.status || r.error) + ').<br>Neuer Versuch in ' + REFRESH_SEC + ' s …</div>';
    return wantJson ? sendJson(200, { ok: false, retry: true, page: page, kept: kept }) : send(200, page_('Warmup läuft …', body, selfUrl));
  }
  if (!r.products.length) {
    // Keine weiteren Produkte -> als fertig markieren.
    try { await redisPipeline([['SET', KEY_KEPT, String(Math.max(kept, target))]]); } catch (e) {}
    const body = '<div class="big">✅ Fertig</div><div class="muted"><b>' + kept + '</b> Produkte im Katalog (keine weiteren verfügbar).</div><a class="btn" href="' + esc(selfUrl + '&reset=1') + '">Erneut starten</a>';
    return wantJson ? sendJson(200, { ok: true, done: true, kept: kept }) : send(200, page_('Warmup fertig', body));
  }

  const prods = [];
  for (const raw of r.products) {
    const code = String(raw.code || raw._id || '').replace(/\D/g, '');
    if (code.length < 8 || code.length > 14) continue;
    const prod = OFF.normalize(code, raw);
    if (OFF.isUsable(prod)) prods.push(prod);
  }
  let wrote = 0;
  try { wrote = await Catalog.catalogPutMany(prods); } catch (e) { wrote = 0; }
  kept += wrote; page += 1;
  try { await redisPipeline([['SET', KEY_PAGE, String(page)], ['SET', KEY_KEPT, String(kept)]]); } catch (e) {}

  if (wantJson) return sendJson(200, { ok: true, page: page - 1, wrote: wrote, kept: kept, target: target });
  const pct = Math.min(100, Math.round(kept / target * 100));
  const body = '<div class="muted">Katalog wird vorbefüllt …</div>'
    + '<div class="big">' + kept + ' <span style="font-size:20px;color:#aed0d6">/ ' + target + '</span></div>'
    + '<div class="bar"><div class="fill" style="width:' + pct + '%"></div></div>'
    + '<div class="muted">Läuft automatisch weiter – dieses Fenster einfach offen lassen.</div>'
    + '<a class="btn" href="' + esc(selfUrl) + '">Weiter (falls es stockt)</a>';
  return send(200, page_('Warmup läuft …', body, selfUrl));
};
