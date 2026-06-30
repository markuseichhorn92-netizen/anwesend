'use strict';

/**
 * GET /api/member/blog            -> { ok, posts:[…] }   Liste (ohne Volltext)
 * GET /api/member/blog?id=<id>    -> { ok, post:{…} }    einzelner Beitrag (mit body)
 * Authentifizierter Mitglieder-Endpunkt. Inhalte aus lib/blog.js.
 */

const M = require('../../lib/members');
const BLOG = require('../../lib/blog');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, max-age=300');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  let id = '';
  try { id = new URL(req.url, 'http://x').searchParams.get('id') || ''; } catch (e) {}
  if (id) {
    const post = BLOG.get(id);
    if (!post) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, post: post }));
  }
  res.statusCode = 200; return res.end(JSON.stringify({ ok: true, posts: BLOG.list() }));
};
