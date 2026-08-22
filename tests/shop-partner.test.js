'use strict';
// Schnittstelle fuer einen externen Shop: Mitglied erkennen, Bestellung ans
// Konto haengen.
//
// Die gefaehrliche Stelle ist nicht das Speichern, sondern das ERKENNEN. Ein
// Endpunkt, der auf "E-Mail + Geburtsdatum" mit ja/nein antwortet, beantwortet
// zugleich die Frage "trainiert diese Person bei Fit-Inn". Mit genug Versuchen
// wird daraus ein Verzeichnis. Deshalb pruefen die Tests vor allem, was NICHT
// geht: ohne Schluessel nichts, ohne Freischaltung keine E-Mail-Suche, und
// nirgends mehr Daten als noetig.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
};
const frisch = (rel) => { delete require.cache[path.resolve(ROOT, rel)]; return require(path.resolve(ROOT, rel)); };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── Speicher nachbauen (String, Liste, NX, EXPIRE) ──
const daten = new Map(), listen = new Map();
const redisPipeline = async (cmds) => cmds.map((c) => {
  const op = String(c[0]).toUpperCase(), k = String(c[1]);
  if (op === 'GET') return daten.has(k) ? daten.get(k) : null;
  if (op === 'SET') {
    if (c.indexOf('NX') >= 0 && daten.has(k)) return null;
    daten.set(k, String(c[2])); return 'OK';
  }
  if (op === 'DEL') { daten.delete(k); listen.delete(k); return 1; }
  if (op === 'LPUSH') { const l = listen.get(k) || []; l.unshift(String(c[2])); listen.set(k, l); return l.length; }
  if (op === 'LRANGE') {
    const l = listen.get(k) || [];
    const von = parseInt(c[2], 10) || 0, bis = parseInt(c[3], 10);
    return l.slice(von, bis < 0 ? undefined : bis + 1);
  }
  if (op === 'LTRIM') { const l = listen.get(k) || []; listen.set(k, l.slice(parseInt(c[2], 10) || 0, (parseInt(c[3], 10) || 0) + 1)); return 'OK'; }
  if (op === 'EXPIRE') return 1;
  return 0;
});
inject('lib/store.js', { hasStore: true, redisPipeline: redisPipeline });

const grenzen = {};
let mitgliedTreffer = null;
inject('lib/members.js', {
  hasStore: true,
  readBody: async (req) => req.__body || {},
  rateLimit: async (key, max) => { grenzen[key] = (grenzen[key] || 0) + 1; return grenzen[key] <= max; },
  findByEmailDob: async () => mitgliedTreffer,
  getMember: async () => ({ firstName: 'Adriane', lastName: 'Walter', customerNumber: 'M-2076', email: 'a@example.invalid' }),
});

const SL = frisch('lib/shopLink.js');

function ruf(H, body, key) {
  const req = { method: 'POST', headers: key ? { authorization: 'Bearer ' + key } : {}, url: '/api/shop/partner', __body: body || {} };
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s || ''; return this; } };
  return H(req, res).then(() => ({ status: res.statusCode, json: (function () { try { return JSON.parse(res.body); } catch (e) { return null; } })(), headers: res.headers }));
}

