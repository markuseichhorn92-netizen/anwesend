'use strict';

/** TEMPORÄR. GET /api/diag4?k=fitinn-probe-2026&cid=<id>
 * Prüft contract.signedDocumentUrl (authoritativer Vertrags-PDF-Link). */

const M = require('../lib/members');

function parseISO(s){ if(!s) return null; var d=new Date(String(s).slice(0,10)+'T00:00:00Z'); return isNaN(d.getTime())?null:d; }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('k') !== 'fitinn-probe-2026') { res.statusCode = 403; return res.end('{}'); }
  const cid = url.searchParams.get('cid');
  if (!cid) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'missing cid' })); }
  const eid = encodeURIComponent(cid);
  const out = {};

  const r = await M.ml('GET', '/customers/' + eid + '/contracts');
  const list = Array.isArray(r.json) ? r.json : [];
  out.contracts = list.map((c) => ({
    id: c.id, startDate: c.startDate, endDate: c.endDate, status: c.contractStatus,
    cancelled: c.cancelled, reversed: c.reversed,
    hasSignedDocUrl: !!c.signedDocumentUrl,
    signedDocHost: (function(){ try { return c.signedDocumentUrl ? new URL(c.signedDocumentUrl).host : null; } catch(e){ return 'unparsable'; } })(),
  }));

  // gleiche Auswahl wie getContract: aktiver, nicht reversed, sonst neuester
  const sorted = list.slice().sort((a,b)=> new Date(b.startDate||0)-new Date(a.startDate||0));
  const active = sorted.find((x)=>!x.reversed && /ACTIVE|RUNNING|LAUF/i.test(String(x.contractStatus||''))) || sorted.find((x)=>!x.reversed) || sorted[0];
  out.activeId = active ? active.id : null;
  out.activeHasUrl = !!(active && active.signedDocumentUrl);

  if (active && active.signedDocumentUrl) {
    try {
      const fr = await fetch(active.signedDocumentUrl);
      const fb = await fr.arrayBuffer().catch(()=>null);
      out.activeDownload = { status: fr.status, contentType: fr.headers.get('content-type'), bytes: fb?fb.byteLength:0 };
    } catch(e) { out.activeDownload = { error: e.message }; }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify(out, null, 2));
};
