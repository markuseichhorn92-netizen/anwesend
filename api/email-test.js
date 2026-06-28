'use strict';

/**
 * TEMPORÄR – nur zum Versenden von Design-Test-Mails an eine Adresse.
 * Wird nach dem Test wieder entfernt.
 *
 * GET /api/email-test?key=<TOKEN>&to=<email>
 *  - key: einmaliger Wegwerf-Token (unten hartkodiert) – schützt vor Missbrauch.
 *  - to:  Empfänger (wird zur Aufrufzeit übergeben, NICHT im Repo gespeichert).
 * Rendert jede E-Mail-Variante mit lib/emailTemplate und verschickt sie via Resend.
 */

const { renderEmail, BASE } = require('../lib/emailTemplate');
const { sendMailRaw, hasMail } = require('../lib/mail');

const TOKEN = '0defcb89e31dc054091ec154fb62c4cef21327ce4e8768f8';

// Minimal gültiges Test-PDF (für die "im Anhang"-Mails) – zur Laufzeit erzeugt.
function tinyPdf(text) {
  var stream = 'BT /F1 16 Tf 30 130 Td (' + text + ') Tj ET\n';
  var objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    '<</Length ' + Buffer.byteLength(stream, 'latin1') + '>>\nstream\n' + stream + 'endstream',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  var pdf = '%PDF-1.4\n'; var offs = [];
  for (var i = 0; i < objs.length; i++) { offs.push(Buffer.byteLength(pdf, 'latin1')); pdf += (i + 1) + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
  var xref = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (var j = 0; j < offs.length; j++) { pdf += String(offs[j]).padStart(10, '0') + ' 00000 n \n'; }
  pdf += 'trailer\n<</Size ' + (objs.length + 1) + '/Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(pdf, 'latin1').toString('base64');
}
const TINY_PDF = tinyPdf('Fit-Inn Trier - Testdokument');

const NAME = 'Lena';

// Alle Varianten – Inhalte 1:1 wie in den echten Flows.
function variants() {
  const cancelUrl = BASE + '/api/plan-cancel?t=TESTTOKEN';
  return [
    {
      subject: 'Dein Anmelde-Code: 418209 – Fit-Inn Trier',
      mail: renderEmail({
        preheader: 'Dein Anmelde-Code: 418209 (10 Minuten gültig)',
        name: NAME, eyebrow: 'Anmeldung', headline: 'Melde dich mit einem Klick an',
        intro: 'Klicke auf den Button, um dich sofort und sicher in deinem Mitgliederbereich anzumelden. Der Link ist 10 Minuten gültig.',
        button: { label: 'Jetzt anmelden', href: BASE + '/mitglieder?mlt=TEST', full: true },
        divider: 'oder mit Code',
        code: { label: 'Dein Anmelde-Code', value: '418209', spacing: 12, size: 36 },
        note: 'Du hast keine Anmeldung angefordert? Dann ignoriere diese E-Mail einfach – dein Konto bleibt sicher.',
        promo: true, footer: 'security',
      }),
    },
    {
      subject: 'Vormerkung bestätigt: heute um 18:30 Uhr',
      mail: renderEmail({
        preheader: 'Vormerkung bestätigt: heute um 18:30 Uhr',
        name: NAME, eyebrow: 'Vormerkung bestätigt', headline: 'Deine Zeit ist notiert',
        intro: 'Wir haben deine Vormerkung im Fit-Inn Trier gespeichert. Eine kurze Erinnerung schicken wir dir noch rechtzeitig vorher. Wir freuen uns auf dich!',
        panel: [{ label: 'Wann', value: 'Heute, 18:30 Uhr' }],
        button: { label: 'Zeit ändern', href: BASE + '/mitglieder' },
        secondary: { label: 'Vormerkung stornieren', href: cancelUrl },
        promo: true, footer: 'member',
      }),
    },
    {
      subject: 'Erinnerung: Dein Training heute um 18:30 Uhr',
      mail: renderEmail({
        preheader: 'Erinnerung: Dein Training heute um 18:30 Uhr',
        name: NAME, eyebrow: 'Erinnerung', headline: 'Gleich ist es soweit',
        intro: 'Kurze Erinnerung an dein vorgemerktes Training heute im Fit-Inn Trier. Wir freuen uns auf dich!',
        panel: [{ label: 'Wann', value: 'Heute, 18:30 Uhr' }],
        button: { label: 'Vormerkung ansehen', href: BASE + '/mitglieder' },
        secondary: { label: 'Doch keine Zeit? Stornieren', href: cancelUrl },
        promo: true, footer: 'member',
      }),
    },
    {
      subject: 'Deine Vertragskopie – Fit-Inn Trier',
      attach: [{ filename: 'Vertrag-Fit-Inn-Trier.pdf', content: TINY_PDF }],
      mail: renderEmail({
        preheader: 'Deine Vertragskopie findest du im Anhang.',
        name: NAME, eyebrow: 'Vertragskopie', headline: 'Deine Vertragskopie',
        intro: 'im Anhang findest du eine Kopie deines aktuellen Vertrags (Basic) beim Fit-Inn Trier.',
        panel: [{ label: 'Tarif', value: 'Basic' }],
        note: 'Bei Fragen zu deinem Vertrag sind wir jederzeit gerne für dich da.',
        button: { label: 'Vertrag verwalten', href: BASE + '/mitglieder' },
        promo: false, footer: 'member',
      }),
    },
    {
      subject: 'Deine Anwesenheitsbestätigung – Fit-Inn Trier',
      attach: [{ filename: 'anwesenheitsbestaetigung.pdf', content: TINY_PDF }],
      mail: renderEmail({
        preheader: 'Deine Anwesenheitsbestätigung findest du im Anhang.',
        name: NAME, eyebrow: 'Anwesenheitsbestätigung', headline: 'Deine Anwesenheitsbestätigung',
        intro: 'im Anhang findest du deine Anwesenheitsbestätigung des Fit-Inn Trier mit deinen Check-ins.',
        button: { label: 'Check-ins ansehen', href: BASE + '/mitglieder' },
        promo: false, footer: 'member',
      }),
    },
    {
      subject: 'Dein Terminwunsch ist eingegangen – Fit-Inn Trier',
      mail: renderEmail({
        preheader: 'Dein Terminwunsch ist bei uns eingegangen.',
        name: NAME, eyebrow: 'Terminwunsch', headline: 'Dein Terminwunsch ist eingegangen',
        intro: 'Wir haben deinen Terminwunsch erhalten und melden uns mit einem konkreten Termin per E-Mail bei dir.',
        panel: [
          { label: 'Terminart', value: 'Einführungstraining' },
          { label: 'Wunsch', value: 'Mi, nachmittags' },
        ],
        button: { label: 'Termine ansehen', href: BASE + '/mitglieder' },
        promo: true, footer: 'member',
      }),
    },
    {
      subject: 'Deine Beitragspause-Anfrage ist eingegangen – Fit-Inn Trier',
      mail: renderEmail({
        preheader: 'Deine Beitragspause-Anfrage ist eingegangen.',
        name: NAME, eyebrow: 'Beitragspause', headline: 'Deine Pause-Anfrage ist eingegangen',
        intro: 'Wir haben deine Anfrage für eine Beitragspause erhalten und prüfen sie. Sobald die Pause eingerichtet ist, bestätigen wir dir das per E-Mail.',
        panel: [
          { label: 'Gewünschter Beginn', value: '01.08.2026' },
          { label: 'Dauer', value: '4 Wochen' },
          { label: 'Voraussichtliches Ende', value: '29.08.2026' },
        ],
        note: 'Deinen ärztlichen Nachweis haben wir erhalten. Deine Vertragslaufzeit verlängert sich um die Dauer der Pause.',
        button: { label: 'Vertrag verwalten', href: BASE + '/mitglieder' },
        promo: true, footer: 'member',
      }),
    },
    {
      subject: 'Deine IBAN-Änderung ist eingegangen – Fit-Inn Trier',
      mail: renderEmail({
        preheader: 'Deine Bankverbindung-Änderung ist eingegangen.',
        name: NAME, eyebrow: 'Bankverbindung', headline: 'Deine IBAN-Änderung ist eingegangen',
        intro: 'Wir haben deinen Änderungswunsch erhalten und tragen ihn zeitnah ein. Künftige Beiträge ziehen wir dann von diesem Konto ein.',
        panel: [
          { label: 'Neue IBAN', value: '•••• 3000' },
          { label: 'Kontoinhaber', value: 'Lena Berger' },
          { label: 'Gültig ab', value: 'sofort / nächstmöglich' },
        ],
        note: 'Das warst nicht du? Bitte kontaktiere uns umgehend unter info@fit-inn-trier.de.',
        button: { label: 'Meine Daten ansehen', href: BASE + '/mitglieder' },
        promo: true, footer: 'member',
      }),
    },
    {
      subject: 'Deine Adressänderung ist eingegangen – Fit-Inn Trier',
      mail: renderEmail({
        preheader: 'Deine Adressänderung ist eingegangen.',
        name: NAME, eyebrow: 'Adressänderung', headline: 'Deine Adressänderung ist eingegangen',
        intro: 'Wir haben deinen Änderungswunsch erhalten und tragen ihn zeitnah für dich ein.',
        panel: [
          { label: 'Neue Adresse', value: 'Beispielweg 3, 54296 Trier' },
          { label: 'Gültig ab', value: 'sofort / nächstmöglich' },
        ],
        button: { label: 'Meine Daten ansehen', href: BASE + '/mitglieder' },
        promo: true, footer: 'member',
      }),
    },
    {
      subject: 'Deine Kündigung ist eingegangen – Fit-Inn Trier',
      mail: renderEmail({
        preheader: 'Deine Kündigung ist bei uns eingegangen.',
        name: NAME, eyebrow: 'Kündigung eingegangen', headline: 'Deine Kündigung ist eingegangen',
        intro: 'Wir haben deine Kündigung erhalten. Schade, dass du gehst – bis zum Vertragsende bleibt dein Zugang voll aktiv. Wir bestätigen dir die Kündigung zeitnah.',
        panel: [
          { label: 'Kündigung zum', value: '31.10.2026' },
          { label: 'Tarif', value: 'Basic' },
        ],
        button: { label: 'Vertrag ansehen', href: BASE + '/mitglieder' },
        promo: true, footer: 'member',
      }),
    },
  ];
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  const key = url.searchParams.get('key') || '';
  const to = (url.searchParams.get('to') || '').trim();

  if (key !== TOKEN) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'bad_to' })); }
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_mail_key' })); }

  const list = variants();
  const results = [];
  for (const v of list) {
    try {
      const r = await sendMailRaw({ to: to, subject: '[Test] ' + v.subject, text: v.mail.text, html: v.mail.html, attachments: v.attach });
      results.push({ subject: v.subject, ok: !!r.ok, status: r.status || null });
    } catch (e) {
      results.push({ subject: v.subject, ok: false, error: String(e && e.message).slice(0, 120) });
    }
  }
  const sent = results.filter((r) => r.ok).length;
  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, sent: sent, total: list.length, results: results }, null, 2));
};
