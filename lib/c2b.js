'use strict';

/**
 * Chance2Brand Merchant API (Eigenmarken-Shop).
 * -----------------------------------------------------------------------------
 * REST + JWT: aus `api_key`/`api_secret` wird ein kurzlebiges `access`-Token, das
 * an jeder Anfrage im Authorization-Header haengt. Basis: https://chancetobrand.de
 *
 *   POST /api/auth/token/            { api_key, api_secret } -> { access, refresh }
 *   POST /api/auth/token/refresh/    { refresh }             -> { access }
 *   GET  /api/products/              Katalog (Preis, Bestand, Bilder, SKU)
 *   GET  /api/my-products/           eigenes Sortiment inkl. eigenem Verkaufspreis
 *   POST /api/orders/                Bestellung (Adresse + items[{sku,quantity}])
 *   GET  /api/orders/{id}/           Status + Sendungsverfolgung
 *
 * ZWEI DINGE, DIE DIE API NICHT TUT - und die den Bau bestimmen:
 *
 *  1. Sie kassiert NICHT beim Mitglied. Chance2Brand bucht per Stripe bei UNS ab.
 *     Das Geld vom Mitglied muessen wir selbst einnehmen. Deshalb loest eine
 *     Bestellung in der App hier KEINE echte Bestellung aus: sie wird zum Vorgang
 *     fuers Team. Erst das Team bestellt wirklich - sonst koennte jeder Tippfehler
 *     in der App echtes Geld kosten.
 *  2. Es gibt keine Webhooks (im ganzen Schema kommt "webhook" nicht vor).
 *     Bestellstatus muss abgefragt werden.
 *
 * Ohne Zugangsdaten (`C2B_API_KEY`/`C2B_API_SECRET`) schlaeft das Modul:
 * `hasC2B=false`, und der Shop zeigt einen klar markierten Beispielkatalog.
 * Erfundene Preise neben einem Kaufknopf sind gefaehrlich - deshalb traegt
 * jedes Beispielprodukt `beispiel:true`, und die Oberflaeche sagt es an.
 */

const BASE = String(process.env.C2B_BASE_URL || 'https://chancetobrand.de').replace(/\/+$/, '');
const KEY = process.env.C2B_API_KEY || '';
const SECRET = process.env.C2B_API_SECRET || '';
const hasC2B = !!(KEY && SECRET);

// Aufschlag auf den Einkaufspreis, falls fuer ein Produkt kein eigener
// Verkaufspreis gepflegt ist. 0 = Einkaufspreis (dann sieht das Team sofort,
// dass gepflegt werden muss). Als Faktor: 1.6 = 60 % Aufschlag.
const MARKUP = (function () {
  const v = Number(process.env.C2B_MARKUP);
  return (isFinite(v) && v >= 1 && v <= 5) ? v : 1;
})();

const TIMEOUT_MS = Number(process.env.C2B_TIMEOUT_MS || 8000);
const RETRIES = Math.max(0, Number(process.env.C2B_RETRIES || 1));

// ── Netz: Timeout + Wiederholung nur bei vorruebergehenden Fehlern ───────────
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
function voruebergehend(status) { return status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599); }

async function ruf(pfad, opts) {
  opts = opts || {};
  const url = BASE + pfad;
  let letzte = { ok: false, status: 0, text: '', error: 'unknown' };
  for (let v = 0; v <= RETRIES; v++) {
    if (v > 0) await schlaf(300 * v);
    const ctrl = new AbortController();
    const uhr = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: opts.method || 'GET',
        headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      const text = await r.text().catch(() => '');
      const res = { ok: r.ok, status: r.status, text: text };
      if (r.ok || !voruebergehend(r.status)) return res;
      letzte = res;
    } catch (e) {
      letzte = { ok: false, status: 0, text: '', error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'fetch_error') };
    } finally { clearTimeout(uhr); }
  }
  return letzte;
}
function jsonOf(res) { try { return JSON.parse(res.text || ''); } catch (e) { return null; } }

// ── Token ───────────────────────────────────────────────────────────────────
// Im Prozess gehalten. Das Zugriffstoken ist kurzlebig; laeuft es ab, antwortet
// die API mit 401 - dann einmal erneuern und die Anfrage wiederholen.
let tok = { access: null, refresh: null };

async function tokenHolen() {
  const r = await ruf('/api/auth/token/', { method: 'POST', body: { api_key: KEY, api_secret: SECRET } });
  const j = jsonOf(r);
  if (!r.ok || !j || !j.access) return false;
  tok = { access: j.access, refresh: j.refresh || null };
  return true;
}
async function tokenErneuern() {
  if (!tok.refresh) return tokenHolen();
  const r = await ruf('/api/auth/token/refresh/', { method: 'POST', body: { refresh: tok.refresh } });
  const j = jsonOf(r);
  if (r.ok && j && j.access) { tok.access = j.access; return true; }
  return tokenHolen();
}

