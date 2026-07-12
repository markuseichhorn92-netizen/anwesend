'use strict';

/**
 * POST/GET /api/team/pause   (Team-Session + Admin)
 * Beitragspause aus dem Team-Backend eintragen/bestätigen – nutzt exakt die
 * serverseitige Magicline-Membership-Self-Service-API (Idle Periods, Scope
 * MEMBERSHIP_SELF_SERVICE_WRITE), die auch die Mitglieder-Pause antreibt.
 * Keyed auf die Vertrags-ID, kein Mitglieder-Login nötig.
 *
 *   GET  ?id=<memberId>
 *        -> { ok, available, forbidden, config:{reasons,temporalUnit,maxTerms,
 *             maxTermPerReferencePeriod,referencePeriod,firstPossibleStartDate,
 *             nextPossibleStartDateOnly,fee}, current:[…], remaining, rateName }
 *   POST { id, action:'create', startDate, temporalUnit, termValue, reasonId, reason?, document? }
 *        -> { ok, message, startDate, endDate, state }
 *   POST { id, action:'withdraw', idlePeriodId }
 *        -> { ok, message }
 *
 * Erfolg: bucht die Pause direkt in Magicline, legt einen Vorgang im Postfach an,
 * schickt dem Mitglied eine Bestätigungs-Mail (best effort) und hinterlegt eine
 * interne Notiz mit dem handelnden Team-Mitglied. Wirft nie.
 */

const TA = require('../../lib/teamAuth');
const M = require('../../lib/members');
const MM = require('../../lib/mlMembership');
const Inbox = require('../../lib/inbox');
const { sendMailRaw, hasMail } = require('../../lib/mail');
const { renderEmail } = require('../../lib/emailTemplate');
const { memberLink } = require('../../lib/magic');

function fmtDE(iso) {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? (m[3] + '.' + m[2] + '.' + m[1]) : s;
}
function unitDE(unit, n) {
  unit = String(unit || '').toUpperCase();
  if (unit === 'MONTH') return n === 1 ? 'Monat' : 'Monate';
  if (unit === 'DAY') return n === 1 ? 'Tag' : 'Tage';
  return n === 1 ? 'Woche' : 'Wochen';
}
function toPosInt(v) { const n = parseInt(v, 10); return (isFinite(n) && n > 0) ? n : null; }
// dataURI/base64 -> reines base64 (ohne data:-Präfix), plausible Größe vorausgesetzt.
function cleanDoc(raw) {
  raw = String(raw || '');
  if (!raw) return '';
  const bi = raw.indexOf('base64,');
  let b64 = (bi >= 0 ? raw.slice(bi + 7) : raw).replace(/\s+/g, '');
  return (b64.length > 100 && b64.length < 8000000) ? b64 : '';
}

