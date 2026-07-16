'use strict';

/**
 * Team-Backend: Textbausteine (Schnellantworten) verwalten.
 *   GET                                   -> { ok, snippets:[{id,text,order}] }
 *   POST { action:'add',    text }        -> { ok, snippets:[…] }
 *   POST { action:'update', id, text }    -> { ok, snippets:[…] }
 *   POST { action:'delete', id }          -> { ok, snippets:[…] }
 *
 * Antwortet immer mit der frischen Gesamtliste. Ohne Store liefert GET die
 * DEFAULTS (Feature bleibt nutzbar); Mutationen sind dann nicht persistierbar.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const Snippets = require('../../lib/snippets');
const M = require('../../lib/members');   // readBody

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'conversations.manage', res)) return;

  if (req.method === 'GET') {
    const snippets = await Snippets.listSnippets();
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, snippets: snippets }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  // Ohne Store lassen sich Bausteine nicht persistieren -> ehrliche Rückmeldung,
  // aber die (Default-)Liste trotzdem mitliefern, damit das Frontend nutzbar bleibt.
  if (!Snippets.hasStore) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, disabled: true, message: 'Baustein-Speicher nicht verfügbar – Bausteine sind schreibgeschützt.', snippets: await Snippets.listSnippets() }));
  }

  const body = await M.readBody(req);
  const action = body.action;

  if (action === 'add') {
    if (!String(body.text || '').trim()) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen Text eingeben.', snippets: await Snippets.listSnippets() }));
    }
    await Snippets.addSnippet(body.text);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, snippets: await Snippets.listSnippets() }));
  }

  if (action === 'update') {
    if (!String(body.text || '').trim()) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen Text eingeben.', snippets: await Snippets.listSnippets() }));
    }
    await Snippets.updateSnippet(body.id, body.text);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, snippets: await Snippets.listSnippets() }));
  }

  if (action === 'delete') {
    await Snippets.deleteSnippet(body.id);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, snippets: await Snippets.listSnippets() }));
  }

  res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