// Geschuetzter Aufruf. Liefert { ok, status, daten } und wirft nie.
async function api(pfad, opts) {
  if (!hasC2B) return { ok: false, status: 0, daten: null, error: 'not_configured' };
  if (!tok.access && !(await tokenHolen())) return { ok: false, status: 401, daten: null, error: 'auth_failed' };
  const mitToken = () => Object.assign({}, opts || {}, { headers: Object.assign({}, (opts || {}).headers, { Authorization: 'Bearer ' + tok.access }) });
  let r = await ruf(pfad, mitToken());
  if (r.status === 401) { if (await tokenErneuern()) r = await ruf(pfad, mitToken()); }
  return { ok: !!r.ok, status: r.status, daten: jsonOf(r), error: r.ok ? null : (r.error || 'http_' + r.status) };
}

// ── Umformen auf unsere Sprache ─────────────────────────────────────────────
function zahl(v) { const n = Number(v); return isFinite(n) ? n : null; }
function cent(n) { return n == null ? null : Math.round(n * 100) / 100; }

// Verkaufspreis: gepflegter Preis vor UVP vor kalkuliertem Aufschlag.
// Der Einkaufspreis (`price`) darf NIE als Verkaufspreis durchgehen und geht
// niemals an ein Mitglied - er steht nur im Team-Teil.
function verkaufspreis(p) {
  const eigen = zahl(p.selling_price);
  if (eigen != null && eigen > 0) return cent(eigen);
  const uvp = zahl(p.compare_at_price);
  if (uvp != null && uvp > 0) return cent(uvp);
  const ek = zahl(p.discounted_price != null ? p.discounted_price : p.price);
  return ek == null ? null : cent(ek * MARKUP);
}

