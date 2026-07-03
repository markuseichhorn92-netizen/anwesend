'use strict';

/**
 * /api/member/modules   (Authorization: Bearer <token>)
 * Zusatzmodule / Zusatzleistungen der Mitgliedschaft (Scopes
 * MEMBERSHIP_SELF_SERVICE_* / ADDITIONAL_MODULE_*) – über die 403-festen
 * Wrapper in lib/mlModules.
 *
 *   GET  -> { ok:true, available, booked:[...], bookable:[...] }
 *           (available:false -> die UI blendet die Zusatzmodule-Karte aus)
 *
 *   POST { action:'book'|'cancel', moduleId, moduleName? }
 *     -> WRITE-FIRST: erst die Open API versuchen. Bei Erfolg sofort bestätigen
 *        ({ via:'magicline' }) und einen abgeschlossenen Inbox-Vorgang anlegen.
 *        Bei 403/Fehler FALLBACK: Inbox-Vorgang + Studio-Mail mit dem Wunsch
 *        ({ via:'fallback' }) – der Wunsch geht NIE verloren. Nie werfen.
 *
 * Graceful Degradation ist zentral: die exakten Magicline-Endpunkte sind
 * unsicher (siehe lib/mlModules). Der Fallback greift also immer dann, wenn die
 * Buchung/Kündigung über die API nicht sauber durchgeht.
 */

const M = require('../../lib/members');
const Mod = require('../../lib/mlModules');
const Inbox = require('../../lib/inbox');
const SR = require('../../lib/studioReply');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');
const { memberLink } = require('../../lib/magic');

function who(m) {
  m = m || {};
  return (((m.firstName || '') + ' ' + (m.lastName || '')).trim() || 'Mitglied')
    + (m.customerNumber ? (' (' + m.customerNumber + ')') : '')
    + (m.email ? (' · ' + m.email) : '');
}

// Membership-/Vertrags-ID auflösen (die Membership-Self-Service-Endpunkte sind –
// wie die Beitragspausen – über die Vertrags-ID adressiert). Ohne Vertrag als
// Fallback die Kunden-ID nutzen; klappt der Zugriff nicht, degradiert alles sauber.
async function membershipId(customerId) {
  try { var ct = await M.getContract(customerId); if (ct && ct.contractId != null) return ct.contractId; }
  catch (e) {}
  return customerId;
}

