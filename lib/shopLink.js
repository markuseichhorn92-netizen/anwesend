'use strict';

/**
 * Shop-Anbindung: Mitglied erkennen und Bestellungen ans Konto haengen.
 * -----------------------------------------------------------------------------
 * Ein Shop, der NICHT bei uns liegt, soll beim Bezahlen wissen: ist das ein
 * Mitglied? Und die fertige Bestellung soll spaeter in der App auftauchen.
 *
 * Dafuer braucht es drei Dinge, und jedes hat eine Falle:
 *
 *  1. ERKENNEN, ohne ein Verzeichnis preiszugeben.
 *     Der bequeme Weg (Shop schickt E-Mail + Geburtsdatum, wir antworten
 *     ja/nein) ist zugleich ein Abfragedienst fuer die Frage "wer trainiert
 *     bei Fit-Inn". Mit genug Versuchen laesst sich das ausrechnen. Deshalb
 *     ist der Standardweg ein MITGLIEDSCODE, den das Mitglied in der App sieht
 *     und selbst im Shop eintraegt: zufaellig, nicht erratbar, und die
 *     Verknuepfung ist eine bewusste Handlung. Der E-Mail-Weg existiert, ist
 *     aber abschaltbar (SHOP_LOOKUP_BY_EMAIL) und haerter begrenzt.
 *
 *  2. VERKNUEPFEN, ohne unsere Kennungen zu verteilen.
 *     Der Shop bekommt nie die Magicline-ID, sondern eine eigene, bedeutungs-
 *     lose Referenz (`ref`). Faellt sie irgendwo heraus, ist damit nichts
 *     anzufangen ausser bei uns - und dort nur mit gueltigem Schluessel.
 *
 *  3. DATENSPARSAMKEIT.
 *     Zurueck geht Vorname, Referenz und der Rabattsatz. Kein Nachname, keine
 *     Mitgliedsnummer, keine Adresse, kein Vertrag, keine E-Mail. Ein Shop
 *     braucht das nicht, und was er nicht hat, kann er nicht verlieren.
 *
 * Schluessel im KV (Praefix `shl:`):
 *   shl:code:<code>   -> Mitglieds-ID        (Mitgliedscode aus der App)
 *   shl:mcode:<id>    -> code                (Rueckrichtung, stabil)
 *   shl:ref:<ref>     -> Mitglieds-ID        (Referenz fuer den Shop)
 *   shl:mref:<id>     -> ref
 *   shl:o:<extId>     -> die Bestellung selbst (JSON, mit Mitglieds-ID)
 *   shl:ord:<id>      -> Liste der extIds des Mitglieds (juengste zuerst)
 *   shl:all           -> Liste aller extIds (fuers Team, juengste zuerst)
 *
 * Die Bestellung liegt EINMAL (unter ihrer Kennung), die Listen enthalten nur
 * Verweise. Sonst muesste ein Statuswechsel an drei Stellen nachgezogen werden -
 * und irgendwann zeigt das Team etwas anderes als das Mitglied.
 */

const crypto = require('node:crypto');
const { redisPipeline, hasStore } = require('./store');

const TTL_CODE = 3 * 365 * 24 * 3600;     // Code und Referenz gelten dauerhaft
const MAX_ORDERS = 50;      // je Mitglied
const MAX_ALL = 500;        // fuers Team (aeltere bleiben am Konto, nur nicht in der Liste)
const TTL_ORDERS = 3 * 365 * 24 * 3600;

// Alphabet ohne 0/O/1/I/l - der Code wird abgetippt und vorgelesen.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function codeStueck(n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}
function neuerCode() { return 'FI-' + codeStueck(4) + '-' + codeStueck(4); }
function normCode(s) {
  const t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const kern = t.indexOf('FI') === 0 ? t.slice(2) : t;
  return kern.length === 8 ? ('FI-' + kern.slice(0, 4) + '-' + kern.slice(4)) : '';
}

async function kv(cmds) {
  if (!hasStore) return [];
  try { return await redisPipeline(cmds); } catch (e) { return []; }
}

