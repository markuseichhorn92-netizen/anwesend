'use strict';

/**
 * Fit-Inn Trier · Versand der Vormerk-Erinnerungen
 * ------------------------------------------------
 * Zentraler Dispatcher, der von zwei Stellen genutzt wird:
 *   - api/plan-remind.js  (GitHub-Cron, force:true – läuft immer)
 *   - api/plan.js         (Live-Anzeigen pollen ~alle 60 s; force:false – gedrosselt)
 *
 * Da der GitHub-Cron stark gedrosselt wird, sorgt der Piggyback auf /api/plan dafür,
 * dass Erinnerungen während der Öffnungszeiten (Studio-Monitor/Mitglieder schauen)
 * zuverlässig alle ~5 Min verschickt werden. Ein Redis-Lock verhindert Mehrfach-Läufe.
 */

const P = require('./plans');
const { redisPipeline } = require('./store');
const { sendMailRaw, hasMail } = require('./mail');
const { renderEmail, BASE } = require('./emailTemplate');
const { memberLink } = require('./magic');
const { getPrefs } = require('./prefs');

const LOCK_KEY = 'plan:remlock';
const LOCK_TTL = parseInt(process.env.PLAN_REMIND_LOCK_SEC || '300', 10); // 5 Min Drosselung

function fmtSlot(m) { return (Math.floor(m / 60) < 10 ? '0' : '') + Math.floor(m / 60) + ':' + (m % 60 < 10 ? '0' : '') + (m % 60); }

async function reminderMail(d) {
  const cancelUrl = BASE + '/api/plan-cancel?t=' + encodeURIComponent(P.cancelToken(d.memberId, d.date));
  const portal = await memberLink(d.memberId, 'home', '#vormerken');
  const mail = renderEmail({
    preheader: 'Erinnerung: Dein Training heute um ' + fmtSlot(d.slot) + ' Uhr',
    name: d.firstName || '',
    eyebrow: 'Erinnerung',
    headline: 'Gleich ist es soweit',
    intro: 'Kurze Erinnerung an dein vorgemerktes Training heute im Fit-Inn Trier. Wir freuen uns auf dich!',
    panel: [
      { label: 'Wann', value: 'Heute, ' + fmtSlot(d.slot) + ' Uhr' },
    ],
    button: { label: 'Vormerkung ansehen', href: portal },
    secondary: { label: 'Doch keine Zeit? Stornieren', href: cancelUrl },
    promo: true,
    footer: 'member',
  });
  return {
    to: d.email,
    subject: 'Erinnerung: Dein Training heute um ' + fmtSlot(d.slot) + ' Uhr',
    text: mail.text,
    html: mail.html,
  };
}

// Drossel-Lock: nur wer 'OK' bekommt, darf arbeiten (NX = nur wenn noch nicht gesetzt).
async function acquireLock() {
  try {
    const [r] = await redisPipeline([['SET', LOCK_KEY, '1', 'NX', 'EX', String(LOCK_TTL)]]);
    return r === 'OK' || r === 'ok' || (r && r.result === 'OK');
  } catch (e) { return false; }
}

/**
 * Fällige Erinnerungen verschicken.
 * @param {{force?:boolean}} opts force=true überspringt die Drosselung (Cron).
 * @returns {Promise<{ran:boolean, due:number, sent:number}>}
 */
async function dispatch(opts) {
  opts = opts || {};
  if (!P.hasStore || !hasMail) return { ran: false, due: 0, sent: 0 };
  if (!opts.force) {
    const got = await acquireLock();
    if (!got) return { ran: false, due: 0, sent: 0 };
  }
  const due = await P.dueReminders();
  let sent = 0;
  for (const d of due) {
    if (!d.email) continue;
    try {
      // Globale Einstellung respektieren: Mitglied hat E-Mail-Erinnerungen aus.
      const prefs = await getPrefs(d.memberId);
      if (prefs && prefs.reminders === false) { await P.markReminded(d.memberId); continue; }
      const r = await sendMailRaw(await reminderMail(d));
      if (r && r.ok) { await P.markReminded(d.memberId); sent++; }
    } catch (e) { /* einzelne Mail darf den Lauf nicht abbrechen */ }
  }
  return { ran: true, due: due.length, sent: sent };
}

module.exports = { dispatch };
