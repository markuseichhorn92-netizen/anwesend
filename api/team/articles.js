'use strict';

/**
 * Team-Backend: Hilfe-Artikel verwalten.
 *   GET                 -> { ok, articles:[…] }   (alle, inkl. Entwürfe)
 *   GET ?id=<id>        -> { ok, article }
 *   POST { action:'save', article:{id?,title,cat,body,status} }
 *   POST { action:'publish'|'unpublish', id }
 *   POST { action:'delete', id }
 */

const TA = require('../../lib/teamAuth');
const Articles = require('../../lib/articles');
const M = require('../../lib/members');   // readBody

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Articles.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, articles: [], disabled: true })); }

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    if (id) {
      const a = await Articles.get(id);
      if (!a) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, article: a }));
    }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, articles: await Articles.list() }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const action = body.action;

  if (action === 'save') {
    const art = body.article || {};
    if (!String(art.title || '').trim()) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen Titel eingeben.' })); }
    const a = await Articles.save(art);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: !!a, article: a }));
  }
  if (action === 'publish' || action === 'unpublish') {
    const a = await Articles.setStatus(body.id, action === 'publish' ? 'veröffentlicht' : 'entwurf');
    res.statusCode = 200; return res.end(JSON.stringify({ ok: !!a, article: a }));
  }
  if (action === 'delete') {
    const ok = await Articles.remove(body.id);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: ok }));
  }
  res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
