'use strict';

/**
 * Team-Backend: Mitglieder-Tags (VIP, Beschwerde, Risiko, Stammkunde, …).
 *   GET ?memberId=<id>          -> { ok, tags:[…], presets:[…] }   Tags + Vorschläge
 *   GET ?tag=<tag>              -> { ok, memberIds:[…] }           Mitglieder mit Tag (Filter)
 *   POST { memberId, tags:[…] } -> { ok, tags:[…] }               Tags setzen (ersetzt)
 *   405 sonst.
 *
 * Ohne Store degradiert das Feature still: GET liefert leere Tags (+ Presets),
 * POST liefert die normalisierte Liste ohne Persistenz. Nie werfen.
 */

const TA = require('../../lib/teamAuth');
const Tags = require('../../lib/tags');
const M = require('../../lib/members');   // readBody

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const tag = url.searchParams.get('tag');
    if (tag != null && String(tag).trim()) {
      const memberIds = await Tags.membersByTag(tag);
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, memberIds: memberIds }));
    }
    const memberId = url.searchParams.get('memberId');
    const tags = memberId ? await Tags.getTags(memberId) : [];
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, tags: tags, presets: Tags.TAG_PRESETS }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const body = await M.readBody(req);
  const memberId = body.memberId;
  if (memberId == null || String(memberId).trim() === '') {
    res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_memberId' }));
  }
  const tags = await Tags.setTags(memberId, Array.isArray(body.tags) ? body.tags : []);
  res.statusCode = 200; return res.end(JSON.stringify({ ok: true, tags: tags }));
};
