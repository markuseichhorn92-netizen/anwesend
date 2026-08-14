'use strict';
// Telefon-Auskunft zum eigenen Vertrag.
//
// Der Anlass fuer diesen Test: die erste Fassung las `ct.tariffName`,
// `ct.monthlyPrice` und `ct.lastPossibleCancellationDate` - alles drei gibt es
// in getContract nicht. Das faellt nirgends auf, weil undefined kein Fehler ist:
// der Endpunkt haette brav geantwortet, nur ohne einen einzigen Wert. Und ein
// Assistent, der keine Werte bekommt, erfindet sie (im Mitschnitt: „Dein Vertrag
// laeuft noch" - ohne jede Datengrundlage).
//
// Deshalb prueft Teil 1 die Feldnamen GEGEN lib/members.js, statt sie hier
// noch einmal zu behaupten.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = true;
const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

// ── Teil 1: Feldnamen-Abgleich ──
const membersSrc = fs.readFileSync(path.join(ROOT, 'lib/members.js'), 'utf8');
const memberApi = fs.readFileSync(path.join(ROOT, 'api/phone/member.js'), 'utf8');

// Den return-Block von getContract herausschneiden und die Schluessel sammeln.
const gcStart = membersSrc.indexOf('async function getContract');
const retStart = membersSrc.indexOf('return {', gcStart);
const retEnde = membersSrc.indexOf('\n  };', retStart);
const retBlock = membersSrc.slice(retStart, retEnde);
const echteFelder = new Set();
for (const m of retBlock.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9_]*)\s*:/gm)) echteFelder.add(m[1]);
ok('1. getContract-Felder gefunden', echteFelder.size > 10, String(echteFelder.size));

// Alles, was der Endpunkt am Vertragsobjekt anfasst.
const benutzt = new Set();
for (const m of memberApi.matchAll(/\bct\.([A-Za-z][A-Za-z0-9_]*)/g)) benutzt.add(m[1]);
ok('1b. Endpunkt greift auf Vertragsfelder zu', benutzt.size > 3, String(benutzt.size));

const erfunden = Array.from(benutzt).filter((f) => !echteFelder.has(f));
ok('2. Der Endpunkt liest NUR Felder, die getContract wirklich liefert',
  erfunden.length === 0, 'erfunden: ' + erfunden.join(', '));

// Die Frage aus dem Mitschnitt („seit wann habe ich meinen Vertrag?") muss
// beantwortbar sein - das Feld gibt es, es war nur nicht angebunden.
ok('3. Vertragsbeginn wird ausgewertet', benutzt.has('startDate'));
ok('3b. Kuendigungsfrist wird ausgewertet', benutzt.has('cancellationPeriod'));

// ── Teil 2: Der Endpunkt im Lauf ──
// Aufgesetzt wird nur, was von aussen kommt; der Endpunkt selbst laeuft echt.
const VERTRAG = {
  contractId: 'c-1', rateName: 'Fit-Inn Komfort', price: 39.9,
  paymentFrequencyUnit: 'MONTH', weeklyPrice: null,
  startDate: '01.03.2024', cancelled: false, cancellationDate: null,
  reversed: false, active: true, endDate: '28.02.2027', endDateISO: '2027-02-28',
  deadline: '30.11.2026', deadlinePassed: false,
  cancellationPeriod: '3 Monate', nextCancellationDate: '28.02.2028',
  nextCancellationDateISO: '2028-02-28', contractOrigin: null, online: false,
  withdrawalEligible: false, withdrawalDeadline: null, withdrawalDaysLeft: null,
};

function stub(rel, exports) {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
}

