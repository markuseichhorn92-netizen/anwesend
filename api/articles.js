'use strict';

/**
 * Öffentliche Hilfe-Artikel-API (Mitgliederbereich).
 *   GET                 -> { ok, articles:[{id,title,cat,catLabel,body}] }   (nur veröffentlichte)
 *   GET ?id=<id>        -> { ok, article } (+ zählt einen Aufruf)
 *   POST { id, helpful } -> Hilfreich-Bewertung (ratenbegrenzt)
 * Kein Login nötig; liefert ausschließlich veröffentlichte Artikel.
 */

const Articles = require('../lib/articles');
const M = require('../lib/members');   // readBody + rateLimit

function pub(a) { return { id: a.id, title: a.title, cat: a.cat, catLabel: Articles.CAT_LABEL[a.cat] || '', body: a.body }; }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!Articles.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, articles: [] })); }
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id');
    if (id) {
      const a = await Articles.get(id);
      if (!a || a.status !== 'veröffentlicht') { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
      Articles.incrView(id).catch(() => {});
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, article: pub(a) }));
    }
    let list = [];
    try { list = await Articles.listPublished(); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, articles: list.map(pub) }));
  }

  if (req.method === 'POST') {
    const body = await M.readBody(req);
    if (!body.id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
    if (!(await M.rateLimit('art-vote:' + ip, 60, 3600))) { res.statusCode = 429; return res.end(JSON.stringify({ ok: false })); }
    const a = await Articles.vote(body.id, !!body.helpful);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: !!a }));
  }

  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
