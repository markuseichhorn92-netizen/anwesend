'use strict';
// Der Anmelde-Code per WhatsApp.
//
// Es kam schlicht keiner an. Der Grund lag nicht bei WhatsApp, sondern im
// Aufruf: bei Meta haengt die Form davon ab, welche ART Vorlage hinterlegt ist.
// Eine Vorlage der Kategorie "Authentifizierung" hat seit dem 2.10.2023 zwingend
// einen Einmalpasswort-Knopf - und dann muss der Code ZWEIMAL im Aufruf stehen,
// einmal im Text und einmal im Knopf. Wir schickten ihn nur einmal. Meta lehnte
// mit (#132000) ab, der Login wich still auf E-Mail aus, und in den Logs stand
// nur `ok:false` ohne Grund. Also: nie ein Code, nie eine Spur.
//
// Der Test haelt beides fest - die richtige Form UND dass der Grund sichtbar
// wird, ohne dass Rufnummer, Adresse oder der Code selbst im Log landen.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
};
const frisch = (rel) => { delete require.cache[path.resolve(ROOT, rel)]; return require(path.resolve(ROOT, rel)); };

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// Meta-Antworten nachstellen. `regel(payload)` entscheidet je Aufruf.
let regel = null;
const aufrufe = [];
function fetchMock(url, opts) {
  const payload = JSON.parse(opts.body);
  aufrufe.push(payload);
  const a = regel(payload);
  return Promise.resolve({
    ok: !!a.ok,
    status: a.status || (a.ok ? 200 : 400),
    text: () => Promise.resolve(JSON.stringify(a.body || {})),
  });
}

// Eine Vorlage der Kategorie "Authentifizierung": ohne Knopf -> (#132000).
function alsAuthVorlage(payload) {
  const comps = payload.template.components || [];
  const knopf = comps.filter((c) => c.type === 'button')[0];
  if (!knopf) {
    return { ok: false, status: 400, body: { error: {
      message: '(#132000) Number of parameters does not match the expected number of params',
      code: 132000, type: 'OAuthException',
      error_data: { details: 'body: number of localizable_params (1) does not match the expected number of params (2)' },
    } } };
  }
  return { ok: true, body: { messages: [{ id: 'wamid.OK1' }] } };
}
// Eine Vorlage der Kategorie "Utility": MIT Knopf -> ebenfalls (#132000).
function alsUtilityVorlage(payload) {
  const comps = payload.template.components || [];
  if (comps.filter((c) => c.type === 'button').length) {
    return { ok: false, status: 400, body: { error: { message: '(#132000) Number of parameters does not match', code: 132000 } } };
  }
  return { ok: true, body: { messages: [{ id: 'wamid.OK2' }] } };
}

function ladeWA(env) {
  Object.keys(env).forEach((k) => { if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; });
  return frisch('lib/whatsapp.js');
}

const BASIS = {
  WA_TOKEN: 't', WA_PHONE_NUMBER_ID: '123', WA_LOGIN_TEMPLATE: 'anmelde_code',
  WA_LOGIN_TEMPLATE_LANG: null, WA_LOGIN_TEMPLATE_AUTH: null,
  TWILIO_ACCOUNT_SID: null, TWILIO_AUTH_TOKEN: null, TWILIO_WHATSAPP_FROM: null, TWILIO_LOGIN_CONTENT_SID: null,
  WA_RETRIES: '0',
};

// Der Code darf im Aufruf stehen (das ist ja sein Zweck) – hier pruefen wir nur,
// WIE oft und WO.
function codeStellen(payload, code) {
  const comps = payload.template.components || [];
  let n = 0;
  comps.forEach((c) => (c.parameters || []).forEach((p) => { if (String(p.text) === code) n++; }));
  return n;
}

