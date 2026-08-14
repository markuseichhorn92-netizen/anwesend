'use strict';
// Kuendigungslink per E-Mail.
//
// Die Gefahr liegt hier nicht beim Datenschutz, sondern in der Erwartung: Wer
// anruft und „ich moechte kuendigen" sagt, darf hinterher NICHT glauben, es sei
// erledigt. Passiert das, laeuft der Vertrag weiter und niemand merkt es, bis
// die naechste Abbuchung kommt. Deshalb prueft dieser Test vor allem, was NICHT
// gesagt und NICHT behauptet wird.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
}

// ── Aufbau ──
let mails = [];
let vertrag = {
  contractId: 'c-1', rateName: 'Fit-Inn Komfort', endDate: '28.02.2027',
  deadline: '30.11.2026', deadlinePassed: false, cancellationPeriod: '3 Monate',
  nextCancellationDate: '28.02.2028', cancelled: false, active: true,
};
let linkOk = true;
let limitFrei = true;

stub('lib/mail.js', {
  hasMail: true,
  sendMailRaw: async (o) => { mails.push(o); return { ok: true }; },
  sendMail: async () => ({ ok: true }), TO: 'info@x.de',
});
stub('lib/actionlink.js', {
  create: async (o) => (linkOk
    ? { ok: true, token: 't1', url: 'https://mitglieder.fit-inn-trier.de/mitglieder?alt=t1',
        action: o.action, label: 'Mitgliedschaft kündigen', expiresAt: 111 }
    : { ok: false, error: 'no_store' }),
  TTL_DAYS: 7,
});
stub('lib/members.js', {
  getMember: async () => ({ id: '4711', firstName: 'Markus', lastName: 'Eichhorn', email: 'markus@example.de' }),
  getContract: async () => vertrag,
  rateLimit: async () => limitFrei,
  findByPhone: async () => ({ id: '4711', firstName: 'Markus', email: 'markus@example.de' }),
  normDePhone: (p) => String(p || '').replace(/[^\d]/g, ''),
});

// Der Vorlagen-Renderer laeuft echt: sonst wuerde nicht auffallen, wenn ein
// Pflichtsatz gar nicht im Text landet.
const { sendCancelLink } = require(path.join(ROOT, 'lib/cancelLink.js'));

