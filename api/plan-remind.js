'use strict';

/**
 * Vercel Serverless Function · /api/plan-remind
 * ---------------------------------------------
 * Vom GitHub-Actions-Cron (alle 15 Min) aufgerufen. Sendet die fälligen
 * E-Mail-Erinnerungen für heutige Vormerkungen (Stunde startet in ~0–45 Min)
 * und markiert sie, damit keine Doppel-Mails entstehen.
 *
 * Schutz wie /api/record: ist RECORD_SECRET gesetzt, muss es als Bearer-Token
 * oder ?secret=... mitkommen.
 */

const P = require('../lib/plans');
const { sendMailRaw, hasMail } = require('../lib/mail');

function fmtHour(h) { return (h < 10 ? '0' : '') + h + ':00'; }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const secret = process.env.RECORD_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    const url = new URL(req.url, 'http://localhost');
    const provided = auth.replace(/^Bearer\s+/i, '') || url.searchParams.get('secret') || '';
    if (provided !== secret) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  }

  if (!P.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, sent: 0, note: 'no_store' })); }

  try {
    const due = await P.dueReminders();
    let sent = 0;
    for (const d of due) {
      if (!hasMail || !d.email) continue;
      const name = d.firstName ? (' ' + d.firstName) : '';
      const txt =
        'Hallo' + name + ',\n\n' +
        'kurze Erinnerung: Du hast dir heute um ' + fmtHour(d.hour) + ' Uhr ein Training im Fit-Inn Trier vorgemerkt.\n' +
        'Bis gleich! 💪\n\n' +
        'Falls du doch nicht kannst, kannst du die Vormerkung im Mitgliederbereich absagen:\n' +
        'https://mitglieder.fit-inn-trier.de/mitglieder\n\n' +
        'Fit-Inn Trier · Auf Hirtenberg 8 · 54296 Trier';
      const r = await sendMailRaw({
        to: d.email,
        subject: 'Erinnerung: Dein Training heute um ' + fmtHour(d.hour) + ' Uhr',
        text: txt,
      });
      if (r.ok) { await P.markReminded(d.memberId); sent++; }
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, due: due.length, sent: sent }));
  } catch (e) {
    console.error('[plan-remind]', e.message);
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'remind_failed' }));
  }
};
