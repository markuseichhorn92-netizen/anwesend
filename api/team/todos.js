'use strict';

/**
 * Team-Backend: Interne Aufgaben-/To-do-Liste verwalten.
 *   GET                                              -> { ok, todos:[{id,text,assignee,due,done,createdAt}] }
 *   POST { action:'add',    text, assignee?, due? }  -> { ok, todos:[…] }
 *   POST { action:'update', id, text?/assignee?/due?/done? } -> { ok, todos:[…] }
 *   POST { action:'delete', id }                     -> { ok, todos:[…] }
 *
 * Antwortet immer mit der frischen Gesamtliste. Ohne Store liefert GET eine
 * leere Liste; Mutationen sind dann nicht persistierbar (ehrliche Rückmeldung).
 * Getrennt von den Kunden-Vorgängen. Degradiert sauber, wirft nie.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const Todos = require('../../lib/todos');
const M = require('../../lib/members');   // readBody

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'todos.manage', res)) return;

  async function fresh() { try { return await Todos.listTodos(); } catch (e) { return []; } }

  if (req.method === 'GET') {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, todos: await fresh() }));
  }

  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  // Ohne Store lassen sich Aufgaben nicht persistieren -> ehrliche Rückmeldung,
  // die (leere) Liste trotzdem mitliefern, damit das Frontend nutzbar bleibt.
  if (!Todos.hasStore) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, disabled: true, message: 'Aufgaben-Speicher nicht verfügbar – Aufgaben sind schreibgeschützt.', todos: await fresh() }));
  }

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }
  const action = body && body.action;

  if (action === 'add') {
    if (!String((body && body.text) || '').trim()) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, message: 'Bitte einen Aufgabentext eingeben.', todos: await fresh() }));
    }
    try { await Todos.addTodo({ text: body.text, assignee: body.assignee, due: body.due }); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, todos: await fresh() }));
  }

  if (action === 'update') {
    const id = String((body && body.id) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id', todos: await fresh() })); }
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const patch = {};
    if (has('text')) patch.text = body.text;
    if (has('assignee')) patch.assignee = body.assignee;
    if (has('due')) patch.due = body.due;
    if (has('done')) patch.done = body.done;
    try { await Todos.updateTodo(id, patch); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, todos: await fresh() }));
  }

  if (action === 'delete') {
    const id = String((body && body.id) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id', todos: await fresh() })); }
    try { await Todos.deleteTodo(id); } catch (e) {}
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, todos: await fresh() }));
  }

  res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown_action' }));
};
