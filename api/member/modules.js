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
const MlPremium = require('../../lib/mlPremium');
const Ent = require('../../lib/entitlements');
const Connect = require('../../lib/connect');
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
    // Ernährungs-Premium (Zusatzmodul, SEPA) für die Vertragsverwaltung. Die Karte
    // erscheint, sobald das Modul TATSÄCHLICH gebucht ist (per gemerkter Vertrags-ID
    // verifiziert) – auch dann, wenn Premium gerade dem Stripe-Abo zugeschrieben wird
    // (Stripe hat Vorrang). Sonst bliebe ein parallel gebuchtes Modul unsichtbar und
    // unkündbar. stripeAlso warnt vor Doppelzahlung.
    let premium = null;
    if (Mod.premiumConfigured()) {
      try {
        await MlPremium.reconcile(sess.id);   // Premium-Quelle (Stripe-Vorrang) frisch halten
        const st = await MlPremium.moduleStatus(sess.id);   // Modul gebucht? (id-basiert)
        if (st && st.booked) {
          const nowMs = Date.now();
          const trialEndMs = st.trialEnd ? Date.parse(st.trialEnd + 'T23:59:59') : null;
          const inTrial = !!(trialEndMs && !isNaN(trialEndMs) && trialEndMs >= nowMs);
          const cancelUntil = (st.cancelled && st.endDate) ? Date.parse(st.endDate + 'T23:59:59') : null;
          premium = { active: true, trialing: inTrial, trialEnd: inTrial ? (st.trialEnd || null) : null, until: (st.cancelled && cancelUntil && !isNaN(cancelUntil)) ? cancelUntil : null, cancelAtPeriodEnd: !!st.cancelled };
          let ent = null; try { ent = await Ent.getEntitlement(sess.id); } catch (e) {}
          if (ent && ent.stripeSubId && Ent.isPremium(ent)) premium.stripeAlso = true;
        }
      } catch (e) {}
    }
    // Das Premium-Modul selbst wird über die Premium-Karte verwaltet -> aus den
    // generischen Modul-Listen herausfiltern (sonst doppelt).
    const notPrem = (list, key) => (list || []).filter((x) => !Mod.isPremiumModule(x && x[key]));
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      available: available,
      booked: available ? notPrem(r.booked, 'moduleId') : [],
      bookable: available ? notPrem(r.bookable, 'id') : [],
      premium: premium,
    }));
  }

  // ── POST: buchen / kündigen / Premium-Modul kündigen ──
  // WICHTIG: readBody konsumiert den Request-Stream nur EINMAL -> Body hier oben
  // genau einmal lesen und dann verzweigen.
  if (req.method === 'POST') {
    const body = await M.readBody(req);

    // ── Premium-Zusatzmodul kündigen (Ernährungs-Premium über die Mitgliedschaft) ──
    // Die Modul-Vertrags-ID kommt AUS DEM ENTITLEMENT (server-autoritativ), nicht vom
    // Client. Kündigung mit Grund + nächstmöglichem Datum; bei Ablehnung -> Studio-Fallback.
    if (body.action === 'cancel-premium') {
      if (!(await M.rateLimit('modules:' + sess.id, 15, 3600))) {
        res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Zu viele Anfragen. Bitte versuche es später erneut.' }));
      }
      const m = await M.getMember(sess.id);
      const mid = await membershipId(sess.id);
      // Modul-Vertrags-ID kommt AUS DEM ENTITLEMENT (beim Kauf gemerkt) – die Open API hat
      // keine Auflistung gebuchter Module, das ist die einzige Quelle.
      let ent = null; try { ent = await Ent.getEntitlement(sess.id); } catch (e) {}
      let moduleContractId = (ent && ent.moduleContractId != null) ? ent.moduleContractId : null;
      // Kündigungsdatum + Existenz per GET-by-ID prüfen. Im laufenden Trial zum Trial-Ende
      // kündigen -> keine Abbuchung.
      let cancelationDate = null;
      if (moduleContractId != null) {
        try {
          const mc = await Mod.getModuleContract(mid, moduleContractId);
          if (mc && mc.ok && mc.contract) {
            const c = mc.contract;
            const today = new Date().toISOString().slice(0, 10);
            if (c.trial && c.trial.endDate && c.trial.endDate >= today) cancelationDate = c.trial.endDate;
            else cancelationDate = c.nextCancellationDate || c.endDate || null;
          }
        } catch (e) {}
      }
      // Kündigungsgrund (Pflicht): erst Open API (kanonische IDs), dann die öffentlichen
      // Connect-Gründe als Fallback (falls der Key MEMBERSHIP_SELF_SERVICE_READ nicht hat).
      let reasonId = null;
      try { reasonId = Mod.pickReasonId(await Mod.getCancelationReasons()); } catch (e) {}
      if (reasonId == null) { try { reasonId = Connect.pickReasonId(await Connect.getCancelationReasons(), 'sonstiges'); } catch (e) {} }

      // ordinary-cancelation verlangt cancelationDate UND cancelationReasonId (Pflicht) ->
      // nur versuchen, wenn beides da ist; sonst gleich den Studio-Fallback (mit Diagnose).
      let r = { ok: false, status: 0 };
      let diag = '';
      if (moduleContractId == null) diag = 'keine gemerkte Modul-Vertrags-ID';
      else if (!cancelationDate) diag = 'kein Kündigungsdatum vom Modul-Vertrag (Scope …ADDITIONAL_MODULE_CONTRACT_READ?)';
      else if (reasonId == null) diag = 'kein Kündigungsgrund verfügbar (Scope MEMBERSHIP_SELF_SERVICE_READ / Connect-Gründe?)';
      else {
        try { r = await Mod.cancelModule(mid, moduleContractId, { cancelationDate: cancelationDate, cancelationReasonId: reasonId }); }
        catch (e) { r = { ok: false, status: 0, error: String((e && e.message) || e).slice(0, 200) }; }
        if (!(r && r.ok)) diag = 'Magicline lehnte ab (HTTP ' + ((r && r.status) || 0) + (r && r.error ? (' – ' + r.error) : '') + ')';
      }
      try { console.log('[modules] cancel-premium', JSON.stringify({ ok: !!(r && r.ok), diag: diag || null, hasId: moduleContractId != null, cancelationDate: cancelationDate || null, hasReason: reasonId != null })); } catch (e) {}

      if (r && r.ok) {
        // Frisch abgleichen: setzt until = Modul-Ende, Premium läuft bis dahin weiter.
        let tier = null; try { await MlPremium.invalidate(sess.id); tier = await MlPremium.reconcile(sess.id); } catch (e) {}
        try { require('../../lib/handled').record('system', sess.id, 'modul'); } catch (e) {}
        try {
          await Inbox.addVorgang(sess.id, {
            type: 'abo', subject: 'Premium (Zusatzmodul) gekündigt', status: 'abgeschlossen',
            systemText: 'Du hast dein Ernährungs-Premium (Zusatzmodul) gekündigt.'
              + ((tier && tier.until) ? (' Dein Zugang bleibt bis ' + new Date(tier.until).toLocaleDateString('de-DE') + ' aktiv.') : ''),
            teamText: 'Hallo' + (m && m.firstName ? (' ' + m.firstName) : '') + ', dein Ernährungs-Premium wurde gekündigt.',
          });
        } catch (e) {}
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, via: 'magicline', until: (tier && tier.until) || null, message: 'Premium wurde gekündigt. Dein Zugang bleibt bis zum Ende der Laufzeit aktiv.' }));
      }

      // Fallback: Wunsch als Vorgang + Studio-Mail sichern (geht nie verloren).
      let vorgang = null;
      try {
        vorgang = await Inbox.addVorgang(sess.id, {
          type: 'kontakt', subject: 'Premium (Zusatzmodul) kündigen',
          systemText: 'Du möchtest dein Ernährungs-Premium (Zusatzmodul) kündigen. Wir kümmern uns darum.',
          teamText: 'Hallo' + (m && m.firstName ? (' ' + m.firstName) : '') + ', dein Kündigungswunsch ist eingegangen. Wir kümmern uns darum.',
        });
      } catch (e) {}
      try {
        await SR.notifyStudio({
          member: m, vorgang: vorgang,
          subject: '➖ Ernährungs-Premium (Zusatzmodul) kündigen – ' + who(m),
          text: 'Ein Mitglied möchte sein Ernährungs-Premium (Zusatzmodul) kündigen.\n\n'
            + 'Mitglied: ' + who(m) + '\nKundennr.: ' + (m && m.customerNumber || '—') + '\n'
            + 'Modul-Vertrags-ID: ' + (moduleContractId != null ? moduleContractId : 'unbekannt') + '\n'
            + 'Kündigungsdatum (ermittelt): ' + (cancelationDate || '—') + '\n'
            + 'Automatik nicht durchgeführt: ' + (diag || 'unbekannt') + '\n\n'
            + 'Bitte das Zusatzmodul in Magicline kündigen und dem Mitglied bestätigen.',
        });
      } catch (e) {}
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, via: 'fallback', message: 'Wir kümmern uns um deine Kündigung und melden uns.' }));
    }

    // ── Zusatzmodul buchen / (generisch) kündigen ──
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
    const freqId = body.paymentFrequencyId != null ? body.paymentFrequencyId : undefined;
    let r;
    try { r = isBook ? await Mod.bookModule(mid, moduleId, freqId) : await Mod.cancelModule(mid, moduleId); }
    catch (e) { r = { ok: false, forbidden: false, status: 0, error: String((e && e.message) || e).slice(0, 200) }; }
    // Diagnose in die Vercel-Logs: WARUM lehnt Magicline ab? (ohne Personenbezug)
    if (!(r && r.ok)) {
      try { console.log('[modules] ' + action + ' failed', JSON.stringify({ status: (r && r.status) || 0, forbidden: !!(r && r.forbidden), error: (r && r.error) || null, moduleId: String(moduleId), freqId: freqId != null ? String(freqId) : null })); } catch (e) {}
    }

    if (r && r.ok) {
      try { require('../../lib/handled').record('system', sess.id, 'modul'); } catch (e) {}
      // Ist das gebuchte/gekündigte Modul das Premium-Modul? -> Ernährungs-Premium
      // sofort freischalten (Buchung) bzw. den Modulstatus neu abgleichen (Kündigung).
      if (Mod.isPremiumModule(moduleId)) {
        // Diagnose: hat der Kauf die Modul-Vertrags-ID zurückgegeben? (Basis fürs Kündigen)
        try { console.log('[modules] premium ' + action, JSON.stringify({ moduleContractId: (r && r.moduleContractId) != null ? String(r.moduleContractId) : null })); } catch (e) {}
        try {
          await MlPremium.invalidate(sess.id);
          // Beim Kauf die zurückgegebene Modul-Vertrags-ID merken -> spätere Kündigung möglich.
          if (isBook) await MlPremium.grantFromBooking(sess.id, (r && r.moduleContractId) || null);
          await MlPremium.reconcile(sess.id);
        } catch (e) {}
      }
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
      + 'Aktion: ' + (isBook ? 'hinzubuchen' : 'kündigen') + '\n'
      + 'Automatik: fehlgeschlagen (HTTP ' + ((r && r.status) || 0) + ((r && r.error) ? (' – ' + r.error) : '') + ')\n\n'
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