function formen(p) {
  const ek = zahl(p.discounted_price != null ? p.discounted_price : p.price);
  const vk = verkaufspreis(p);
  const bestand = zahl(p.inventory);
  const bilder = Array.isArray(p.images) ? p.images.filter(function (u) { return typeof u === 'string' && /^https?:\/\//.test(u); }).slice(0, 6) : [];
  return {
    id: String(p.id || p.catalog_product_id || p.sku || ''),
    katalogId: p.catalog_product_id ? String(p.catalog_product_id) : null,
    sku: String(p.sku || ''),
    titel: String(p.title || 'Produkt'),
    text: String(p.summary || ''),
    preis: vk,
    uvp: cent(zahl(p.compare_at_price)),
    ek: cent(ek),                       // NUR fuer den Team-Teil
    bestand: bestand,
    lagerText: String(p.stock_label || ''),
    lieferbar: !(p.coming_soon === true) && (bestand == null || bestand > 0) && String(p.status || 'active') === 'active',
    baldDa: p.coming_soon === true,
    gewicht: zahl(p.weight),
    gewichtEinheit: String(p.weight_unit || 'g'),
    versandProStueck: cent(zahl(p.shipping_per_unit)),
    bilder: bilder,
    bild: bilder[0] || null,
    merkmale: Array.isArray(p.attributes) ? p.attributes.map(String).slice(0, 6) : [],
    zielgruppen: Array.isArray(p.target_groups) ? p.target_groups.map(String).slice(0, 4) : [],
    beispiel: false,
  };
}

// Was ein Mitglied sehen darf: kein Einkaufspreis, keine internen Kennungen.
function fuersMitglied(p) {
  return {
    sku: p.sku, titel: p.titel, text: p.text,
    preis: p.preis, uvp: (p.uvp && p.preis && p.uvp > p.preis) ? p.uvp : null,
    lieferbar: p.lieferbar, baldDa: p.baldDa, lagerText: p.lagerText,
    gewicht: p.gewicht, gewichtEinheit: p.gewichtEinheit,
    bild: p.bild, bilder: p.bilder,
    merkmale: p.merkmale,
    beispiel: !!p.beispiel,
  };
}

// ── Beispielkatalog ─────────────────────────────────────────────────────────
// Zahlen und Felder aus der Doku, damit die Ansicht sich wie mit echten Daten
// verhaelt. `beispiel:true` MUSS in der Oberflaeche sichtbar bleiben - ein
// erfundener Preis neben einem Bestellknopf ist sonst eine Falle.
const BEISPIEL = [
  { id: 'demo-1', sku: 'PS-VAN-001', title: 'Protein Shake Vanille', summary: 'Whey-Protein mit Vanillegeschmack, 500 g. Ohne Zuckerzusatz.',
    price: 17.99, compare_at_price: 29.99, inventory: 50, stock_label: 'Auf Lager', weight: 500, weight_unit: 'g',
    shipping_per_unit: 2.5, status: 'active', attributes: ['Vegan', 'Glutenfrei'], target_groups: ['Fitness'], images: [] },
  { id: 'demo-2', sku: 'PS-WHEY-001', title: 'Whey Isolat Schoko', summary: 'Isolat mit hohem Proteingehalt, 750 g.',
    price: 24.90, compare_at_price: 39.90, inventory: 24, stock_label: 'Auf Lager', weight: 750, weight_unit: 'g',
    shipping_per_unit: 2.5, status: 'active', attributes: ['Laktosearm'], target_groups: ['Fitness'], images: [] },
  { id: 'demo-3', sku: 'SH-BOTTLE-01', title: 'Shaker 700 ml', summary: 'Auslaufsicher, spülmaschinenfest, mit Sieb.',
    price: 4.50, compare_at_price: 9.90, inventory: 120, stock_label: 'Auf Lager', weight: 140, weight_unit: 'g',
    shipping_per_unit: 1.2, status: 'active', attributes: ['BPA-frei'], target_groups: ['Fitness'], images: [] },
  { id: 'demo-4', sku: 'CR-MONO-001', title: 'Creatin Monohydrat', summary: 'Reines Creatin-Monohydrat, 300 g, geschmacksneutral.',
    price: 12.90, compare_at_price: 22.90, inventory: 0, stock_label: 'Nachschub unterwegs', weight: 300, weight_unit: 'g',
    shipping_per_unit: 2.0, status: 'active', attributes: ['Vegan'], target_groups: ['Fitness'], images: [] },
];
function beispielKatalog() {
  return BEISPIEL.map(function (p) { const o = formen(p); o.beispiel = true; return o; });
}

// ── Oeffentliche Wege ───────────────────────────────────────────────────────

/**
 * Der Katalog, wie der Shop ihn braucht. Ohne Zugangsdaten (oder wenn die API
 * gerade nicht antwortet) der Beispielkatalog - dann ist `beispiel:true` gesetzt.
 * Wirft nie.
 */
async function katalog(opt) {
  opt = opt || {};
  if (!hasC2B) return { ok: true, beispiel: true, produkte: beispielKatalog() };

  // Das eigene Sortiment hat Vorrang: dort steht der gepflegte Verkaufspreis.
  const eigen = await api('/api/my-products/?page_size=100&lang=de');
  let roh = (eigen.ok && eigen.daten && Array.isArray(eigen.daten.results)) ? eigen.daten.results : null;
  if (!roh || !roh.length) {
    const alle = await api('/api/products/?page_size=100&lang=de' + (opt.suche ? ('&search=' + encodeURIComponent(opt.suche)) : ''));
    roh = (alle.ok && alle.daten && Array.isArray(alle.daten.results)) ? alle.daten.results : null;
    if (!roh) return { ok: true, beispiel: true, produkte: beispielKatalog(), fehler: eigen.error || alle.error };
  }
  return { ok: true, beispiel: false, produkte: roh.map(formen).filter(function (p) { return p.sku; }) };
}

/** Ein Produkt per SKU aus dem Katalog. */
async function produkt(sku) {
  const k = await katalog();
  return (k.produkte || []).filter(function (p) { return p.sku === String(sku || ''); })[0] || null;
}

/**
 * Echte Bestellung bei Chance2Brand. Wird NICHT vom Mitglied ausgeloest,
 * sondern vom Team - hier entsteht eine Zahlungspflicht.
 */
async function bestellungAnlegen(daten) {
  if (!hasC2B) return { ok: false, error: 'not_configured' };
  const r = await api('/api/orders/', { method: 'POST', body: daten });
  return r.ok ? { ok: true, bestellung: r.daten } : { ok: false, error: r.error, status: r.status, detail: (r.daten && (r.daten.detail || r.daten)) || null };
}

/** Status + Sendungsverfolgung einer Bestellung (es gibt keine Webhooks). */
async function bestellung(id) {
  if (!hasC2B) return { ok: false, error: 'not_configured' };
  const r = await api('/api/orders/' + encodeURIComponent(String(id)) + '/');
  return r.ok ? { ok: true, bestellung: r.daten } : { ok: false, error: r.error, status: r.status };
}

/** Erreichbarkeit ohne Anmeldung – fuer die Selbstauskunft im Team-Backend. */
async function erreichbar() {
  const r = await ruf('/api/health/');
  return { ok: !!r.ok, status: r.status };
}

module.exports = {
  hasC2B, BASE, MARKUP,
  katalog, produkt, bestellungAnlegen, bestellung, erreichbar,
  fuersMitglied, verkaufspreis, formen, beispielKatalog,
};