async function run() {
  global.fetch = fetchMock;

  // ── 1. Authentifizierungs-Vorlage: der Code muss ZWEIMAL rein ──
  let WA = ladeWA(BASIS);
  regel = alsAuthVorlage;
  aufrufe.length = 0;
  let r = await WA.sendLoginTemplate('+4915100000000', '123456');
  ok('1. Bei einer Authentifizierungs-Vorlage geht der Code raus', r && r.ok === true, JSON.stringify(r));
  const zweiter = aufrufe[1];
  ok('1b. … nachdem die reine Textform abgelehnt wurde', aufrufe.length === 2, aufrufe.length + ' Aufrufe');
  ok('1c. … und im zweiten Aufruf steht der Code zweimal',
    zweiter && codeStellen(zweiter, '123456') === 2, JSON.stringify(zweiter && zweiter.template.components));
  const knopf = zweiter && (zweiter.template.components || []).filter((c) => c.type === 'button')[0];
  ok('1d. … einmal davon im Einmalpasswort-Knopf',
    knopf && knopf.sub_type === 'url' && String(knopf.index) === '0'
      && knopf.parameters[0].text === '123456', JSON.stringify(knopf));

  // ── 2. Die passende Form wird gemerkt ──
  // Sonst kostet jede Anmeldung dauerhaft einen Fehlaufruf extra.
  aufrufe.length = 0;
  r = await WA.sendLoginTemplate('+4915100000000', '654321');
  ok('2. Beim naechsten Mal geht es direkt richtig raus',
    r && r.ok === true && aufrufe.length === 1, aufrufe.length + ' Aufrufe');

  // ── 3. Umgekehrt genauso: Utility-Vorlage ──
  WA = ladeWA(BASIS);
  regel = alsUtilityVorlage;
  aufrufe.length = 0;
  r = await WA.sendLoginTemplate('+4915100000000', '111222');
  ok('3. Eine reine Textvorlage funktioniert unveraendert weiter',
    r && r.ok === true && aufrufe.length === 1 && codeStellen(aufrufe[0], '111222') === 1,
    JSON.stringify({ n: aufrufe.length, r: r && r.ok }));

  // ── 4. Festnageln per Umgebungsvariable ──
  WA = ladeWA(Object.assign({}, BASIS, { WA_LOGIN_TEMPLATE_AUTH: '1' }));
  regel = alsAuthVorlage;
  aufrufe.length = 0;
  r = await WA.sendLoginTemplate('+4915100000000', '333444');
  ok('4. WA_LOGIN_TEMPLATE_AUTH=1 nimmt sofort die Authentifizierungs-Form',
    r && r.ok === true && aufrufe.length === 1, JSON.stringify({ n: aufrufe.length }));

  // ── 5. Sprachschluessel ist einstellbar ──
  WA = ladeWA(Object.assign({}, BASIS, { WA_LOGIN_TEMPLATE_LANG: 'de_DE' }));
  regel = alsUtilityVorlage;
  aufrufe.length = 0;
  await WA.sendLoginTemplate('+4915100000000', '555666');
  ok('5. Der Sprachschluessel der Vorlage laesst sich setzen',
    aufrufe[0] && aufrufe[0].template.language.code === 'de_DE', JSON.stringify(aufrufe[0] && aufrufe[0].template.language));

  // ── 6. Ein echter Fehler wird NICHT endlos umprobiert ──
  WA = ladeWA(BASIS);
  regel = () => ({ ok: false, status: 400, body: { error: { message: 'template name does not exist in de', code: 132001 } } });
  aufrufe.length = 0;
  r = await WA.sendLoginTemplate('+4915100000000', '777888');
  ok('6. Eine fehlende Vorlage wird nicht in anderer Form nochmal versucht',
    r && r.ok !== true && aufrufe.length === 1, JSON.stringify({ n: aufrufe.length }));

  // ── 7. Der Grund ist lesbar – aber ohne alles, was nicht ins Log darf ──
  const info = WA.fehlerInfo({
    status: 400,
    body: JSON.stringify({ error: {
      message: '(#131030) Recipient phone number not in allowed list',
      code: 131030,
      error_data: { details: 'Add recipient phone number +49 151 00000000 (adriane@example.invalid) to recipient list. Code 777888.' },
    } }),
  });
  ok('7. Der Fehlercode des Anbieters steht im Klartext da', info && info.code === 131030, JSON.stringify(info));
  const txt = JSON.stringify(info);
  ok('7b. … aber ohne Rufnummer', txt.indexOf('49151') < 0 && txt.indexOf('151 00000000') < 0 && txt.indexOf('00000000') < 0, txt);
  ok('7c. … ohne E-Mail-Adresse', txt.indexOf('example.invalid') < 0 && txt.indexOf('adriane@') < 0, txt);
  ok('7d. … und ohne den Anmelde-Code', txt.indexOf('777888') < 0, txt);
  ok('7e. … der Grund selbst bleibt aber erkennbar', /not in allowed list/.test(String(info.text || '')), txt);

  // ── 8. Der Fehlschlag taucht ueberhaupt im Log auf ──
  // Vorher stand dort nur `ok:false`. Genau deshalb war der Fehler unsichtbar.
  inject('lib/store.js', { hasStore: false, redisPipeline: async () => { throw new Error('kein Speicher'); } });
  inject('lib/mail.js', { hasMail: false, sendMailRaw: async () => ({ ok: false }) });
  inject('lib/emailTemplate.js', { renderEmail: () => ({ text: 't', html: '<p>t</p>' }) });
  inject('lib/members.js', { otpSave: async () => {}, mlinkSave: async () => {}, hashCode: (c) => 'h' + c, getMember: async () => null });
  WA = ladeWA(BASIS);
  regel = () => ({ ok: false, status: 400, body: { error: { message: 'template name does not exist in de', code: 132001 } } });
  inject('lib/whatsapp.js', WA);
  const LC = frisch('lib/loginCode.js');

  const zeilen = [];
  const echt = console.log;
  console.log = function () { zeilen.push(Array.prototype.slice.call(arguments).join(' ')); };
  await LC.sendLoginCode(
    { id: 'm1', firstName: 'Adriane', email: 'a@example.invalid', phonePrivate: '+4915100000000' },
    'host.example', { channel: 'whatsapp', phone: '+4915100000000' });
  console.log = echt;

  const h = zeilen.filter((z) => z.indexOf('otp_handover') === 0)
    .map((z) => { try { return JSON.parse(z.slice('otp_handover '.length)); } catch (e) { return {}; } })
    .filter((x) => x.via === 'whatsapp')[0];
  ok('8. Ein abgelehnter WhatsApp-Versand nennt jetzt den Grund',
    h && h.ok === false && h.code === 132001 && /does not exist/.test(String(h.grund || '')), JSON.stringify(h));
  const alles = zeilen.join(' | ');
  ok('8b. … und schreibt weiterhin weder Nummer noch Adresse noch Name ins Log',
    alles.indexOf('4915100000000') < 0 && alles.indexOf('example.invalid') < 0 && alles.indexOf('Adriane') < 0, alles);

  console.log(pass ? 'WHATSAPP-LOGIN-TEMPLATE PASS' : 'WHATSAPP-LOGIN-TEMPLATE FAIL');
  process.exit(pass ? 0 : 1);
}
run();
