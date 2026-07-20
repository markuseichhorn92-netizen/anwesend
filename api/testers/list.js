'use strict';

/**
 * GET /api/testers/list        -> JSON  { ok, count, testers:[{email,name,joinedAt}] }
 * GET /api/testers/list?csv=1  -> CSV   (email,name,joinedAt) zum Import in die Play Console
 *
 * Geschützt (fail-closed) wie die Cron-Endpunkte: NUR mit
 *   Authorization: Bearer <TESTERS_ADMIN_TOKEN|CRON_SECRET|RECORD_SECRET>
 * Ohne gesetztes Secret -> 503. Falscher/fehlender Header -> 401.
 *
 * Damit holt sich das Studio die gesammelten Tester-Adressen in einem Rutsch und
 * fügt sie in der Play Console unter „Geschlossener Test → Tester → E-Mail-Liste"
 * ein (CSV wird dort direkt akzeptiert).
 */

const { requireCronAuth } = require('../../lib/cronAuth');
const { redisPipeline, hasStore } = require('../../lib/store');

function hashToMap(v) {
  if (!v) return {};
  if (Array.isArray(v)) { const m = {}; for (let i = 0; i + 1 < v.length; i += 2) m[v[i]] = v[i + 1]; return m; }
  if (typeof v === 'object') return v;
  return {};
}

function csvCell(s) {
  const v = String(s == null ? '' : s);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

module.exports = async function handler(req, res) {
  if (!requireCronAuth(req, res, { extraEnvs: ['TESTERS_ADMIN_TOKEN'] })) return;   // sendet 401/503 selbst

  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  if (!hasStore) { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: false, error: 'no_store' })); }

  let emails = [];
  let info = {};
  try {
    const [members, infoFlat] = await redisPipeline([
      ['SMEMBERS', 'tester:emails'],
      ['HGETALL', 'tester:info'],
    ]);
    emails = Array.isArray(members) ? members : [];
    info = hashToMap(infoFlat);
  } catch (e) {
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'store_error' }));
  }

  const testers = emails.map(function (email) {
    let rec = {};
    try { rec = JSON.parse(info[email] || '{}') || {}; } catch (e) {}
    return { email: email, name: rec.name || '', joinedAt: rec.joinedAt || '' };
  }).sort(function (a, b) { return String(a.joinedAt).localeCompare(String(b.joinedAt)); });

  const wantCsv = String((req.url || '').split('?')[1] || '').indexOf('csv') >= 0;
  if (wantCsv) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fitinn-tester.csv"');
    const rows = ['email,name,joinedAt'].concat(testers.map(function (t) {
      return [csvCell(t.email), csvCell(t.name), csvCell(t.joinedAt)].join(',');
    }));
    return res.end(rows.join('\n') + '\n');
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify({ ok: true, count: testers.length, testers: testers }));
};
