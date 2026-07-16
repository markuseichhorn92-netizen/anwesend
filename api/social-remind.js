'use strict';

/**
 * Vercel Serverless Function · /api/social-remind
 * -----------------------------------------------
 * Vom GitHub-Actions-Cron (record.yml, alle 15 Min) aufgerufen. Verschickt
 * Trainingspartner-Erinnerungen (~100 Min vor der verabredeten Zeit), schreibt
 * nach gelaufenen gemeinsamen Sessions Vitalpunkte gut und pusht sonntagabends
 * das Wochen-Challenge-Ergebnis.
 *
 * Schutz wie /api/record & /api/plan-remind: ist RECORD_SECRET gesetzt, muss es
 * als Bearer-Token oder ?secret=... mitkommen. Degradiert sauber, wirft nie.
 */

const Social = require('../lib/social');
const { requireCronAuth } = require('../lib/cronAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (!requireCronAuth(req, res)) return;   // Secret verpflichtend, nur Authorization-Header

  try {
    const r = await Social.dispatchReminders({});
    res.statusCode = 200;
    return res.end(JSON.stringify(r));
  } catch (e) {
    console.error('[social-remind]', e && e.message);
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'remind_failed' }));
  }
};
