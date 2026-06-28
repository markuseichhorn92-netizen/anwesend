'use strict';

/**
 * TEMPORÄR – Diagnose: liefert die NICHT-personenbezogenen Vertrags-Metadaten
 * (contractOrigin, createdDate-Feldnamen, Status) eines Mitglieds, um das
 * Widerruf-/Online-Flag korrekt zu setzen. Wird sofort nach der Diagnose entfernt.
 *
 * GET /api/_probe?key=<TOKEN>&last=<Nachname>&num=<Mitgliedsnr>
 */

const M = require('../lib/members');

const TOKEN = 'dea0a8ea30a414a32a641ed7bf09496f37b9a1e029240b98';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('key') !== TOKEN) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'forbidden' })); }
  const last = (url.searchParams.get('last') || '').trim();
  const num = (url.searchParams.get('num') || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!last || !num) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'need last + num' })); }

  try {
    const s = await M.ml('POST', '/customers/search', { lastName: last });
    if (s.status !== 200 || !Array.isArray(s.json)) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, searchStatus: s.status })); }
    const bare = num.replace(/^M-?/, '');
    const cands = [num, bare, 'M-' + bare];
    const cust = s.json.find((c) => cands.indexOf(String(c.customerNumber || '').toUpperCase().replace(/\s+/g, '')) >= 0);
    if (!cust) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, found: false, count: s.json.length })); }

    const r = await M.ml('GET', '/customers/' + encodeURIComponent(cust.id) + '/contracts');
    const arr = Array.isArray(r.json) ? r.json : [];
    // Nur strukturelle / nicht-personenbezogene Felder zurückgeben.
    const meta = arr.map((c) => ({
      id: c.id,
      contractStatus: c.contractStatus,
      reversed: c.reversed,
      cancelled: c.cancelled,
      contractOrigin: c.contractOrigin,
      createdDate: c.createdDate,
      createDate: c.createDate,
      creationDate: c.creationDate,
      signedDate: c.signedDate,
      conclusionDate: c.conclusionDate,
      startDate: c.startDate,
      endDate: c.endDate,
      lastPossibleCancellationDate: c.lastPossibleCancellationDate,
      _keys: Object.keys(c),
    }));
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, contractsStatus: r.status, contracts: meta }, null, 2));
  } catch (e) {
    res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: String(e && e.message).slice(0, 200) }));
  }
};
