'use strict';
// Phase 4 (Datenschutz + Produkt):
//  - /api/app-info liefert serverseitige Feature-Flags, opt-in, Standard AUS
//  - Demo-Buddy (lib/social) ist opt-in (SOCIAL_DEMO=1), in Produktion aus
//  - Client: Launch-Flags kommen vom Server (fi_flags_srv), Testmodus nur bei
//    serverseitig erlaubtem Demo-Modus; keine negativen Vitalpunkte mehr;
//    „Fitness-Alter" ist transparent als „Aktivitäts-Alter" benannt
//  - KI-Datenminimierung: kein Nachname/keine Mitgliedsnummer in KI-Prompts
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const fresh = (rel) => {
  const p = path.resolve(ROOT, rel);
  delete require.cache[p];
  return require(p);
};
function res0() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, body: null, end(s) { this.body = s; } }; }

async function run() {
  let pass = true; const ok = (l, c) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l); };

  // ── /api/app-info: Ernährung gelauncht (Standard AN, FEATURE_ERN=0 = Notaus);
  //    Community + Demo bleiben opt-in (nur exakt "1") ──
  delete process.env.FEATURE_ERN; delete process.env.FEATURE_SOCIAL; delete process.env.FEATURE_DEMO;
  delete process.env.APP_STORE_URL_IOS; delete process.env.APP_STORE_URL_ANDROID;
  let r = res0(); fresh('api/app-info.js')({}, r);
  let j = JSON.parse(r.body);
  ok('1. ohne Env: Ernährung AN, Social/Demo AUS', r.statusCode === 200
    && j.features && j.features.ern === true && j.features.social === false && j.features.demo === false);

  process.env.FEATURE_ERN = '0'; process.env.FEATURE_SOCIAL = 'true'; process.env.FEATURE_DEMO = '0';
  r = res0(); fresh('api/app-info.js')({}, r); j = JSON.parse(r.body);
  ok('2. FEATURE_ERN=0 = Notaus; Social/Demo zählen nur bei exakt "1"', j.features.ern === false && j.features.social === false && j.features.demo === false);
  delete process.env.FEATURE_ERN; delete process.env.FEATURE_SOCIAL; delete process.env.FEATURE_DEMO;

  process.env.APP_STORE_URL_IOS = 'http://unsicher.example/app';
  process.env.APP_STORE_URL_ANDROID = 'https://play.google.com/store/apps/details?id=x';
  r = res0(); fresh('api/app-info.js')({}, r); j = JSON.parse(r.body);
  ok('3. Store-Links nur mit https://', j.ios === null && /^https:\/\//.test(j.android));
  delete process.env.APP_STORE_URL_IOS; delete process.env.APP_STORE_URL_ANDROID;

  // ── Demo-Buddy: opt-in über SOCIAL_DEMO=1 ──
  const fakePipeline = async (cmds) => cmds.map((c) => {
    const op = c[0], key = String(c[1] || '');
    if (op === 'GET' && key.indexOf('soc:me:') === 0) {
      return JSON.stringify({ enabled: true, consentAt: 1, displayName: 'Tester', code: 'ABC234', share: {} });
    }
    if (op === 'GET') return null;   // kein Code-Mapping vorhanden
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline: fakePipeline });
  inject('lib/push.js', { hasPush: false, sendToMember: async () => ({}) });

  delete process.env.SOCIAL_DEMO;
  let Social = fresh('lib/social.js');
  let c = await Social.connectByCode('M1', 'TEST99');
  ok('4. ohne SOCIAL_DEMO: TEST99 verbindet NICHT (Produktion sauber)', c.ok === false && c.error === 'not_found');

  process.env.SOCIAL_DEMO = '1';
  Social = fresh('lib/social.js');
  c = await Social.connectByCode('M1', 'TEST99');
  ok('5. SOCIAL_DEMO=1 (Staging): Demo-Buddy verbindet', c.ok === true && c.status === 'connected');
  delete process.env.SOCIAL_DEMO;

  // ── Client-Verdrahtung + Produkt-Texte (statische Prüfung) ──
  const html = fs.readFileSync(path.join(ROOT, 'mitglieder.html'), 'utf8');
  ok('6. Client liest Server-Flags (fi_flags_srv), Ernährung standardmäßig AN',
    html.indexOf('fi_flags_srv') >= 0 && /var ERN_LAUNCH=srvFlags\(\)\.ern!==false/.test(html) && !/var SOCIAL_LAUNCH\s*=\s*false/.test(html));
  ok('7. Testmodus nur bei Server-Demo-Flag', /srvFlags\(\)\.demo===true/.test(html));
  ok('8. keine negativen Vitalpunkte mehr (Pausen neutral)', !/pts:\s*-/.test(html) && html.indexOf('kein Punktabzug') >= 0);
  ok('9. „Aktivitäts-Alter" statt „Fitness-Alter" + Berechnungsbasis sichtbar',
    html.indexOf('Aktivitäts-Alter') >= 0 && !/>Fitness-Alter</.test(html) && !/pill\('Fit-Alter/.test(html)
    && html.indexOf('Check-ins der letzten 8 Wochen') >= 0);
  ok('10. keine „keine Daten an Dritte"-Pauschalaussage mehr',
    html.indexOf('Deine Daten werden nicht an Dritte weitergegeben') < 0 && html.indexOf('nichts wird an Dritte gegeben') < 0);

  // ── KI-Datenminimierung ──
  const coach = fs.readFileSync(path.join(ROOT, 'api/member/coach.js'), 'utf8');
  const coachMember = coach.slice(coach.indexOf('const member = {'), coach.indexOf('const member = {') + 160);
  ok('11. FINN-Chat: kein Nachname/keine Mitgliedsnummer im KI-Kontext',
    coachMember.indexOf('firstName') >= 0 && coachMember.indexOf('lastName') < 0 && coachMember.indexOf('customerNumber') < 0);
  const ai = fs.readFileSync(path.join(ROOT, 'lib/ai.js'), 'utf8');
  ok('12. coachSystem/draftReply: nur Vorname geht an die KI',
    !/coachSystem[\s\S]{0,600}lastName/.test(ai) && /draftReply[\s\S]{0,600}split\(\/\\s\+\//.test(ai));
  const ret = fs.readFileSync(path.join(ROOT, 'api/team/retention.js'), 'utf8');
  ok('13. Winback: nur Vorname geht an die KI', !/winbackSuggest\(\{[\s\S]{0,200}lastName/.test(ret) && ret.indexOf("m.firstName) name = String(m.firstName).trim()") >= 0);

  console.log(pass ? 'FEATURE-FLAGS PASS' : 'FEATURE-FLAGS FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
