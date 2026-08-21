'use strict';
// Studio-Shop (Chance2Brand).
//
// Drei Dinge muessen hier halten, sonst wird es teuer oder peinlich:
//
//  1. Der EINKAUFSpreis darf nie zu einem Mitglied durchrutschen. Er steckt im
//     selben Datensatz wie der Verkaufspreis - eine vergessene Zeile genuegt.
//  2. Mit Beispieldaten darf nicht bestellt werden. Sonst liegt im Postfach des
//     Teams eine Bestellung ueber Ware, die es gar nicht gibt.
//  3. Gerechnet wird serverseitig. Was der Browser an Preisen mitschickt, ist
//     bestenfalls Deko - im schlimmsten Fall ein Selbstbedienungsladen.
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
};

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── 1. Der Katalog ohne Zugangsdaten ────────────────────────────────────────
delete process.env.C2B_API_KEY; delete process.env.C2B_API_SECRET;
const C2B = require(path.resolve(ROOT, 'lib/c2b.js'));

async function run() {
  ok('1. Ohne Zugangsdaten schlaeft das Modul', C2B.hasC2B === false);
  const k = await C2B.katalog();
  ok('1b. … und liefert einen Beispielkatalog', k.ok === true && k.beispiel === true && k.produkte.length > 0, JSON.stringify({ b: k.beispiel, n: k.produkte.length }));
  ok('1c. … in dem JEDES Produkt als Beispiel markiert ist',
    k.produkte.every(function (p) { return p.beispiel === true; }));

  // ── 2. Preise ──
  // Reihenfolge: gepflegter Verkaufspreis > UVP > Einkauf mal Aufschlag.
  ok('2. Gepflegter Verkaufspreis gewinnt',
    C2B.verkaufspreis({ selling_price: 24.9, compare_at_price: 29.99, price: 17.99 }) === 24.9);
  ok('2b. … sonst die UVP', C2B.verkaufspreis({ compare_at_price: 29.99, price: 17.99 }) === 29.99);
  ok('2c. … und erst zuletzt der Einkaufspreis', C2B.verkaufspreis({ price: 17.99 }) === 17.99);

  // ── 3. Was das Mitglied sehen darf ──
  // Der gefaehrliche Fall: der Einkaufspreis liegt im selben Objekt.
  const roh = C2B.formen({ id: 'x', sku: 'PS-VAN-001', title: 'Protein', price: 17.99, compare_at_price: 29.99, inventory: 5, status: 'active' });
  ok('3. Intern ist der Einkaufspreis da', roh.ek === 17.99, JSON.stringify(roh.ek));
  const fuer = C2B.fuersMitglied(roh);
  ok('3b. Beim Mitglied ist er weg', !('ek' in fuer), Object.keys(fuer).join(','));
  ok('3c. … und der Verkaufspreis stimmt', fuer.preis === 29.99, String(fuer.preis));
  const alsText = JSON.stringify(fuer);
  ok('3d. … er taucht auch nirgends sonst auf', alsText.indexOf('17.99') < 0, alsText);

  // ── 4. Der Endpunkt ──
  const kv = {};
  inject('lib/store.js', { hasStore: true, redisPipeline: async () => [] });
  let sess = { id: 'm1' };
  inject('lib/members.js', {
    hasStore: true,
    bearer: () => 't', getSession: async () => sess,
    rateLimit: async (key, max) => { kv[key] = (kv[key] || 0) + 1; return kv[key] <= max; },
    readBody: async (req) => req.__body || {},
  });
  const vorgaenge = [];
  inject('lib/inbox.js', {
    addVorgang: async (id, o) => { vorgaenge.push({ id: id, o: o }); return { id: '1', ref: '#M-1001' }; },
  });
  inject('lib/c2b.js', C2B);
  const H = require(path.resolve(ROOT, 'api/member/shop.js'));

  const anfrage = (method, body) => {
    const req = { method: method, headers: {}, url: '/api/member/shop', __body: body || {} };
    const res = { statusCode: 0, headers: {}, body: '',
      setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s || ''; return this; } };
    return H(req, res).then(() => ({ status: res.statusCode, json: (function () { try { return JSON.parse(res.body); } catch (e) { return null; } })(), headers: res.headers }));
  };

  sess = null;
  let r = await anfrage('GET');
  ok('4. Ohne Anmeldung: abgewiesen', r.status === 401, JSON.stringify(r.json));

  sess = { id: 'm1' };
  r = await anfrage('GET');
  ok('5. Angemeldet: der Katalog kommt', r.status === 200 && r.json.ok === true && r.json.produkte.length > 0, JSON.stringify(r.json && r.json.produkte && r.json.produkte.length));
  ok('5b. … als Beispieldaten markiert', r.json.beispiel === true, String(r.json.beispiel));
  ok('5c. … ohne Einkaufspreise', JSON.stringify(r.json.produkte).indexOf('"ek"') < 0);
  ok('5d. … und nichts davon wird zwischengespeichert', /no-store/.test(String(r.headers['Cache-Control'] || '')));

  // ── 5. Mit Beispieldaten wird nicht bestellt ──
  r = await anfrage('POST', { action: 'order', items: [{ sku: 'PS-VAN-001', menge: 2 }] });
  ok('6. Beispieldaten: Bestellung wird abgelehnt',
    r.json.ok === false && r.json.beispiel === true && vorgaenge.length === 0, JSON.stringify(r.json));

  // ── 6. Mit echtem Katalog ──
  const echt = [
    { id: 'a', sku: 'PS-VAN-001', title: 'Protein Vanille', price: 17.99, compare_at_price: 29.99, inventory: 10, status: 'active' },
    { id: 'b', sku: 'CR-MONO-001', title: 'Creatin', price: 12.9, compare_at_price: 22.9, inventory: 0, status: 'active' },
  ].map(C2B.formen);
  inject('lib/c2b.js', Object.assign({}, C2B, { katalog: async () => ({ ok: true, beispiel: false, produkte: echt }) }));
  delete require.cache[path.resolve(ROOT, 'api/member/shop.js')];
  const H2 = require(path.resolve(ROOT, 'api/member/shop.js'));
  const anfrage2 = (body) => {
    const req = { method: 'POST', headers: {}, url: '/api/member/shop', __body: body };
    const res = { statusCode: 0, headers: {}, body: '', setHeader() {}, end(s) { this.body = s || ''; return this; } };
    return H2(req, res).then(() => { try { return JSON.parse(res.body); } catch (e) { return null; } });
  };

  vorgaenge.length = 0;
  let j = await anfrage2({ action: 'order', items: [{ sku: 'PS-VAN-001', menge: 2 }] });
  ok('7. Echte Daten: die Bestellung wird angenommen', j.ok === true && !!j.ref, JSON.stringify(j));
  ok('7b. … mit serverseitig gerechneter Summe', j.summe === 59.98, String(j.summe));
  ok('7c. … und landet als Vorgang beim Team',
    vorgaenge.length === 1 && /Shop/.test(vorgaenge[0].o.subject) && vorgaenge[0].o.needsAction === true,
    JSON.stringify(vorgaenge[0] && vorgaenge[0].o.subject));
  ok('7d. … der Menge, Artikel und Summe nennt',
    /2× Protein Vanille/.test(vorgaenge[0].o.systemText) && /59,98/.test(vorgaenge[0].o.systemText),
    vorgaenge[0].o.systemText);

  // Der eigentliche Angriff: der Browser schickt einen Wunschpreis mit.
  vorgaenge.length = 0;
  j = await anfrage2({ action: 'order', items: [{ sku: 'PS-VAN-001', menge: 1, preis: 0.01, einzel: 0.01 }] });
  ok('8. Ein mitgeschickter Preis wird ignoriert', j.ok === true && j.summe === 29.99, JSON.stringify(j.summe));

  // Nicht lieferbares und Unbekanntes fliegen raus, statt die Bestellung zu kippen.
  vorgaenge.length = 0;
  j = await anfrage2({ action: 'order', items: [{ sku: 'CR-MONO-001', menge: 1 }, { sku: 'GIBTS-NICHT', menge: 1 }, { sku: 'PS-VAN-001', menge: 1 }] });
  ok('9. Nicht Lieferbares und Unbekanntes wird aussortiert',
    j.ok === true && j.posten.length === 1 && j.posten[0].sku === 'PS-VAN-001' && j.abgelehnt.length === 2, JSON.stringify(j));

  // Nur Unbestellbares -> gar keine Bestellung.
  vorgaenge.length = 0;
  j = await anfrage2({ action: 'order', items: [{ sku: 'GIBTS-NICHT', menge: 1 }] });
  ok('9b. Bleibt nichts uebrig, entsteht kein Vorgang', j.ok === false && vorgaenge.length === 0, JSON.stringify(j));

  // Menge wird gedeckelt - niemand bestellt 5000 Dosen mit einem Tippfehler.
  vorgaenge.length = 0;
  j = await anfrage2({ action: 'order', items: [{ sku: 'PS-VAN-001', menge: 9999 }] });
  ok('10. Die Menge ist gedeckelt', j.ok === true && j.posten[0].menge === 20, JSON.stringify(j.posten));

  // ── 7. Die Oberflaeche: der Beispiel-Hinweis darf nicht verschwinden ──
  const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
  ok('11. Der Shop zeigt Beispieldaten als solche an', /Beispieldaten\./.test(html) && /shopBeispielBanner/.test(html));
  ok('11b. … und sperrt den Bestellknopf dabei',
    /Mit Beispieldaten nicht bestellbar/.test(html), 'Sperrtext fehlt');

  console.log(pass ? 'SHOP PASS' : 'SHOP FAIL');
  process.exit(pass ? 0 : 1);
}
run();
