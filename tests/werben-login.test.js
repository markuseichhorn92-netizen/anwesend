'use strict';
// Anmeldung auf /werben ("Freunde werben").
//
// Diese Seite war fuer JEDEN kaputt: die Anmeldung am Server ist zweistufig -
// erst nachschauen, welche Wege es gibt (E-Mail, ggf. WhatsApp), dann ueber den
// gewaehlten Weg senden. Die Seite suchte in der ERSTEN Antwort nach `challenge`.
// Den gibt es dort nicht. Also kam immer "Es ist ein Fehler aufgetreten",
// auch wenn mit dem Konto alles stimmte.
//
// Der Test faehrt beide Antwortformen des echten Endpunkts gegen die echte Seite.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'werben.html'), 'utf8');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── Ohne Browser: die Seite muss die Schritte des Endpunkts ueberhaupt kennen ──
const schritte = ['needdob', 'notfound', 'number', 'channel'];
const fehlend = schritte.filter((s) => html.indexOf("j.step==='" + s + "'") < 0);
ok('1. Die Seite kennt alle Antwort-Schritte des Endpunkts', fehlend.length === 0, 'fehlt: ' + fehlend.join(', '));
ok('1b. … und sendet im zweiten Schritt einen Kanal mit', /deliver:deliver/.test(html));

