'use strict';

/**
 * POST/GET /api/team/cancel   (Team-Session erforderlich)
 * Vertragskündigung aus dem Team-Backend – nutzt exakt die serverseitigen
 * Magicline-Open-API-Endpunkte (Scope MEMBERSHIP_SELF_SERVICE_WRITE), die schon
 * die Mitglieder-Kündigung antreiben. Keyed auf Kunden-/Vertrags-ID, kein
 * Mitglieder-Login und kein reCAPTCHA nötig.
 *
 *   GET  ?id=<memberId>                          -> { ok, reasons:[{id,name}], forbidden }
 *   POST { id, action:'cancel', date, reasonId } -> ordentliche Kündigung
 *   POST { id, action:'withdraw' }               -> Kündigung zurückziehen
 *   POST { id, action:'revoke' }                 -> 14-Tage-Widerruf (Fernabsatz)
 *
 * Erfolg: Vorgang im Postfach + Bestätigungs-Mail ans Mitglied (best effort) +
 * interne Notiz mit dem handelnden Team-Mitglied. Wirft nie.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');
const MC = require('../../lib/mlCancel');
const Inbox = require('../../lib/inbox');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');
const { memberLink } = require('../../lib/magic');

function toPosInt(v) { const n = parseInt(v, 10); return (isFinite(n) && n > 0) ? n : null; }
function deDate(iso) { return iso ? String(iso).split('-').reverse().join('.') : ''; }

// Bestätigungs-Mail ans Mitglied (best effort, wirft nie).
async function mailMember(m, kind, opts) {
  if (!hasMail || !m || !m.email) return;
  opts = opts || {};
  try {
    const portal = await memberLink(m.id, 'contract');
    let tpl;
    if (kind === 'cancel') {
      const panel = [{ label: 'Kündigung zum', value: opts.dateText || 'nächstmöglich' }];
      if (opts.rateName) panel.push({ label: 'Tarif', value: opts.rateName });
      tpl = renderEmail({
        preheader: 'Deine Kündigung ist bei uns eingegangen.',
        name: m.firstName || '', eyebrow: 'Kündigung eingegangen', headline: 'Deine Kündigung ist eingegangen',
        intro: 'wir haben deine Kündigung verbindlich verarbeitet. Schade, dass du gehst – bis zum Vertragsende bleibt dein Zugang voll aktiv.',
        panel: panel, button: { label: 'Vertrag ansehen', href: portal }, promo: false, footer: 'member',
      });
      await sendMailRaw({ to: m.email, subject: 'Deine Kündigung ist eingegangen – Fit-Inn Trier', text: tpl.text, html: tpl.html });
    } else if (kind === 'withdraw') {
      tpl = renderEmail({
        preheader: 'Deine Kündigung wurde zurückgenommen.',
        name: m.firstName || '', eyebrow: 'Kündigung zurückgenommen', headline: 'Deine Kündigung wurde zurückgenommen',
        intro: 'schön, dass du bleibst! Wir haben deine Kündigung zurückgenommen – deine Mitgliedschaft läuft ganz normal weiter.',
        button: { label: 'Zum Mitgliederbereich', href: portal }, promo: false, footer: 'member',
      });
      await sendMailRaw({ to: m.email, subject: 'Deine Kündigung wurde zurückgenommen – Fit-Inn Trier', text: tpl.text, html: tpl.html });
    } else if (kind === 'revoke') {
      tpl = renderEmail({
        preheader: 'Dein Widerruf ist bei uns eingegangen.',
        name: m.firstName || '', eyebrow: 'Widerruf eingegangen', headline: 'Dein Widerruf ist eingegangen',
        intro: 'wir haben deinen Widerruf verbindlich verarbeitet. Dein online abgeschlossener Vertrag wird vollständig rückabgewickelt – bereits gezahlte Beiträge erstatten wir dir zurück.',
        button: { label: 'Zum Mitgliederbereich', href: portal }, promo: false, footer: 'member',
      });
      await sendMailRaw({ to: m.email, subject: 'Dein Widerruf ist eingegangen – Fit-Inn Trier', text: tpl.text, html: tpl.html });
    }
  } catch (e) { /* Mitglied-Mail ist optional */ }
}