async function run() {
  // ── 1. Ohne Schluessel gibt es den Endpunkt gar nicht ──
  delete process.env.SHOP_API_KEY; delete process.env.SHOP_LOOKUP_BY_EMAIL;
  let H = frisch('api/shop/partner.js');
  let r = await ruf(H, { action: 'resolve', code: 'FI-AAAA-AAAA' }, 'egal');
  ok('1. Ohne eingerichteten Schluessel: aus', r.status === 503, JSON.stringify(r.json));

  // ── 2. Mit Schluessel, aber falschem Schluessel ──
  process.env.SHOP_API_KEY = 'k_richtig,k_zweit';
  process.env.SHOP_MEMBER_DISCOUNT = '10';
  H = frisch('api/shop/partner.js');
  r = await ruf(H, { action: 'resolve', code: 'FI-AAAA-AAAA' }, 'k_falsch');
  ok('2. Falscher Schluessel: abgewiesen', r.status === 401, JSON.stringify(r.json));
  r = await ruf(H, { action: 'resolve', code: 'FI-AAAA-AAAA' }, null);
  ok('2b. Gar kein Schluessel: abgewiesen', r.status === 401, JSON.stringify(r.json));

  // ── 3. Der Mitgliedscode ──
  const code = await SL.codeFor('m1');
  ok('3. Ein Mitglied bekommt einen Code', /^FI-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(String(code)), String(code));
  ok('3b. … derselbe beim naechsten Mal', (await SL.codeFor('m1')) === code);
  ok('3c. … und er enthaelt keine verwechselbaren Zeichen', !/[01OIL]/.test(String(code).slice(3)), String(code));

  r = await ruf(H, { action: 'resolve', code: code }, 'k_zweit');
  ok('4. Der Shop loest den Code auf', r.json.ok === true && r.json.member === true && !!r.json.ref, JSON.stringify(r.json));
  ok('4b. … bekommt den Vornamen fuer die Anrede', r.json.firstName === 'Adriane', JSON.stringify(r.json.firstName));
  ok('4c. … und den Rabattsatz', r.json.discountPct === 10, String(r.json.discountPct));

  // Datensparsamkeit: das ist der Kern. Was der Shop nicht hat, kann er nicht verlieren.
  const alsText = JSON.stringify(r.json);
  ok('5. Kein Nachname im Ergebnis', alsText.indexOf('Walter') < 0, alsText);
  ok('5b. Keine Mitgliedsnummer', alsText.indexOf('M-2076') < 0, alsText);
  ok('5c. Keine E-Mail', alsText.indexOf('example.invalid') < 0, alsText);
  ok('5d. Und nicht unsere eigene Kennung', alsText.indexOf('"m1"') < 0 && r.json.ref !== 'm1', alsText);

  // Ein unbekannter Code sagt schlicht nein - ohne Unterschied zu "gibt es nicht".
  const nein = await ruf(H, { action: 'resolve', code: 'FI-ZZZZ-ZZZZ' }, 'k_richtig');
  ok('6. Unbekannter Code: schlicht kein Mitglied', nein.json.ok === true && nein.json.member === false, JSON.stringify(nein.json));

  // ── 4. Die E-Mail-Suche ist standardmaessig AUS ──
  mitgliedTreffer = { id: 'm1', firstName: 'Adriane' };
  r = await ruf(H, { action: 'lookup', email: 'a@example.invalid', dob: '1985-03-14' }, 'k_richtig');
  ok('7. E-Mail-Suche ist ohne Freischaltung gesperrt', r.status === 403 && r.json.error === 'lookup_disabled', JSON.stringify(r.json));

  process.env.SHOP_LOOKUP_BY_EMAIL = '1';
  H = frisch('api/shop/partner.js');
  r = await ruf(H, { action: 'lookup', email: 'a@example.invalid', dob: '1985-03-14' }, 'k_richtig');
  ok('7b. Freigeschaltet findet sie dasselbe Mitglied', r.json.member === true && !!r.json.ref, JSON.stringify(r.json));
  ok('7c. … und liefert dieselbe Referenz wie der Code', r.json.ref === (await SL.refFor('m1')), r.json.ref);

  // Die harte Grenze je Adresse: sonst ist genau das der Abfragedienst.
  let gebremst = null;
  for (let i = 0; i < 8; i++) gebremst = await ruf(H, { action: 'lookup', email: 'a@example.invalid', dob: '1985-03-14' }, 'k_richtig');
  ok('8. Nach wenigen Versuchen je Adresse ist Schluss', gebremst.status === 429, JSON.stringify(gebremst.json));

  // Unvollstaendige Angaben fuehren zu keiner Auskunft.
  r = await ruf(H, { action: 'lookup', email: 'b@example.invalid' }, 'k_richtig');
  ok('8b. Ohne Geburtsdatum keine Auskunft', r.json.member === false, JSON.stringify(r.json));

  // ── 5. Bestellung ans Konto haengen ──
  const ref = await SL.refFor('m1');
  r = await ruf(H, { action: 'order', ref: ref, order: {
    externalId: 'shop-1001', number: 'B-1001', total: 59.98, currency: 'eur', status: 'bezahlt',
    items: [{ title: 'Protein Vanille', quantity: 2, unitPrice: 29.99 }],
    placedAt: '2026-08-20T10:00:00Z', url: 'https://shop.example/bestellung/1001',
  } }, 'k_richtig');
  ok('9. Die Bestellung wird gespeichert', r.json.ok === true && r.json.neu === true, JSON.stringify(r.json));

  let liste = await SL.orders('m1');
  ok('9b. … und steht beim Mitglied', liste.length === 1 && liste[0].nummer === 'B-1001' && liste[0].summe === 59.98, JSON.stringify(liste));
  ok('9c. … mit gesaeuberter Waehrung', liste[0].waehrung === 'EUR', liste[0].waehrung);

  // Zweiter Aufruf mit derselben Kennung = Statuswechsel, keine zweite Bestellung.
  r = await ruf(H, { action: 'order', ref: ref, order: { externalId: 'shop-1001', number: 'B-1001', total: 59.98, status: 'versandt', tracking: '00340434' } }, 'k_richtig');
  liste = await SL.orders('m1');
  ok('10. Derselbe Vorgang wird aktualisiert, nicht verdoppelt',
    r.json.neu === false && liste.length === 1 && liste[0].status === 'versandt', JSON.stringify(liste));

  // Eine fremde Referenz fuehrt nirgendwo hin.
  r = await ruf(H, { action: 'order', ref: 'ff'.repeat(16), order: { externalId: 'x', total: 1 } }, 'k_richtig');
  ok('11. Unbekannte Referenz: nichts passiert', r.json.ok === false && r.json.error === 'unknown_ref', JSON.stringify(r.json));

  // Fremde Bestellkennung darf nicht umgehaengt werden.
  await SL.refFor('m2');
  const ref2 = await SL.refFor('m2');
  r = await ruf(H, { action: 'order', ref: ref2, order: { externalId: 'shop-1001', total: 5 } }, 'k_richtig');
  ok('11b. Eine fremde Bestellnummer wird nicht uebernommen', r.json.ok === false && r.json.error === 'belongs_to_other', JSON.stringify(r.json));

  // ── 6. Muell im Bestelldatensatz ──
  const dreck = SL.normOrder({ externalId: 'x1', total: 999999999, currency: 'foo', status: 'hacked',
    url: 'javascript:alert(1)', items: [{ title: 'A'.repeat(500), quantity: 99999 }] });
  ok('12. Summe wird gedeckelt', dreck.summe === 100000, String(dreck.summe));
  ok('12b. Unbekannter Status wird zu „offen"', dreck.status === 'offen', dreck.status);
  ok('12c. Waehrung faellt auf EUR zurueck', dreck.waehrung === 'EUR', dreck.waehrung);
  ok('12d. Nicht-https-Verweise fliegen raus', dreck.url === null, String(dreck.url));
  ok('12e. Titel und Menge werden gekappt', dreck.posten[0].titel.length === 120 && dreck.posten[0].menge === 999, JSON.stringify(dreck.posten[0].menge));
  ok('12f. Ohne Kennung gar keine Bestellung', SL.normOrder({ total: 5 }) === null);

  // ── 7. Team-Verwaltung ──
  // Arbeitsteilung: der Shop besitzt Betrag und Positionen, das Team den
  // Bearbeitungsstand. Meldet der Shop danach einen Statuswechsel, darf die
  // Handarbeit des Teams NICHT verloren gehen - das ist die eigentliche Falle.
  const alle = await SL.alleOrders(50);
  ok('13. Fuers Team stehen alle Bestellungen in einer Liste',
    alle.length === 1 && alle[0].extId === 'shop-1001' && alle[0].memberId === 'm1', JSON.stringify(alle.map((x) => x.extId)));

  let t = await SL.teamUpdate('shop-1001', { status: 'zugestellt', versand: '00340434', notiz: 'Kundin holt selbst ab' }, 'Kathrin');
  ok('14. Das Team kann Stand, Sendung und Notiz setzen',
    t.ok && t.bestellung.status === 'zugestellt' && t.bestellung.versand === '00340434' && /holt selbst/.test(t.bestellung.notiz), JSON.stringify(t.bestellung));
  ok('14b. … und der Wechsel steht mit Namen im Verlauf',
    t.bestellung.verlauf[0].status === 'zugestellt' && t.bestellung.verlauf[0].von === 'Kathrin', JSON.stringify(t.bestellung.verlauf[0]));

  await ruf(H, { action: 'order', ref: ref, order: { externalId: 'shop-1001', number: 'B-1001', total: 59.98, status: 'erstattet' } }, 'k_richtig');
  const danach = await SL.orderByExt('shop-1001');
  ok('15. Ein Statuswechsel aus dem Shop loescht die Notiz nicht',
    danach.status === 'erstattet' && /holt selbst/.test(danach.notiz || ''), JSON.stringify({ s: danach.status, n: danach.notiz }));
  ok('15b. … und auch die Sendungsnummer bleibt', danach.versand === '00340434', String(danach.versand));

  t = await SL.teamUpdate('gibts-nicht', { status: 'bezahlt' }, 'Kathrin');
  ok('16. Eine unbekannte Bestellung laesst sich nicht bearbeiten', t.ok === false, JSON.stringify(t));

  const bloed = await SL.teamUpdate('shop-1001', { status: 'irgendwas' }, 'Kathrin');
  ok('16b. Ein erfundener Stand wird ignoriert', bloed.bestellung.status === 'erstattet', bloed.bestellung.status);

  console.log(pass ? 'SHOP-PARTNER PASS' : 'SHOP-PARTNER FAIL');
  process.exit(pass ? 0 : 1);
}
run();
