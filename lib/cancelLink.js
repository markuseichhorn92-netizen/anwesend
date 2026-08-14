'use strict';

/**
 * Kündigungslink per E-Mail.
 * -----------------------------------------------------------------------------
 * Wer kündigen will, bekommt einen Link an die im Studio hinterlegte Adresse.
 * Der Link führt in den Mitgliederbereich direkt zum Kündigungsvorgang; dort
 * wird einmal das Geburtsdatum abgefragt (lib/actionlink), dann ist der Weg frei.
 *
 * ── Was diese Mail ist und was nicht ────────────────────────────────────────
 * Sie ist ein WEG zur Kündigung, nicht die Kündigung selbst. Das steht auch so
 * darin. Wer die Mail bekommt und nichts weiter tut, hat nicht gekündigt — sonst
 * wäre der Vertrag beendet, weil jemand angerufen und es sich dann anders
 * überlegt hat. Die eigentliche Kündigung nimmt api/member/cancel.js entgegen
 * und bestätigt sie in Textform.
 *
 * ── Wer das auslöst ─────────────────────────────────────────────────────────
 * Nicht der Telefonassistent. Am Telefon wird nichts ausgeführt: Dort nimmt der
 * Assistent den Kündigungswunsch samt Zeitpunkt auf und übergibt an einen
 * Menschen (api/phone/member.js, aktion=eskalieren). Diese Funktion ruft auf,
 * wer selbst handelt — das Team aus dem Backend, oder das Mitglied im Portal.
 *
 * ── Warum kein Ausweis nötig ist ────────────────────────────────────────────
 * Anders als bei einer Vertragsauskunft wird hier nichts preisgegeben: Die Mail
 * geht ausschliesslich an die Adresse, die ohnehin im Profil steht, und der Link
 * ist zusätzlich durch das Geburtsdatum gesichert. Es ist derselbe Gedanke wie
 * bei einem Passwort-Zurücksetzen.
 *
 * Dazu kommt: Eine Kündigung darf nicht erschwert werden. Vor dem blossen
 * Zusenden eines Kündigungswegs noch eine Code-Hürde aufzubauen ginge in genau
 * die falsche Richtung — rechtlich wie menschlich.
 *
 * ── Kein Werbeblock ─────────────────────────────────────────────────────────
 * Andere Systemmails tragen Aktionshinweise. Diese nicht. Wer kündigen möchte,
 * bekommt den Weg dorthin und sonst nichts.
 */

const M = require('./members');
const AL = require('./actionlink');
const { sendMailRaw, hasMail } = require('./mail');
const { renderEmail } = require('./emailTemplate');
// Bereits vorhanden – kein zweiter Maskierer daneben.
const { maskEmail } = require('./welcome');

// „max. 4 pro Tag" — genug für einen verlegten Link, zu wenig, um jemanden
// über die eigene Rufnummer mit Mails zuzuschütten.
const MAX_PRO_TAG = 4;

function erstesWort(s) { return String(s || '').trim().split(/\s+/)[0] || ''; }

/**
 * Link erzeugen und zusenden.
 *
 * @param {object} member  Mitglied aus Magicline (mindestens id; email optional)
 * @param {object} [opts]  { quelle: 'app'|'team', url?: bereits erzeugter Link }
 * @returns {Promise<{ok:boolean, grund:string, emailHinweis:string|null, ablauf:number|null}>}
 *          `grund` ist maschinenlesbar; `emailHinweis` ist die maskierte Adresse
 *          („m…@gmail.com"), damit am Telefon gesagt werden kann, wohin es ging,
 *          ohne die Adresse vorzulesen.
 */