// ── Mitgliedscode (das Mitglied sieht ihn in der App) ───────────────────────
async function codeFor(memberId) {
  if (!hasStore || memberId == null) return null;
  const id = String(memberId);
  const [vorhanden] = await kv([['GET', 'shl:mcode:' + id]]);
  if (vorhanden) return String(vorhanden);
  // Kollisionen sind bei 31^8 unwahrscheinlich, aber SETNX kostet nichts.
  for (let v = 0; v < 5; v++) {
    const code = neuerCode();
    const [gesetzt] = await kv([['SET', 'shl:code:' + code, id, 'NX', 'EX', String(TTL_CODE)]]);
    if (gesetzt) {
      await kv([['SET', 'shl:mcode:' + id, code, 'EX', String(TTL_CODE)]]);
      return code;
    }
  }
  return null;
}
async function memberByCode(code) {
  const c = normCode(code);
  if (!c || !hasStore) return null;
  const [id] = await kv([['GET', 'shl:code:' + c]]);
  return id ? String(id) : null;
}

// ── Referenz fuer den Shop (bedeutungslos, nicht rueckrechenbar) ────────────
async function refFor(memberId) {
  if (!hasStore || memberId == null) return null;
  const id = String(memberId);
  const [vorhanden] = await kv([['GET', 'shl:mref:' + id]]);
  if (vorhanden) return String(vorhanden);
  const ref = crypto.randomBytes(16).toString('hex');
  await kv([
    ['SET', 'shl:ref:' + ref, id, 'EX', String(TTL_CODE)],
    ['SET', 'shl:mref:' + id, ref, 'EX', String(TTL_CODE)],
  ]);
  return ref;
}
async function memberByRef(ref) {
  const r = String(ref || '').trim();
  if (!/^[0-9a-f]{32}$/.test(r) || !hasStore) return null;
  const [id] = await kv([['GET', 'shl:ref:' + r]]);
  return id ? String(id) : null;
}

// ── Bestellungen ────────────────────────────────────────────────────────────
function zahl(v, min, max) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}
const STATUS = ['offen', 'bezahlt', 'versandt', 'zugestellt', 'storniert', 'erstattet'];
// Bewusst eine Liste statt eines Musters: "FOO" sind auch drei Grossbuchstaben,
// und in der App staende dann "59,98 FOO".
const WAEHRUNGEN = ['EUR', 'CHF', 'USD', 'GBP', 'DKK', 'SEK', 'NOK', 'PLN', 'CZK'];

/**
 * Bestellung in unsere Form bringen. Alles wird gekappt und geprueft - der
 * Aufrufer ist ein fremdes System, sein Wort gilt hier nichts.
 * Liefert null, wenn nicht genug Brauchbares uebrig bleibt.
 */