// Bestätigung/Info ans Mitglied (best effort – ohne blockiert nichts).
async function sendMemberMail(m, memberId, opts) {
  if (!hasMail || !m || !m.email) return;
  try {
    var portal = await memberLink(memberId, 'contract');
    var cm = renderEmail({
      preheader: opts.preheader,
      name: m.firstName || '',
      eyebrow: 'Zusatzmodule',
      headline: opts.headline,
      intro: opts.intro,
      panel: opts.panel || null,
      button: { label: 'Vertrag verwalten', href: portal },
      promo: true,
      referral: { code: m.referralCode, firstName: m.firstName },
      footer: 'member',
    });
    await sendMailRaw({ to: m.email, subject: opts.subject, text: cm.text, html: cm.html });
  } catch (e) { /* Mitglied-Mail ist optional */ }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  // ── GET: buchbare + gebuchte Module ──
  if (req.method === 'GET') {
    const mid = await membershipId(sess.id);
    let r;
    try { r = await Mod.listModules(mid); } catch (e) { r = { available: false }; }
    const available = !!(r && r.available);
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      available: available,
      booked: available ? (r.booked || []) : [],
      bookable: available ? (r.bookable || []) : [],
    }));
  }

  // ── POST: buchen / kündigen ──
  if (req.method === 'POST') {
    const body = await M.readBody(req);
    const action = (body.action === 'cancel') ? 'cancel' : (body.action === 'book' ? 'book' : null);
    const moduleIdRaw = body.moduleId;
    const moduleId = (typeof moduleIdRaw === 'number') ? moduleIdRaw : String(moduleIdRaw == null ? '' : moduleIdRaw).trim();
    const moduleName = String(body.moduleName || '').slice(0, 140).trim();
    const label = moduleName || 'Zusatzmodul';

    if (!action || moduleId === '' || moduleId == null) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte wähle ein gültiges Zusatzmodul.' }));
    }

    // Leichter Spam-Schutz: max. 15 Buchungs-/Kündigungs-Aktionen pro Stunde.
    if (!(await M.rateLimit('modules:' + sess.id, 15, 3600))) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Anfragen. Bitte versuche es später erneut.' }));
    }

    const m = await M.getMember(sess.id);
    if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
    const mid = await membershipId(sess.id);
    const isBook = action === 'book';

    // ── WRITE-FIRST: echte Buchung/Kündigung über die Open API versuchen ──
    let r;
    try { r = isBook ? await Mod.bookModule(mid, moduleId) : await Mod.cancelModule(mid, moduleId); }
    catch (e) { r = { ok: false, forbidden: false }; }

    if (r && r.ok) {
      try { require('../../lib/handled').record('system', sess.id, 'modul'); } catch (e) {}
      // Erfolg -> abgeschlossenen Vorgang ins Postfach + Bestätigung.
      try {
        await Inbox.addVorgang(sess.id, {
          type: 'angebot',
          subject: isBook ? 'Zusatzmodul gebucht' : 'Zusatzmodul gekündigt',
          status: 'abgeschlossen',
          systemText: isBook
            ? ('Du hast das Zusatzmodul „' + label + '" hinzugebucht.')
            : ('Du hast das Zusatzmodul „' + label + '" gekündigt.'),
          teamText: 'Hallo' + (m.firstName ? (' ' + m.firstName) : '') + ', '
            + (isBook
              ? ('das Zusatzmodul „' + label + '" ist ab sofort für dich aktiviert.')
              : ('das Zusatzmodul „' + label + '" wurde gekündigt.')),
        });
      } catch (e) {}

      await sendMemberMail(m, sess.id, {
        preheader: isBook ? ('„' + label + '" ist aktiviert.') : ('„' + label + '" ist gekündigt.'),
        headline: isBook ? 'Dein Zusatzmodul ist aktiviert' : 'Dein Zusatzmodul ist gekündigt',
        intro: isBook
          ? 'Wir haben das gewünschte Zusatzmodul direkt in deiner Mitgliedschaft aktiviert – du musst nichts weiter tun.'
          : 'Wir haben das Zusatzmodul für dich gekündigt. Es endet gemäß den vereinbarten Konditionen.',
        panel: [{ label: 'Zusatzmodul', value: label }],
        subject: (isBook ? 'Zusatzmodul aktiviert' : 'Zusatzmodul gekündigt') + ' – Fit-Inn Trier',
      });

      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true,
        via: 'magicline',
        message: isBook
          ? ('„' + label + '" ist ab sofort aktiviert. Du erhältst eine Bestätigung per E-Mail.')
          : ('„' + label + '" wurde gekündigt. Du erhältst eine Bestätigung per E-Mail.'),
      }));
    }

    // ── FALLBACK: Wunsch als Vorgang sichern + Studio benachrichtigen ──
    let vorgang = null;
    try {
      vorgang = await Inbox.addVorgang(sess.id, {
        type: isBook ? 'angebot' : 'kontakt',
        subject: isBook ? 'Zusatzmodul hinzubuchen' : 'Zusatzmodul kündigen',
        systemText: isBook
          ? ('Du möchtest das Zusatzmodul „' + label + '" hinzubuchen. Wir richten das für dich ein.')
          : ('Du möchtest das Zusatzmodul „' + label + '" kündigen. Wir kümmern uns darum.'),
        teamText: 'Hallo' + (m.firstName ? (' ' + m.firstName) : '') + ', dein Wunsch ist bei uns eingegangen. '
          + 'Wir kümmern uns darum und melden uns bei dir.',
      });
    } catch (e) {}

    const text = (isBook ? 'Zusatzmodul hinzubuchen' : 'Zusatzmodul kündigen') + ' – über den Mitgliederbereich\n\n'
      + 'Mitglied: ' + who(m) + '\n'
      + 'Kundennr.: ' + (m.customerNumber || '—') + '\n'
      + 'Zusatzmodul: ' + label + '\n'
      + 'Modul-ID: ' + moduleId + '\n'
      + 'Aktion: ' + (isBook ? 'hinzubuchen' : 'kündigen') + '\n\n'
      + (isBook
        ? 'Bitte das Zusatzmodul in Magicline hinzubuchen und dem Mitglied bestätigen.'
        : 'Bitte das Zusatzmodul in Magicline kündigen und dem Mitglied bestätigen.');

    let mail = { ok: false };
    try {
      mail = await SR.notifyStudio({
        member: m, vorgang: vorgang,
        subject: (isBook ? '➕ Zusatzmodul hinzubuchen' : '➖ Zusatzmodul kündigen') + ' – ' + who(m),
        text: text,
      });
    } catch (e) {}

    // Mitglied-Bestätigung (best effort). Der Wunsch ist über den Vorgang bereits gesichert.
    await sendMemberMail(m, sess.id, {
      preheader: 'Dein Wunsch ist eingegangen.',
      headline: isBook ? 'Wir buchen dein Zusatzmodul' : 'Wir kümmern uns um deine Kündigung',
      intro: isBook
        ? 'Danke! Wir richten das gewünschte Zusatzmodul für dich ein und melden uns, sobald es aktiv ist.'
        : 'Danke! Wir kümmern uns um die Kündigung deines Zusatzmoduls und bestätigen dir das.',
      panel: [{ label: 'Zusatzmodul', value: label }],
      subject: 'Dein Wunsch ist eingegangen – Fit-Inn Trier',
    });

    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      via: 'fallback',
      message: 'Wir kümmern uns darum und melden uns.',
    }));
  }

  res.statusCode = 405;
  return res.end(JSON.stringify({ error: 'method_not_allowed' }));
};