async function sendCancelLink(member, opts) {
  opts = opts || {};
  const nein = function (grund) { return { ok: false, grund: grund, emailHinweis: null, ablauf: null }; };
  if (!member || member.id == null) return nein('kein_mitglied');

  // Die Suchtreffer aus Magicline tragen oft keine E-Mail — dann nachladen.
  let email = member.email || null;
  let voll = member;
  if (!email) {
    try { const m = await M.getMember(member.id); if (m) { voll = m; email = m.email || null; } } catch (e) { /* bleibt leer */ }
  }
  if (!email) return nein('keine_email');
  if (!hasMail) return nein('kein_mailer');

  if (!(await M.rateLimit('cancellink:' + member.id, MAX_PRO_TAG, 86400))) return nein('zu_oft');

  // Wer den Link schon hat (das Team erzeugt ihn beim Öffnen der Karte), gibt ihn
  // mit — sonst gäbe es zwei gültige Token für dieselbe Sache.
  let erstellt = opts.url ? { ok: true, url: opts.url, expiresAt: opts.ablauf || null } : null;
  if (!erstellt) {
    erstellt = await AL.create({
      memberId: String(member.id), action: 'cancel',
      createdBy: 'selfservice:' + String(opts.quelle || 'unbekannt'),
    });
  }
  if (!erstellt.ok) return nein(erstellt.error || 'link_fehlgeschlagen');

  // Die Vertragsdaten machen die Mail erst nützlich: Ohne sie weiss niemand, ob
  // die Kündigung überhaupt noch fristgerecht ist.
  let ct = null;
  try { ct = await M.getContract(member.id); } catch (e) { ct = null; }

  const panel = [];
  if (ct && ct.rateName) panel.push({ label: 'Tarif', value: ct.rateName });
  if (ct && ct.endDate) panel.push({ label: 'Laufzeit bis', value: ct.endDate });
  if (ct && ct.deadline && !ct.deadlinePassed) {
    panel.push({ label: 'Kündigung möglich bis', value: ct.deadline });
  } else if (ct && ct.nextCancellationDate) {
    panel.push({ label: 'Nächster Kündigungstermin', value: ct.nextCancellationDate });
  }
  if (ct && ct.cancellationPeriod) panel.push({ label: 'Kündigungsfrist', value: ct.cancellationPeriod });

  // Bereits gekündigt: dann wäre ein zweiter Kündigungslink verwirrend.
  const schonGekuendigt = !!(ct && ct.cancelled);

  const mail = renderEmail({
    preheader: schonGekuendigt
      ? 'Dein Vertrag ist bereits gekündigt.'
      : 'Über den Button kommst du direkt zur Kündigung.',
    name: erstesWort(voll.firstName || ''),
    eyebrow: 'Kündigung',
    headline: schonGekuendigt ? 'Dein Vertrag ist bereits gekündigt' : 'Dein Link zur Kündigung',
    intro: schonGekuendigt
      ? 'Wir haben deine Kündigung schon vorliegen — du musst nichts weiter tun. '
        + 'Die Eckdaten stehen unten. Über den Button siehst du deinen Vertrag im Mitgliederbereich.'
      : 'Du möchtest deine Mitgliedschaft beenden. Über den Button kommst du direkt zum '
        + 'Kündigungsvorgang in deinem Mitgliederbereich. Zur Sicherheit fragen wir dort '
        + 'einmal dein Geburtsdatum ab.',
    panel: panel.length ? panel : null,
    button: { label: schonGekuendigt ? 'Vertrag ansehen' : 'Zur Kündigung', href: erstellt.url, full: true },
    // Der wichtigste Satz der ganzen Mail.
    note: schonGekuendigt
      ? ('Der Link ist ' + AL.TTL_DAYS + ' Tage gültig.')
      : ('Wichtig: Mit dieser E-Mail allein ist noch nichts gekündigt — erst der Vorgang '
        + 'hinter dem Button beendet deinen Vertrag. Du bekommst danach eine Bestätigung mit '
        + 'dem genauen Enddatum. Der Link ist ' + AL.TTL_DAYS + ' Tage gültig. '
        + 'Du hast das nicht angefordert? Dann ignoriere diese E-Mail einfach — es passiert nichts.'),
    // Bewusst kein Aktionshinweis: Wer kündigen will, bekommt den Weg dorthin.
    promo: false,
    footer: 'member',
  });

  try {
    await sendMailRaw({
      to: email,
      subject: schonGekuendigt
        ? 'Deine Kündigung liegt uns vor – Fit-Inn Trier'
        : 'Dein Link zur Kündigung – Fit-Inn Trier',
      text: mail.text, html: mail.html,
    });
  } catch (e) { return nein('versand_fehlgeschlagen'); }

  return {
    ok: true, grund: 'ok',
    emailHinweis: maskEmail(email),
    ablauf: erstellt.expiresAt || null,
    schonGekuendigt: schonGekuendigt,
  };
}

module.exports = { sendCancelLink, MAX_PRO_TAG };