let verifiziert = true;
let abgemeldet = false;
stub('lib/phoneApi.js', {
  json: (res, code, body) => { res._code = code; res._body = body; return body; },
  readBody: async (req) => req._body || {},
  guard: async () => ({ ok: true }),
  logAttempt: () => {},
});
// Steuerbar, um die Faelle „keine Nummer hinterlegt" und „keine E-Mail" zu bauen.
let perTelefon = { id: '4711', firstName: 'Markus', email: 'x@y.z' };
let perNummerDob = null;
let perMailDob = null;
let vollprofil = { id: '4711', firstName: 'Markus', email: 'x@y.z', phonePrivate: '015120442244' };
stub('lib/members.js', {
  getContract: async () => VERTRAG,
  findByPhone: async () => perTelefon,
  findByNumberDob: async () => perNummerDob,
  findByEmailDob: async () => perMailDob,
  getMember: async () => vollprofil,
  rateLimit: async () => true,
  normDePhone: (p) => String(p || '').replace(/[^\d]/g, ''),
  hashCode: (c) => 'h' + c, otpGet: async () => null, otpDel: async () => {}, otpSave: async () => {},
});
stub('lib/phoneAuth.js', {
  // quelle 'whatsapp' heisst: die Verifizierung liegt in einem ANDEREN Kanal.
  // clearVerified raeumt nur den Telefon-Schluessel weg - der Status bleibt also
  // bestehen. Genau dieses Verhalten wird unten geprueft.
  status: async () => ({
    verified: verifiziert, memberId: verifiziert ? '4711' : null,
    quelle: verifiziert ? 'whatsapp' : null, consentVersion: verifiziert ? 'v1' : null,
  }),
  clearVerified: async () => { abgemeldet = true; return true; },
  touch: async () => {}, setVerified: async () => true, saveChallenge: async () => true,
  checkCode: async () => ({ ok: false, memberId: null, grund: 'ungueltig' }),
  CONSENT_VERSION: 'v1',
});
stub('lib/mlMembership.js', {
  idleConfig: async () => ({ available: true, firstPossibleStartDate: '2026-09-01', fee: 15 }),
  idleRemaining: async () => ({ ok: true, freeTerms: 2, maxTerms: 3 }),
  idleList: async () => ({ ok: true, current: [] }),
});
stub('lib/loginCode.js', { sendLoginCode: async () => ({ challenge: 'ch', channel: 'email' }) });
let studioMails = [];
let studioOk = true;
stub('lib/studioReply.js', {
  notifyStudio: async (o) => { studioMails.push(o); return studioOk ? { ok: true } : { ok: false }; },
});

const handler = require(path.join(ROOT, 'api/phone/member.js'));

async function ruf(aktion, extra) {
  const req = { method: 'POST', headers: {}, _body: Object.assign({ aktion: aktion, phone: '015120442244' }, extra || {}) };
  const res = { setHeader: () => {}, end: () => {} };
  await handler(req, res);
  return res._body || {};
}