(async function () {
  // ── 1. Der Normalfall ──
  mails = [];
  let r = await sendCancelLink({ id: '4711', firstName: 'Markus', email: 'markus@example.de' }, { quelle: 'telefon' });
  ok('1. Der Link geht raus', r.ok === true, JSON.stringify(r));
  ok('1b. Genau eine Mail', mails.length === 1, String(mails.length));
  const m = mails[0] || {};
  ok('1c. … an die hinterlegte Adresse', m.to === 'markus@example.de', String(m.to));
  ok('1d. … mit erkennbarem Betreff', /Kündigung/.test(m.subject || ''), m.subject);
  ok('1e. … und dem Link im Text', /alt=t1/.test(m.text || ''), (m.text || '').slice(0, 120));

  // Der wichtigste Satz: die Mail ist noch keine Kuendigung.
  ok('2. Der Text sagt ausdruecklich, dass noch nichts gekuendigt ist',
    /noch nichts gekündigt/i.test(m.text || ''), (m.text || '').slice(0, 400));
  ok('2b. … auch in der HTML-Fassung', /noch nichts gekündigt/i.test(m.html || ''));

  // Die Fristen gehoeren hinein, sonst weiss niemand, ob es noch reicht.
  ok('3. Die Frist steht in der Mail', /30\.11\.2026/.test(m.text || ''), (m.text || '').slice(0, 400));
  ok('3b. Das Laufzeitende steht drin', /28\.02\.2027/.test(m.text || ''));
  ok('3c. Der Tarif steht drin', /Fit-Inn Komfort/.test(m.text || ''));
  // Die maskierte Adresse darf am Telefon genannt werden, die echte nicht.
  ok('3d. Zurueck kommt nur die maskierte Adresse',
    r.emailHinweis === 'm***@example.de', String(r.emailHinweis));

  // Eine Kuendigungsmail ist kein Ort fuer Angebote.
  ok('4. Kein Werbeblock in der Kuendigungsmail',
    !/5-Euro|Aktion|Angebot|Rabatt/i.test(m.text || ''), (m.text || '').slice(-300));

  // ── 5. Bereits gekuendigt ──
  mails = [];
  vertrag = Object.assign({}, vertrag, { cancelled: true });
  r = await sendCancelLink({ id: '4711', email: 'markus@example.de' }, {});
  ok('5. Auch bei bestehender Kuendigung kommt eine Mail', r.ok === true && mails.length === 1);
  ok('5b. … die als solche gekennzeichnet ist', r.schonGekuendigt === true);
  ok('5c. … und nicht zu einer zweiten Kuendigung auffordert',
    !/noch nichts gekündigt/i.test(mails[0].text || '') && /bereits gekündigt/i.test(mails[0].text || ''),
    (mails[0].text || '').slice(0, 200));
  vertrag = Object.assign({}, vertrag, { cancelled: false });

  // ── 6. Wenn etwas fehlschlaegt, wird NICHTS behauptet ──
  mails = [];
  linkOk = false;
  r = await sendCancelLink({ id: '4711', email: 'markus@example.de' }, {});
  ok('6. Ohne Link keine Mail', r.ok === false && mails.length === 0, JSON.stringify(r));
  ok('6b. … mit nachvollziehbarem Grund', r.grund === 'no_store', String(r.grund));
  linkOk = true;

  // hasMail wird beim Laden EINMAL ausgelesen - in Produktion eine Konstante aus
  // der Umgebung, die sich zur Laufzeit nie aendert. Fuer diesen Fall also das
  // Modul frisch laden, statt am laufenden umzuschalten.
  mails = [];
  delete require.cache[require.resolve(path.join(ROOT, 'lib/cancelLink.js'))];
  stub('lib/mail.js', {
    hasMail: false,
    sendMailRaw: async (o) => { mails.push(o); return { ok: true }; },
    sendMail: async () => ({ ok: true }), TO: 'info@x.de',
  });
  const ohneMailer = require(path.join(ROOT, 'lib/cancelLink.js'));
  r = await ohneMailer.sendCancelLink({ id: '4711', email: 'markus@example.de' }, {});
  ok('7. Ohne Mailer wird kein Erfolg gemeldet', r.ok === false && r.grund === 'kein_mailer', JSON.stringify(r));
  ok('7b. … und es geht nichts raus', mails.length === 0, String(mails.length));
  // Fuer die restlichen Faelle wieder den funktionierenden Mailer.
  delete require.cache[require.resolve(path.join(ROOT, 'lib/cancelLink.js'))];
  stub('lib/mail.js', {
    hasMail: true,
    sendMailRaw: async (o) => { mails.push(o); return { ok: true }; },
    sendMail: async () => ({ ok: true }), TO: 'info@x.de',
  });
  const wieder = require(path.join(ROOT, 'lib/cancelLink.js'));

  mails = [];
  limitFrei = false;
  r = await wieder.sendCancelLink({ id: '4711', email: 'markus@example.de' }, {});
  ok('8. Wiederholtes Anfordern wird begrenzt', r.ok === false && r.grund === 'zu_oft', JSON.stringify(r));
  ok('8b. … und verschickt dabei nichts', mails.length === 0);
  limitFrei = true;

  // ── 9. Ohne Mitglied gar nichts ──
  mails = [];
  r = await wieder.sendCancelLink(null, {});
  ok('9. Ohne Mitglied kein Versand', r.ok === false && mails.length === 0);

  console.log(pass ? 'CANCEL-LINK PASS' : 'CANCEL-LINK FAIL');
  process.exit(pass ? 0 : 1);
})();