// Vorgang + interne Notiz (wer hat's im Team ausgelöst). Wirft nie.
async function logVorgang(id, actor, opts) {
  let v = null;
  try { v = await Inbox.addVorgang(id, opts.vorgang); } catch (e) { v = null; }
  if (v && opts.note) { try { await Inbox.addNote(id, v.id, { author: actor || 'Team', text: opts.note }); } catch (e) {} }
  return v;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!TA.isAdmin(sess)) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }
  const actor = (sess && sess.user) || 'Team';

  // GET: Pausen-Konfiguration + bestehende Pausen fürs Formular.
  if (req.method === 'GET') {
    let id = ''; try { id = new URL(req.url, 'http://x').searchParams.get('id') || ''; } catch (e) {}
    id = String(id).trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'no_member' })); }
    let ct = null; try { ct = await M.getContract(id); } catch (e) { ct = null; }
    if (!ct || !ct.contractId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, available: false, message: 'Kein aktiver Vertrag mit Vertrags-ID gefunden.' })); }
    const cfg = await MM.idleConfig(ct.contractId);
    if (!cfg.available) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, available: false, forbidden: !!cfg.forbidden, rateName: ct.rateName || '' })); }
    let current = []; let remaining = null;
    try { const lst = await MM.idleList(ct.contractId); if (lst.ok) current = lst.current || []; } catch (e) {}
    try { const rem = await MM.idleRemaining(ct.contractId); if (rem.ok) remaining = { maxTerms: rem.maxTerms, freeTerms: rem.freeTerms }; } catch (e) {}
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, available: true, rateName: ct.rateName || '', config: cfg, current: current, remaining: remaining }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const id = String((body && (body.id || body.memberId)) || '').trim();
  const action = (body && body.action) || 'create';
  if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, message: 'Mitglied fehlt.' })); }

  const m = await M.getMember(id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
  m.id = m.id || id;
  let ct = null; try { ct = await M.getContract(id); } catch (e) { ct = null; }
  if (!ct || !ct.contractId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Kein aktiver Vertrag mit Vertrags-ID gefunden.' })); }

  const forbiddenMsg = 'Direkte Beitragspause ist nicht freigeschaltet (Scope MEMBERSHIP_SELF_SERVICE_WRITE fehlt).';

  // ── Pause zurückziehen ──
  if (action === 'withdraw') {
    const pid = body.idlePeriodId;
    if (pid == null || pid === '') { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Keine Pause angegeben.' })); }
    const wr = await MM.idleWithdraw(ct.contractId, pid);
    if (wr.ok) {
      await logVorgang(id, actor, {
        vorgang: { type: 'pause', subject: 'Beitragspause storniert', status: 'abgeschlossen', teamStatus: 'abgeschlossen', teamUnread: false,
          systemText: 'Deine Beitragspause wurde zurückgenommen.',
          teamText: 'Hallo' + (m.firstName ? (' ' + m.firstName) : '') + ', deine Beitragspause wurde zurückgenommen – dein Vertrag läuft normal weiter.' },
        note: 'Beitragspause im Team-Backend zurückgenommen.',
      });
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, message: 'Beitragspause wurde zurückgenommen.' }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, forbidden: !!wr.forbidden, message: wr.forbidden ? forbiddenMsg : 'Rücknahme fehlgeschlagen.' }));
  }

  // ── Pause eintragen (validate + create) ──
  const startISO = /^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate || '')) ? String(body.startDate) : null;
  const unit = /^(DAY|WEEK|MONTH)$/.test(String(body.temporalUnit || '')) ? String(body.temporalUnit) : 'WEEK';
  const termValue = Math.max(1, Math.min(60, parseInt(body.termValue, 10) || 0));
  const reasonId = toPosInt(body.reasonId);
  const reasonName = String(body.reason || '').slice(0, 120);
  const docB64 = cleanDoc(body.document);
  if (!startISO) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte ein gültiges Startdatum wählen.' })); }
  if (!termValue) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte eine Dauer angeben.' })); }
  if (!reasonId) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen Pausengrund wählen.' })); }

  const data = { startDate: startISO, temporalUnit: unit, termValue: termValue, unlimited: false };
  const check = await MM.idleValidate(ct.contractId, data);
  if (!check.ok) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, forbidden: !!check.forbidden, message: check.forbidden ? forbiddenMsg : 'Pause konnte nicht geprüft werden.' }));
  }
  if (!check.creatable) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, message: 'Diese Pause ist so nicht möglich (' + (check.validationStatus || 'abgelehnt') + '). Bitte Datum/Dauer anpassen.' }));
  }

  const created = await MM.idleCreate(ct.contractId, Object.assign({ reasonId: reasonId }, data), docB64 || null);
  if (!created.ok) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, forbidden: !!created.forbidden, message: created.forbidden ? forbiddenMsg : ('Pause fehlgeschlagen: ' + (created.message || created.status || 'unbekannter Fehler')) }));
  }

  const ip = created.idlePeriod || {};
  const start = ip.startDate || startISO;
  const end = ip.endDate || null;
  const period = fmtDE(start) + (end ? (' bis ' + fmtDE(end)) : '');
  const durTxt = termValue + ' ' + unitDE(unit, termValue);
  const pending = ip.state === 'PENDING_VERIFICATION';

  try { require('../../lib/handled').record('team', id, 'pause'); } catch (e) {}

  await logVorgang(id, actor, {
    vorgang: {
      type: 'pause', subject: 'Beitragspause', status: pending ? 'bearbeitung' : 'abgeschlossen',
      teamStatus: pending ? 'bearbeitung' : 'abgeschlossen', teamUnread: false,
      systemText: 'Beitragspause eingerichtet: ' + period + ' (' + durTxt + ').',
      teamText: 'Hallo' + (m.firstName ? (' ' + m.firstName) : '') + ', deine Beitragspause ist eingerichtet (' + period + '). '
        + (pending ? 'Sie wird noch kurz geprüft. ' : '') + 'Deine Vertragslaufzeit verlängert sich um die Dauer der Pause – dein Tarif bleibt erhalten.',
    },
    note: 'Beitragspause im Team-Backend eingetragen: ' + period + ' (' + durTxt + (reasonName ? (', Grund: ' + reasonName) : '') + ').',
  });

  // Bestätigungs-Mail ans Mitglied (best effort).
  if (hasMail && m.email) {
    try {
      const portal = await memberLink(id, 'contract');
      const cm = renderEmail({
        preheader: 'Deine Beitragspause ist eingerichtet.',
        name: m.firstName || '', eyebrow: 'Beitragspause', headline: 'Deine Beitragspause ist eingerichtet',
        intro: pending
          ? 'Wir haben deine Beitragspause direkt in deinem Vertrag hinterlegt. Sie wird noch kurz geprüft – du musst nichts weiter tun.'
          : 'Wir haben deine Beitragspause direkt in deinem Vertrag hinterlegt – du musst nichts weiter tun.',
        panel: [
          { label: 'Beginn', value: fmtDE(start) },
          { label: 'Ende', value: end ? fmtDE(end) : '—' },
          { label: 'Dauer', value: durTxt },
        ].concat(reasonName ? [{ label: 'Grund', value: reasonName }] : []),
        note: 'Deine Vertragslaufzeit verlängert sich um die Dauer der Pause. Dein Tarif und deine Konditionen bleiben erhalten.',
        button: { label: 'Vertrag verwalten', href: portal }, promo: false, footer: 'member',
      });
      await sendMailRaw({ to: m.email, subject: 'Deine Beitragspause ist eingerichtet – Fit-Inn Trier', text: cm.text, html: cm.html });
    } catch (e) { /* Mitglied-Mail ist optional */ }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    message: 'Beitragspause verbindlich in Magicline eingetragen (' + period + ')' + (pending ? ' – wird noch geprüft.' : '.'),
    startDate: start, endDate: end, state: ip.state || null,
  }));
};
