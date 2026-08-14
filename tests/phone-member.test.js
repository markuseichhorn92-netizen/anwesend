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
stub('lib/members.js', {
  getContract: async () => VERTRAG,
  findByPhone: async () => ({ id: '4711', firstName: 'Markus', email: 'x@y.z' }),
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
let kuendLink = { ok: true, grund: 'ok', emailHinweis: 'm***@example.de', ablauf: 1, schonGekuendigt: false };
stub('lib/cancelLink.js', { sendCancelLink: async () => kuendLink, MAX_PRO_TAG: 4 });

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
    /NICHT am Telefon/i.test(p.naechsterSchritt || ''), p.naechsterSchritt);
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

  // ── 11. Kuendigungswunsch ──
  // Wer kuendigen will, soll nicht erst einen Code vorlesen muessen. Preisgegeben
  // wird dabei nichts: Die Mail geht an die ohnehin hinterlegte Adresse, und der
  // Link ist durch das Geburtsdatum gesichert.
  verifiziert = false;
  const k = await ruf('kuendigen');
  ok('13. Kuendigungslink geht auch OHNE Ausweis raus', k.ok === true, JSON.stringify(k));
  ok('13b. … und sagt, dass die Mail unterwegs ist', /E-Mail/.test(k.text || ''), k.text);

  // Der gefaehrlichste Fehler waere, dass der Anrufer auflegt und glaubt, es sei
  // erledigt. Dann laeuft der Vertrag weiter, bis die naechste Abbuchung kommt.
  // Die Klarstellung selbst enthaelt „ist ... gekuendigt" und wuerde jede naive
  // Suche ausloesen. Also erst herausnehmen, dann auf Erfolgsbehauptungen pruefen.
  const ohneKlarstellung = String(k.text || '').replace(/noch nichts gekündigt/ig, '');
  ok('14. Es wird NICHT behauptet, die Kuendigung sei erfolgt',
    !/(ist|wurde|haben wir)[^.]{0,24}(gekündigt|eingegangen)|erledigt|storniert/i.test(ohneKlarstellung),
    ohneKlarstellung);
  ok('14b. … sondern ausdruecklich das Gegenteil',
    /noch nichts gekündigt/i.test(k.text || ''), k.text);
  ok('14c. … und der Assistent wird davon abgehalten, es zu sagen',
    /NICHT sagen/.test(k.naechsterSchritt || ''), k.naechsterSchritt);

  // Bereits gekuendigt: dann darf nicht zu einer zweiten Kuendigung gedraengt werden.
  kuendLink = { ok: true, grund: 'ok', emailHinweis: 'm***@example.de', ablauf: 1, schonGekuendigt: true };
  const k2 = await ruf('kuendigen');
  ok('15. Bei bestehender Kuendigung wird das gesagt',
    k2.schonGekuendigt === true && /bereits vor/i.test(k2.text || ''), k2.text);

  // Scheitert der Versand, darf die Kuendigung nicht daran haengen bleiben -
  // Textform per E-Mail genuegt, das muss der Anrufer erfahren.
  kuendLink = { ok: false, grund: 'keine_email', emailHinweis: null, ablauf: null };
  const k3 = await ruf('kuendigen');
  ok('16. Scheitert der Versand, wird ein anderer Weg genannt',
    k3.ok === false && /info@fit-inn-trier\.de/.test(k3.text || ''), k3.text);
  ok('16b. … und kein Erfolg vorgetaeuscht',
    !/geschickt|unterwegs/i.test(k3.text || ''), k3.text);
  kuendLink = { ok: true, grund: 'ok', emailHinweis: 'm***@example.de', ablauf: 1, schonGekuendigt: false };

  console.log(pass ? 'PHONE-MEMBER PASS' : 'PHONE-MEMBER FAIL');
  process.exit(pass ? 0 : 1);
})();