function normOrder(o) {
  o = o || {};
  const extId = String(o.externalId || o.id || '').trim().slice(0, 64);
  if (!extId) return null;
  const posten = (Array.isArray(o.items) ? o.items : []).slice(0, 40).map(function (i) {
    return {
      titel: String((i && (i.title || i.name)) || 'Artikel').slice(0, 120),
      menge: Math.max(1, Math.min(999, parseInt((i && (i.quantity || i.menge)), 10) || 1)),
      einzel: zahl(i && (i.unitPrice != null ? i.unitPrice : i.price), 0, 100000),
    };
  }).filter(function (i) { return i.titel; });
  const st = String(o.status || 'offen').toLowerCase();
  return {
    extId: extId,
    nummer: String(o.number || o.orderNumber || extId).slice(0, 40),
    status: STATUS.indexOf(st) >= 0 ? st : 'offen',
    summe: zahl(o.total, 0, 100000),
    waehrung: (function () { const w = String(o.currency || '').toUpperCase(); return WAEHRUNGEN.indexOf(w) >= 0 ? w : 'EUR'; })(),
    posten: posten,
    // Nur https und nur als Verweis - keine Weiterleitung, kein Nachladen.
    url: /^https:\/\/[^\s"']{4,300}$/.test(String(o.url || '')) ? String(o.url) : null,
    versand: String(o.tracking || '').trim().slice(0, 120) || null,
    bestelltAm: (function () {
      const t = Date.parse(String(o.placedAt || o.createdAt || ''));
      return isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
    })(),
    quelle: String(o.source || 'shop').slice(0, 24),
  };
}

/**
 * Bestellung an ein Mitgliedskonto haengen. Eine bereits bekannte `externalId`
 * ersetzt den vorhandenen Eintrag (Statuswechsel), statt ihn zu verdoppeln -
 * ein Shop schickt "bezahlt" und "versandt" als zwei Aufrufe.
 * Liefert { ok, neu } oder { ok:false }.
 */
async function saveOrder(memberId, roh) {
  if (!hasStore || memberId == null) return { ok: false, error: 'no_store' };
  const b = normOrder(roh);
  if (!b) return { ok: false, error: 'invalid_order' };
  const id = String(memberId);

  const vorher = await orderByExt(b.extId);
  if (vorher && String(vorher.memberId) !== id) return { ok: false, error: 'belongs_to_other' };
  const neu = !vorher;

  b.memberId = id;
  b.aktualisiertAm = new Date().toISOString();
  // Was das Team gepflegt hat, gehoert dem Team - der Shop darf es nicht
  // ueberschreiben, wenn er nur einen Statuswechsel meldet.
  if (vorher) {
    b.notiz = vorher.notiz || null;
    b.teamStatus = vorher.teamStatus || null;
    b.verlauf = (vorher.verlauf || []).slice(0, 30);
    if (!b.versand && vorher.versand) b.versand = vorher.versand;
    if (vorher.status !== b.status) b.verlauf = [{ status: b.status, am: b.aktualisiertAm, von: 'shop' }].concat(b.verlauf);
  } else {
    b.notiz = null; b.teamStatus = null;
    b.verlauf = [{ status: b.status, am: b.aktualisiertAm, von: 'shop' }];
  }

  const cmds = [['SET', 'shl:o:' + b.extId, JSON.stringify(b), 'EX', String(TTL_ORDERS)]];
  if (neu) {
    cmds.push(['LPUSH', 'shl:ord:' + id, b.extId], ['LTRIM', 'shl:ord:' + id, '0', String(MAX_ORDERS - 1)], ['EXPIRE', 'shl:ord:' + id, String(TTL_ORDERS)]);
    cmds.push(['LPUSH', 'shl:all', b.extId], ['LTRIM', 'shl:all', '0', String(MAX_ALL - 1)], ['EXPIRE', 'shl:all', String(TTL_ORDERS)]);
  }
  await kv(cmds);
  return { ok: true, neu: neu, bestellung: b };
}

async function orderByExt(extId) {
  const e = String(extId || '').trim();
  if (!e || !hasStore) return null;
  const [roh] = await kv([['GET', 'shl:o:' + e]]);
  if (!roh) return null;
  try { return JSON.parse(roh); } catch (e2) { return null; }
}

async function ausListe(key, limit) {
  if (!hasStore) return [];
  const n = Math.max(1, Math.min(MAX_ALL, Number(limit) || MAX_ORDERS));
  const [ids] = await kv([['LRANGE', key, '0', String(n - 1)]]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const roh = await kv(ids.map(function (e) { return ['GET', 'shl:o:' + String(e)]; }));
  return (roh || []).map(function (s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }).filter(Boolean);
}

/** Bestellungen eines Mitglieds, juengste zuerst. */
function orders(memberId, limit) {
  if (memberId == null) return Promise.resolve([]);
  return ausListe('shl:ord:' + String(memberId), limit);
}

/** Alle Bestellungen fuers Team, juengste zuerst. */
function alleOrders(limit) { return ausListe('shl:all', limit); }

/**
 * Was das Team an einer Bestellung aendern darf. Der Shop bleibt Herr ueber
 * Betrag und Positionen - das Team ueber Bearbeitungsstand, Sendung und Notiz.
 */
async function teamUpdate(extId, felder, wer) {
  const b = await orderByExt(extId);
  if (!b) return { ok: false, error: 'unknown_order' };
  const jetzt = new Date().toISOString();
  felder = felder || {};
  if (felder.status && STATUS.indexOf(String(felder.status)) >= 0 && felder.status !== b.status) {
    b.status = String(felder.status);
    b.verlauf = [{ status: b.status, am: jetzt, von: String(wer || 'Team').slice(0, 40) }].concat(b.verlauf || []).slice(0, 30);
  }
  if (felder.versand != null) b.versand = String(felder.versand).trim().slice(0, 120) || null;
  if (felder.notiz != null) b.notiz = String(felder.notiz).trim().slice(0, 600) || null;
  if (felder.teamStatus != null) b.teamStatus = String(felder.teamStatus).slice(0, 24) || null;
  b.aktualisiertAm = jetzt;
  await kv([['SET', 'shl:o:' + b.extId, JSON.stringify(b), 'EX', String(TTL_ORDERS)]]);
  return { ok: true, bestellung: b };
}

module.exports = {
  codeFor, memberByCode, normCode,
  refFor, memberByRef,
  saveOrder, orders, alleOrders, orderByExt, teamUpdate, normOrder,
  STATUS, MAX_ORDERS,
};