// Vorgang + interne Notiz (wer hat's im Team ausgelöst) anlegen. Wirft nie.
async function logVorgang(id, actor, opts) {
  let v = null;
  try { v = await Inbox.addVorgang(id, opts.vorgang); } catch (e) { v = null; }
  if (v && opts.note) { try { await Inbox.addNote(id, v.id, { author: actor || 'Team', text: opts.note }); } catch (e) {} }
  return v;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!TA.isAdmin(sess)) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }
  const actor = (sess && sess.user) || 'Team';

  // GET: Kündigungsgründe fürs Formular.
  if (req.method === 'GET') {
    const rr = await MC.cancelReasons();
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: !!rr.ok, forbidden: !!rr.forbidden, reasons: rr.reasons || [] }));
  }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const id = String((body && (body.id || body.memberId)) || '').trim();
  const action = body && body.action;
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Mitglied fehlt.' })); }

  const m = await M.getMember(id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
  m.id = m.id || id;
  let ct = null; try { ct = await M.getContract(id); } catch (e) { ct = null; }
  if (!ct || !ct.contractId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kein aktiver Vertrag mit Vertrags-ID gefunden.' })); }

  const forbiddenMsg = 'Direkte Kündigung ist nicht freigeschaltet (Scope MEMBERSHIP_SELF_SERVICE_WRITE fehlt).';

  // ── Ordentliche Kündigung ──
  if (action === 'cancel') {
    const minISO = ct.nextCancellationDateISO || null;
    let dateISO = (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : (minISO || null);
    if (dateISO && minISO && dateISO < minISO) dateISO = minISO;   // nicht vor nächstmöglichem Termin
    const reasonId = toPosInt(body.reasonId != null ? body.reasonId : body.cancelationReasonId);
    if (!dateISO) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kein gültiges Kündigungsdatum.' })); }
    if (!reasonId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen Kündigungsgrund wählen.' })); }

    const oc = await MC.ordinaryCancel(id, { contractId: ct.contractId, cancelationReasonId: reasonId, cancelationDate: dateISO });
    if (oc.ok) {
      const cdDE = deDate(dateISO);
      try { require('../../lib/handled').record('team', id, 'kuendigung'); } catch (e) {}
      await logVorgang(id, actor, {
        vorgang: { type: 'kuendigung', subject: 'Kündigung bestätigt', status: 'abgeschlossen', teamStatus: 'abgeschlossen', teamUnread: false,
          systemText: 'Deine Kündigung ist bestätigt – zum ' + cdDE + '.',
          teamText: 'Hallo' + (m.firstName ? (' ' + m.firstName) : '') + ', deine Kündigung ist bei uns eingegangen und verbindlich bestätigt – zum ' + cdDE + '. Bis dahin bleibt dein Zugang voll aktiv.' },
        note: 'Kündigung im Team-Backend eingetragen (zum ' + cdDE + ').',
      });
      await mailMember(m, 'cancel', { dateText: cdDE, rateName: ct.rateName });
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, message: 'Vertrag verbindlich gekündigt – zum ' + cdDE + '.', effectiveDate: cdDE }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, forbidden: !!oc.forbidden, message: oc.forbidden ? forbiddenMsg : ('Kündigung fehlgeschlagen: ' + (oc.error || 'unbekannter Fehler')) }));
  }

  // ── Kündigung zurückziehen ──
  if (action === 'withdraw') {
    const wr = await MC.withdrawCancel(id, ct.contractId);
    if (wr.ok) {
      await logVorgang(id, actor, {
        vorgang: { type: 'kuendigung', subject: 'Kündigung zurückgenommen', status: 'abgeschlossen', teamStatus: 'abgeschlossen', teamUnread: false,
          systemText: 'Deine Kündigung wurde zurückgenommen.',
          teamText: 'Schön, dass du bleibst! Wir haben deine Kündigung zurückgenommen – deine Mitgliedschaft läuft ganz normal weiter.' },
        note: 'Kündigung im Team-Backend zurückgenommen.',
      });
      await mailMember(m, 'withdraw', {});
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, message: 'Kündigung wurde zurückgenommen.' }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, forbidden: !!wr.forbidden, message: wr.forbidden ? forbiddenMsg : ('Rücknahme fehlgeschlagen: ' + (wr.error || 'unbekannter Fehler')) }));
  }

  // ── 14-Tage-Widerruf (Fernabsatz) ──
  if (action === 'revoke') {
    const rv = await MC.contractWithdrawal(id, ct.contractId);
    if (rv.ok) {
      try { require('../../lib/handled').record('team', id, 'widerruf'); } catch (e) {}
      await logVorgang(id, actor, {
        vorgang: { type: 'widerruf', subject: 'Widerruf bestätigt', status: 'abgeschlossen', teamStatus: 'abgeschlossen', teamUnread: false,
          systemText: 'Dein Widerruf ist bestätigt – dein Vertrag wird rückabgewickelt.',
          teamText: 'Hallo' + (m.firstName ? (' ' + m.firstName) : '') + ', dein Widerruf ist eingegangen und verbindlich bestätigt. Dein Vertrag wird vollständig rückabgewickelt und bereits gezahlte Beiträge erstatten wir dir zurück.' },
        note: 'Widerruf (14 Tage) im Team-Backend eingetragen.',
      });
      await mailMember(m, 'revoke', {});
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, message: 'Vertrag verbindlich widerrufen – wird rückabgewickelt.' }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, forbidden: !!rv.forbidden, message: rv.forbidden ? forbiddenMsg : ('Widerruf fehlgeschlagen: ' + (rv.error || 'unbekannter Fehler')) }));
  }

  res.statusCode = 400;
  return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