(async function () {
  let chromium = null;
  try { chromium = require('playwright-core').chromium; } catch (e) { chromium = null; }
  const kandidaten = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  const bin = kandidaten.filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } })[0];
  if (!chromium || !bin) {
    console.log('HINWEIS Kein Browser vorhanden – der Anmeldeweg (2–7) wurde NICHT geprueft.');
    console.log(pass ? 'WERBEN-LOGIN PASS (ohne Browser)' : 'WERBEN-LOGIN FAIL');
    process.exit(pass ? 0 : 1);
  }

  // Die Seite ueber HTTP ausliefern statt per setContent: nur mit echtem Origin
  // verhaelt sich der Speicher wie im Browser einer Besucherin.
  const http = require('http');
  const server = http.createServer(function (req, res) {
    // Nur die Seite ausliefern. Alles andere (z. B. das Mess-Skript von Vercel)
    // gibt es hier nicht - sonst bekaeme der Browser HTML statt JavaScript und
    // meldete einen Fehler, den es in Wirklichkeit gar nicht gibt.
    if (String(req.url || '').indexOf('/werben') !== 0) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const URL_ = 'http://127.0.0.1:' + server.address().port + '/werben';

  const b = await chromium.launch({ executablePath: bin });
  const fehler = [];

  // Eine Seite mit vorgegebenen Serverantworten. `antworten` ist eine Liste:
  // der erste Aufruf bekommt die erste Antwort, der zweite die zweite …
  const seite = async function (antworten) {
    const p = await b.newPage({ viewport: { width: 420, height: 900 } });
    p.on('pageerror', function (e) { fehler.push(String(e.message)); });
    await p.goto(URL_, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(200);
    await p.evaluate(function (list) {
      window.__posts = [];
      window.fetch = function (url, opts) {
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        window.__posts.push({ url: String(url), body: body });
        const a = list[Math.min(window.__posts.length - 1, list.length - 1)];
        return Promise.resolve({ status: a.status || 200, json: function () { return Promise.resolve(a.json); } });
      };
    }, antworten);
    return p;
  };
  const ausfuellen = async function (p) {
    await p.fill('#l_email', 'jemand@beispiel.de');
    await p.fill('#l_dob', '1985-03-14');
    await p.click('#l_btn');
    await p.waitForTimeout(250);
  };
  const fehlermeldung = function (p) {
    return p.evaluate(function () { const e = document.querySelector('.err'); return e ? e.innerText.trim() : ''; });
  };
  // Welcher Schritt ist zu sehen? Am DOM abgelesen, nicht am Zustand.
  const schritt = function (p) {
    return p.evaluate(function () {
      if (document.querySelector('[data-chan]')) return 'channel';
      if (document.querySelector('#l_code')) return 'verify';
      if (document.querySelector('#l_num')) return 'number';
      if (document.querySelector('#l_email')) return 'request';
      return '?';
    });
  };
  const posts = function (p) { return p.evaluate(function () { return window.__posts.map(function (x) { return x.body; }); }); };

  // ── 2. Der Normalfall: Konto gefunden, Kanal waehlen, Code kommt ──
  let p = await seite([
    { json: { ok: true, step: 'channel', channels: [{ type: 'email', hint: 'j•••@beispiel.de' }] } },
    { json: { ok: true, step: 'code', challenge: 'abc123', via: 'email', delivered: true } },
  ]);
  await ausfuellen(p);
  const nachErstem = { schritt: await schritt(p), fehler: await fehlermeldung(p),
    knoepfe: await p.$$eval('[data-chan]', function (e) { return e.length; }) };
  // Genau hier lag der Fehler: die erste Antwort traegt keinen `challenge`.
  ok('2. Die erste Antwort ist KEIN Fehler, sondern die Kanalauswahl',
    nachErstem.schritt === 'channel' && nachErstem.knoepfe === 1 && !nachErstem.fehler,
    JSON.stringify(nachErstem));

  await p.click('[data-chan="email"]');
  await p.waitForTimeout(250);
  const nachKanal = { schritt: await schritt(p), fehler: await fehlermeldung(p), body: (await posts(p))[1] };
  ok('3. Der zweite Schritt fordert den Code wirklich an',
    nachKanal.schritt === 'verify' && !nachKanal.fehler,
    JSON.stringify({ s: nachKanal.schritt, f: nachKanal.fehler }));
  ok('3b. … und schickt E-Mail, Geburtsdatum und Kanal mit',
    nachKanal.body && nachKanal.body.email === 'jemand@beispiel.de'
      && nachKanal.body.dob === '1985-03-14' && nachKanal.body.deliver === 'email',
    JSON.stringify(nachKanal.body));
  await p.close();

  // ── 3. WhatsApp als zweiter Weg ──
  p = await seite([
    { json: { ok: true, step: 'channel', channels: [{ type: 'email', hint: 'j•••@beispiel.de' }, { type: 'whatsapp', hint: '•••• 4321' }] } },
    { json: { ok: true, step: 'code', challenge: 'wa1', via: 'whatsapp', delivered: true } },
  ]);
  await ausfuellen(p);
  const zweiWege = await p.$$eval('[data-chan]', function (e) { return e.map(function (x) { return x.getAttribute('data-chan'); }).join(','); });
  ok('4. Steht WhatsApp bereit, wird es angeboten', zweiWege === 'email,whatsapp', zweiWege);
  await p.click('[data-chan="whatsapp"]');
  await p.waitForTimeout(250);
  const perWa = { schritt: await schritt(p), deliver: (await posts(p))[1].deliver,
    text: await p.evaluate(function () { return document.body.innerText; }) };
  ok('4b. … und der Code geht wirklich dorthin',
    perWa.schritt === 'verify' && perWa.deliver === 'whatsapp' && /WhatsApp/.test(perWa.text),
    JSON.stringify({ s: perWa.schritt, d: perWa.deliver }));
  await p.close();

  // ── 4. Kein Konto: sagen, was los ist, statt „Fehler aufgetreten" ──
  p = await seite([{ json: { ok: true, step: 'notfound' } }]);
  await ausfuellen(p);
  const nichtGefunden = await fehlermeldung(p);
  ok('5. Kein Treffer nennt den Grund',
    /kein Konto/i.test(nichtGefunden) && !/Es ist ein Fehler aufgetreten/.test(nichtGefunden), nichtGefunden);
  await p.close();

  // ── 5. Mehrere Konten: nach der Mitgliedsnummer fragen ──
  p = await seite([{ json: { ok: true, step: 'number' } }]);
  await ausfuellen(p);
  const mehrere = { schritt: await schritt(p),
    feld: await p.evaluate(function () { return !!document.querySelector('#l_num'); }),
    text: await fehlermeldung(p) };
  ok('6. Mehrere Konten fragen nach der Mitgliedsnummer',
    mehrere.schritt === 'number' && mehrere.feld === true && /Mitgliedsnummer/.test(mehrere.text),
    JSON.stringify(mehrere));
  await p.close();

  // ── 6. Zu viele Versuche: der Grund ist nicht „unbekannter Fehler" ──
  p = await seite([{ status: 429, json: { error: 'rate_limited' } }]);
  await ausfuellen(p);
  const gebremst = await fehlermeldung(p);
  ok('7. Rate-Limit wird als solches benannt',
    /Versuche/i.test(gebremst) && !/Es ist ein Fehler aufgetreten/.test(gebremst), gebremst);
  await p.close();

  // ── 7. „Code erneut senden" darf nicht wieder bei der Kanalauswahl landen ──
  p = await seite([
    { json: { ok: true, step: 'channel', channels: [{ type: 'email', hint: 'j•••@beispiel.de' }] } },
    { json: { ok: true, step: 'code', challenge: 'abc123', via: 'email', delivered: true } },
    { json: { ok: true, step: 'code', challenge: 'abc456', via: 'email', delivered: true } },
  ]);
  await ausfuellen(p);
  await p.click('[data-chan="email"]');
  await p.waitForTimeout(250);
  await p.click('#l_resend');
  await p.waitForTimeout(250);
  const alleP = await posts(p);
  const erneut = { schritt: await schritt(p), anzahl: alleP.length, letzter: alleP[alleP.length - 1] };
  ok('8. „Erneut senden" schickt direkt neu, statt zurueckzuspringen',
    erneut.schritt === 'verify' && erneut.anzahl === 3 && erneut.letzter.deliver === 'email',
    JSON.stringify(erneut));
  await p.close();

  // ── 8. Gesperrter Speicher darf die Seite nicht toeten ──
  // Im Browser einer App (Instagram, Facebook) oder im privaten Fenster wirft
  // der Zugriff. Ungekapselt bliebe die Seite weiss - ohne Anmeldung, ohne
  // Fehlermeldung, ohne alles.
  p = await b.newPage({ viewport: { width: 420, height: 900 } });
  p.on('pageerror', function (e) { fehler.push('bei gesperrtem Speicher: ' + e.message); });
  await p.addInitScript(function () {
    const werfen = { getItem: function () { throw new Error('blocked'); },
      setItem: function () { throw new Error('blocked'); },
      removeItem: function () { throw new Error('blocked'); } };
    try { Object.defineProperty(window, 'localStorage', { get: function () { return werfen; } }); } catch (e) {}
    try { Object.defineProperty(window, 'sessionStorage', { get: function () { return werfen; } }); } catch (e) {}
  });
  await p.goto(URL_, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(300);
  const gesperrt = await p.evaluate(function () {
    return { formular: !!document.querySelector('#l_email'), leer: document.body.innerText.trim().length < 40 };
  });
  ok('9. Gesperrter Speicher laesst die Seite trotzdem laufen',
    gesperrt.formular === true && gesperrt.leer === false, JSON.stringify(gesperrt));
  await p.close();

  ok('10. Kein Skriptfehler auf dem ganzen Weg', fehler.length === 0, fehler.join(' | '));

  await b.close();
  server.close();
  console.log(pass ? 'WERBEN-LOGIN PASS' : 'WERBEN-LOGIN FAIL');
  process.exit(pass ? 0 : 1);
})();