(async function () {
  // Der eigentliche Punkt: es muessen WERTE im gesprochenen Satz stehen.
  const v = await ruf('vertrag');
  ok('4. Auskunft gelingt', v.ok === true, JSON.stringify(v));
  ok('4b. Der Tarif steht im gesprochenen Satz', /Fit-Inn Komfort/.test(v.text || ''), v.text);
  ok('4c. Der Vertragsbeginn steht drin', /01\.03\.2024/.test(v.text || ''), v.text);
  ok('4d. Das Laufzeitende steht drin', /28\.02\.2027/.test(v.text || ''), v.text);
  ok('4e. Die Kuendigungsfrist steht drin', /30\.11\.2026/.test(v.text || ''), v.text);
  // Ein Beitrag ohne Zahlweise ist nichtssagend - 39,90 was, pro Woche?
  ok('4f. Der Beitrag steht drin, MIT Zahlweise',
    /39,90 Euro im Monat/.test(v.text || ''), v.text);
  // Kein Feld darf als "undefined"/"null" vorgelesen werden.
  ok('4g. Kein undefined/null im gesprochenen Satz',
    !/undefined|null|NaN/.test(v.text || ''), v.text);
  ok('4h. Die Werte stehen auch strukturiert bereit',
    v.vertrag && v.vertrag.beginn === '01.03.2024' && v.vertrag.tarif === 'Fit-Inn Komfort',
    JSON.stringify(v.vertrag));
  // Die allgemeinen AGB-Fristen passen nicht zwangslaeufig zu diesem Vertrag.
  ok('4i. Der Assistent wird von der Wissensdatenbank weggewiesen',
    /Wissensdatenbank/i.test(v.naechsterSchritt || ''), v.naechsterSchritt);

  // „beginn" und „beitrag" als eigene Aktionen - der Anrufer fragt so.
  ok('5. aktion=beginn beantwortet dieselbe Frage', (await ruf('beginn')).ok === true);
  ok('5b. aktion=beitrag ebenso', (await ruf('beitrag')).ok === true);

  // ── Ohne Ausweis kommt nichts heraus ──
  verifiziert = false;
  const gesperrt = await ruf('vertrag');
  ok('6. Ohne Ausweis keine Vertragsauskunft', gesperrt.ok === false, JSON.stringify(gesperrt));
  ok('6b. … und im Text steht KEIN einziger Vertragswert',
    !/Komfort|39,90|2027|2024/.test(gesperrt.text || ''), gesperrt.text);
  ok('6c. … und auch kein strukturierter Wert', !gesperrt.vertrag, JSON.stringify(gesperrt.vertrag));
  const pauseGesperrt = await ruf('pause');
  ok('6d. Auch die Pause bleibt zu', pauseGesperrt.ok === false && !pauseGesperrt.pause);

  // ── Gesundheitsdaten bleiben am Telefon draussen ──
  verifiziert = true;
  const g = await ruf('training');
  ok('7. Trainingsdaten werden am Telefon abgelehnt', g.ok === false, JSON.stringify(g));
  ok('7b. … mit Verweis auf den Mitgliederbereich', /Mitgliederbereich/.test(g.text || ''), g.text);
  ok('7c. Ernaehrungsdaten ebenso', (await ruf('ernaehrung')).ok === false);

  // ── Pause: Auskunft ja, Einrichten nein ──
  const p = await ruf('pause');
  ok('8. Pausenauskunft gelingt', p.ok === true, JSON.stringify(p));
  ok('8b. … und der Assistent wird vom Zusagen abgehalten',
    /NICHT zusagen und NICHT einrichten/i.test(p.naechsterSchritt || ''), p.naechsterSchritt);
  ok('8c. Kein undefined im Pausentext', !/undefined|null|NaN/.test(p.text || ''), p.text);

  // ── 9. Erneut ausweisen, obwohl schon ausgewiesen ──
  // Wer ueber WhatsApp verifiziert ist, ueberspringt den Code - und bekommt den
  // Ablauf nie zu sehen. Zum Testen muss er sich erzwingen lassen.
  verifiziert = true;
  const schon = await ruf('code');
  ok('9. Ohne neu=true kommt kein Code, weil schon ausgewiesen',
    schon.verifiziert === true && !schon.kanal, JSON.stringify(schon));
  ok('9b. … und die Antwort sagt, WOHER der Ausweis stammt',
    schon.quelle === 'whatsapp', String(schon.quelle));

  const erzwungen = await ruf('code', { neu: true });
  ok('10. Mit neu=true wird trotzdem ein Code verschickt',
    erzwungen.ok === true && erzwungen.kanal === 'email', JSON.stringify(erzwungen));
  ok('10b. … und die Antwort verlangt den Code',
    erzwungen.verifiziert === false, JSON.stringify(erzwungen));
  // Als Text getippt zaehlt genauso - fonio schickt Felder gern als Zeichenkette.
  ok('10c. neu als Zeichenkette wirkt ebenso',
    (await ruf('code', { neu: 'true' })).kanal === 'email');
  // Ein erzwungener Neu-Ausweis darf NICHTS aufweichen: es wird mehr verlangt,
  // nie weniger. Ohne gueltigen Code bleibt es beim Nein.
  ok('10d. Der erzwungene Weg gibt fuer sich genommen keine Daten frei',
    !erzwungen.vertrag && !/Komfort|39,90/.test(erzwungen.text || ''), erzwungen.text);

  // ── 10. Abmelden ──
  abgemeldet = false;
  const ab = await ruf('abmelden');
  ok('11. Abmelden raeumt die Telefon-Verifizierung weg', abgemeldet === true);
  ok('11b. … sagt aber ehrlich, dass WhatsApp weiter gilt',
    ab.verifiziert === true && /WhatsApp/.test(ab.text || ''), JSON.stringify(ab));
  ok('11c. … und weist auf den Weg zum Testen hin',
    /neu=true/.test(ab.naechsterSchritt || ''), ab.naechsterSchritt);

  verifiziert = false;
  const ab2 = await ruf('abmelden');
  ok('12. Ohne anderen Kanal ist danach wirklich Schluss',
    ab2.verifiziert === false, JSON.stringify(ab2));
  ok('12b. … und die Vertragsauskunft ist wieder zu',
    (await ruf('vertrag')).ok === false);

  // ── 11. Anliegen an einen Menschen uebergeben ──
  // Grundsatz: Auskunft gibt der Assistent, HANDELN tut ein Mensch. Der
  // gefaehrlichste Fehler ist derselbe wie zuvor - dass der Anrufer auflegt und
  // glaubt, es sei erledigt.
  verifiziert = false;
  studioMails = [];
  const esk = await ruf('kuendigen', { name: 'Markus Eichhorn', notiz: 'Umzug nach Koeln' });
  ok('13. Das Anliegen geht ohne Ausweis an das Team', esk.ok === true, JSON.stringify(esk));
  ok('13b. … genau eine Uebergabe', studioMails.length === 1, String(studioMails.length));
  const um = studioMails[0] || {};
  ok('13c. … als Kuendigungswunsch erkennbar', /Kündigungswunsch/.test(um.subject || ''), um.subject);

  // Bei einer Kuendigung zaehlt, WANN der Wunsch geaeussert wurde - nicht, wann
  // das Team dazu kommt. Ohne Zeitstempel in der Uebergabe ist das nicht belegbar.
  ok('14. Der Zeitpunkt steht in der Uebergabe',
    /Eingegangen:/.test(um.text || '') && /\d{4}-\d{2}-\d{2}T/.test(um.text || ''),
    (um.text || '').slice(0, 300));
  ok('14b. … und das Team wird auf seine Bedeutung hingewiesen',
    /massgeblich/i.test(um.text || ''), (um.text || '').slice(-400));
  ok('14c. … samt Pflicht zur Bestaetigung in Textform',
    /Textform/i.test(um.text || ''), (um.text || '').slice(-400));

  // Der wichtigste Satz fuer das Team: Wurde die Identitaet geprueft?
  ok('15. Nicht ausgewiesene Anrufer sind als solche gekennzeichnet',
    /AUSGEWIESEN:\s*NEIN/.test(um.text || ''), (um.text || '').slice(0, 500));
  ok('15b. … mit der Aufforderung, vorher zu bestaetigen',
    /Vor dem Handeln bestätigen/.test(um.text || ''), (um.text || '').slice(0, 500));
  ok('15c. Das Gespraechsprotokoll ist dabei', /Umzug nach Koeln/.test(um.text || ''));
  ok('15d. Die Vertragsdaten sind dabei', /Fit-Inn Komfort/.test(um.text || ''));

  verifiziert = true;
  studioMails = [];
  await ruf('kuendigen', { name: 'Markus Eichhorn' });
  ok('16. Ausgewiesene Anrufer sind ebenfalls gekennzeichnet',
    /AUSGEWIESEN:\s*ja/.test(studioMails[0].text || ''), (studioMails[0].text || '').slice(0, 500));

  // Der Anrufer darf NICHT glauben, es sei erledigt.
  ok('17. Es wird nicht behauptet, die Kuendigung sei erfolgt',
    !/(ist|wurde).{0,20}gekündigt|erledigt|storniert/i.test(esk.text || ''), esk.text);
  ok('17b. … sondern nur, dass es weitergegeben wurde',
    /weitergegeben/i.test(esk.text || ''), esk.text);
  ok('17c. … und der Assistent wird davon abgehalten, mehr zu sagen',
    /NICHT sagen/.test(esk.naechsterSchritt || ''), esk.naechsterSchritt);
  // Fuer die Frist ist der Anruftag entscheidend - das gehoert dem Anrufer gesagt.
  ok('17d. … und der Anrufer erfaehrt, dass der heutige Tag zaehlt',
    /heutige Tag/.test(esk.text || ''), esk.text);

  // Pause ist ebenfalls eine Aktion - also auch Uebergabe, kein Einrichten.
  studioMails = [];
  const eskP = await ruf('eskalieren', { anliegen: 'pause', notiz: 'Januar bis Maerz' });
  ok('18. Auch die Pause geht an einen Menschen',
    eskP.ok === true && /Pausenwunsch/.test(studioMails[0].subject || ''), eskP.text);
  ok('18b. … ohne sie zuzusagen',
    !/(ist|wurde).{0,20}(pausiert|eingerichtet)/i.test(eskP.text || ''), eskP.text);

  // Die Pausen-AUSKUNFT bleibt erlaubt, weist aber auf die Uebergabe hin.
  const pAusk = await ruf('pause');
  ok('19. Die Pausenauskunft verweist auf die Uebergabe',
    /eskalieren/.test(pAusk.naechsterSchritt || ''), pAusk.naechsterSchritt);

  // Scheitert die Uebergabe, wird kein Erfolg vorgetaeuscht.
  studioOk = false;
  const eskFail = await ruf('kuendigen');
  ok('20. Scheitert die Uebergabe, wird das gesagt', eskFail.ok === false, JSON.stringify(eskFail));
  ok('20b. … mit einem Weg, der ohne uns funktioniert',
    /info@fit-inn-trier\.de/.test(eskFail.text || ''), eskFail.text);
  studioOk = true;

  // ── 12. Wenn die anrufende Nummer nicht im Profil steht ──
  // Kommt oefter vor als gedacht: Festnetz eines Dritten, unterdrueckte Nummer,
  // oder schlicht keine Nummer hinterlegt. Ein Sackgassen-„geht nicht" waere hier
  // das Schlechteste - es gibt ja noch Angaben, die das Mitglied selbst nennt.
  verifiziert = false;
  perTelefon = null;
  const nichts = await ruf('code');
  ok('17. Unbekannte Nummer endet nicht in der Sackgasse',
    nichts.ok === false && /Mitgliedsnummer/.test(nichts.text || ''), nichts.text);
  // Verraten werden darf dabei NICHT, ob die Nummer im Studio bekannt ist -
  // sonst liesse sich der Bestand durchprobieren.
  ok('17b. … und verraet nicht, ob die Nummer bekannt ist',
    !/unbekannt|nicht hinterlegt|kein Mitglied|existiert/i.test(nichts.text || ''), nichts.text);

  perNummerDob = { id: '4711', firstName: 'Markus', email: 'x@y.z' };
  const ueberNummer = await ruf('code', { customerNumber: 'M-2076', dateOfBirth: '28.12.1992' });
  ok('18. Mitgliedsnummer + Geburtsdatum finden das Mitglied doch',
    ueberNummer.ok === true && ueberNummer.kanal === 'email', JSON.stringify(ueberNummer));
  // Deutsche Schreibweise muss genauso gehen - so wird es am Telefon gesagt.
  ok('18b. … auch mit dem Datum in deutscher Schreibweise',
    (await ruf('code', { customerNumber: 'M-2076', dateOfBirth: '1992-12-28' })).ok === true);
  perNummerDob = null;

  perMailDob = { id: '4711', firstName: 'Markus', email: 'x@y.z' };
  ok('19. E-Mail + Geburtsdatum gehen ebenso',
    (await ruf('code', { email: 'markus@example.de', dateOfBirth: '28.12.1992' })).ok === true);
  perMailDob = null;

  // Ohne Geburtsdatum darf die Mitgliedsnummer allein NICHT reichen.
  perNummerDob = { id: '4711', email: 'x@y.z' };
  ok('20. Mitgliedsnummer ohne Geburtsdatum reicht nicht',
    (await ruf('code', { customerNumber: 'M-2076' })).ok === false);
  perNummerDob = null;
  perTelefon = { id: '4711', firstName: 'Markus', email: 'x@y.z' };

  // ── 13. Wenn im Profil ueberhaupt kein Kanal steht ──
  // Weder E-Mail noch Handy: Dann kann kein Code ankommen. Das gehoert gesagt,
  // nicht dreimal vergeblich versucht.
  vollprofil = { id: '4711', firstName: 'Markus', email: null };
  perTelefon = { id: '4711', firstName: 'Markus', email: null };
  const kanallos = await ruf('code');
  ok('21. Ohne Kanal im Profil wird das offen gesagt',
    kanallos.ok === false && kanallos.error === 'kein_kanal', JSON.stringify(kanallos));
  ok('21b. … mit einem Weg, der wirklich funktioniert',
    /Studio/.test(kanallos.text || ''), kanallos.text);

  // Aber: Steht nur die Handynummer im Profil, geht es sehr wohl (WhatsApp).
  vollprofil = { id: '4711', firstName: 'Markus', email: null, phonePrivate: '015120442244' };
  ok('22. Handynummer allein genuegt fuer den Code', (await ruf('code')).ok === true);
  vollprofil = { id: '4711', firstName: 'Markus', email: 'x@y.z', phonePrivate: '015120442244' };
  perTelefon = { id: '4711', firstName: 'Markus', email: 'x@y.z' };

  // ── 14. Uebergabe, wenn sich niemand zuordnen laesst ──
  // Auch dann muss das Anliegen ankommen: Wer nicht gefunden wird, ist deshalb
  // kein Nicht-Mitglied - die Nummer kann schlicht fehlen. Es faellt nur der
  // Kontext weg, und genau das muss das Team sehen.
  perTelefon = null;
  studioMails = [];
  const eskOhne = await ruf('kuendigen', { name: 'Markus Eichhorn' });
  ok('24. Auch ohne Zuordnung geht die Uebergabe raus',
    eskOhne.ok === true && studioMails.length === 1, JSON.stringify(eskOhne));
  ok('24b. … und sagt dem Team, dass nichts zugeordnet werden konnte',
    /Nicht zugeordnet/.test(studioMails[0].text || ''), (studioMails[0].text || '').slice(0, 400));
  ok('24c. … enthaelt aber trotzdem Rufnummer und genannten Namen',
    /Rufnummer:/.test(studioMails[0].text || '') && /Eichhorn/.test(studioMails[0].text || ''));
  // Ohne Zuordnung duerfen KEINE Vertragsdaten in der Uebergabe stehen - sonst
  // waeren es die eines Fremden.
  ok('24d. … und keine Vertragsdaten',
    !/Fit-Inn Komfort|39,90/.test(studioMails[0].text || ''), (studioMails[0].text || '').slice(0, 500));
  perTelefon = { id: '4711', firstName: 'Markus', email: 'x@y.z' };

  console.log(pass ? 'PHONE-MEMBER PASS' : 'PHONE-MEMBER FAIL');
  process.exit(pass ? 0 : 1);
})();
