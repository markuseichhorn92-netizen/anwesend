'use strict';

/**
 * POST /api/team/access-info   (Bearer Team-Token)
 *   { id }  -> Schickt dem Mitglied eine E-Mail mit seinen Zugangs-Infos zum
 *   Mitgliederbereich (Mitgliedsnummer, wie man sich anmeldet, Direkt-Link).
 *
 * Gedacht für frisch – auch direkt in Magicline – abgeschlossene Mitglieder:
 * Mitarbeiter öffnet das Profil und schickt mit einem Klick die Zugangs-Info.
 * Nutzt dieselbe gebrandete Vorlage wie die Willkommensmail beim Online-Abschluss.
 *
 * Wirft nie; -> { ok, sent, email }.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');
const { memberLink } = require('../../lib/magic');

function maskEmail(e) { return String(e || '').replace(/(.).*(@.*)/, '$1***$2'); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  if (!hasMail) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'E-Mail-Versand ist nicht eingerichtet.' })); }

  const b = await M.readBody(req);
  const id = String(b.id || '').trim();
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Kein Mitglied angegeben.' })); }

  // Anti-Spam: max. 6 Zugangs-Mails je Mitglied pro Stunde.
  if (!(await M.rateLimit('team-accessinfo:' + id, 6, 3600))) {
    res.statusCode = 429; return res.end(JSON.stringify({ ok: false, message: 'Zu oft gesendet – bitte kurz warten.' }));
  }

  let m; try { m = await M.getMember(id); } catch (e) { m = null; }
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, message: 'Mitglied nicht gefunden.' })); }
  const p = M.publicProfile(m) || {};
  const email = p.email && String(p.email).trim();
  if (!email) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Für dieses Mitglied ist keine E-Mail hinterlegt.' })); }

  const portal = await memberLink(id, 'home');
  const first = String(p.firstName || '').trim();
  const panel = [];
  if (p.customerNumber) panel.push({ label: 'Mitgliedsnummer', value: String(p.customerNumber) });
  panel.push({ label: 'Anmeldung', value: 'Mitgliedsnummer + Geburtsdatum' });
  panel.push({ label: 'Studio', value: 'Fit-Inn Trier · Auf Hirtenberg 8' });

  const em = renderEmail({
    preheader: 'So kommst du in deinen Mitgliederbereich.',
    name: first,
    eyebrow: 'Dein Zugang',
    headline: 'Willkommen – dein Mitgliederbereich',
    intro: [
      'Schön, dass du dabei bist! In deinem Mitgliederbereich kannst du Termine buchen, deine Daten verwalten, dein Training verfolgen und uns direkt schreiben.',
      'Melde dich einfach mit deiner Mitgliedsnummer und deinem Geburtsdatum an – fertig. Deine vollständigen Vertragsunterlagen erhältst du gesondert.',
    ],
    panel: panel,
    button: { label: 'Zum Mitgliederbereich', href: portal },
    promo: true,
    footer: 'member',
  });

  let sent = false;
  try { const r = await sendMailRaw({ to: email, subject: 'Dein Zugang zum Fit-Inn Mitgliederbereich', text: em.text, html: em.html }); sent = !!(r && r.ok); } catch (e) {}

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: sent, sent: sent, email: maskEmail(email), message: sent ? null : 'E-Mail konnte nicht gesendet werden.' }));
};
