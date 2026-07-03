'use strict';

/**
 * Interne Aufgaben-/To-do-Liste fürs Studio-Team (Team-Backend).
 * -------------------------------------------------------------
 * Zuweisbare interne Aufgaben mit Fälligkeit und Erledigt-Status – BEWUSST
 * getrennt von den Kunden-Vorgängen (Posteingang) und der Lead-Pipeline.
 * Persistiert über Upstash KV (REST), kein SDK, keine neuen Dependencies.
 *
 * Keys:
 *   todo:seq        INCR-Zähler für IDs
 *   todo:<id>       JSON der Aufgabe
 *   todo:idx        ZSET, score = createdAt, member = <id>
 *
 * Aufgabe: { id, text, assignee:{id,name}|null, due:string|null, done:bool,
 *            createdAt, updatedAt }
 *
 * Grundsatz (wie im Bestand): wirft NIE. Ohne Store -> leere Liste, keine
 * Persistenz. Jeder externe Zugriff ist try/catch-gekapselt (best effort).
 */

const { redisPipeline, hasStore } = require('./store');

const SEQ = 'todo:seq';
const IDX = 'todo:idx';
const vKey = (id) => 'todo:' + id;

const MAX_LEN = 500;        // Aufgabentext begrenzen
const MAX_NAME = 80;        // Länge des Zuständigen-Namens begrenzen

// Text säubern + auf Maximallänge kürzen.
function clean(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').trim().slice(0, MAX_LEN);
}

// Fälligkeit auf ISO-Datum (YYYY-MM-DD) normalisieren, sonst null.
// Akzeptiert YYYY-MM-DD(…) und dd.mm.yyyy. Alles andere -> keine Fälligkeit.
function cleanDue(due) {
  if (due == null) return null;
  const s = String(due).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const m2 = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m2) return m2[3] + '-' + m2[2] + '-' + m2[1];
  return null;
}

// Zuständigen normalisieren: {id,name} | Name-String | null -> {id,name}|null.
function normAssignee(a) {
  if (a && typeof a === 'object') {
    const nm = a.name != null ? String(a.name).trim().slice(0, MAX_NAME) : '';
    const aid = a.id != null ? String(a.id).trim() : '';
    return (nm || aid) ? { id: aid || null, name: nm || null } : null;
  }
  if (typeof a === 'string' && a.trim()) return { id: null, name: a.trim().slice(0, MAX_NAME) };
  return null;
}

// Nur die fürs Frontend relevanten Felder ausliefern.
function publicTodo(t) {
  return {
    id: t.id,
    text: t.text || '',
    assignee: t.assignee || null,
    due: t.due || null,
    done: !!t.done,
    createdAt: t.createdAt || 0,
  };
}

// Sortierung: offene zuerst, dann nach Fälligkeit (früheste zuerst; ohne
// Fälligkeit ans Ende), dann nach Erstellung (älteste zuerst).
function sortTodos(list) {
  list.sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    const ad = a.due || null, bd = b.due || null;
    if (ad && bd) { if (ad !== bd) return ad < bd ? -1 : 1; }
    else if (ad && !bd) return -1;
    else if (!ad && bd) return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  return list;
}

async function nextId() {
  const r = await redisPipeline([['INCR', SEQ]]);
  return 't' + (Number(r && r[0]) || 1);
}

// Aufgabe roh aus dem Store lesen (oder null).
async function getTodo(id) {
  if (!hasStore || !id) return null;
  let s;
  try { [s] = await redisPipeline([['GET', vKey(id)]]); }
  catch (e) { return null; }
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// Liste aller Aufgaben (sinnvoll sortiert). Ohne Store -> []. Wirft nie.
async function listTodos() {
  if (!hasStore) return [];
  let ids;
  try { [ids] = await redisPipeline([['ZRANGE', IDX, '0', '-1']]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  let res;
  try { res = await redisPipeline(ids.map((id) => ['GET', vKey(id)])); }
  catch (e) { return []; }
  const out = [];
  (res || []).forEach((s) => { if (s) { try { out.push(JSON.parse(s)); } catch (e) {} } });
  return sortTodos(out).map(publicTodo);
}

// Neue Aufgabe anlegen. Liefert die Aufgabe oder null (leerer Text / kein Store).
async function addTodo(o) {
  o = o || {};
  const text = clean(o.text);
  if (!text || !hasStore) return null;
  try {
    const id = await nextId();
    const now = Date.now();
    const todo = {
      id: id,
      text: text,
      assignee: normAssignee(o.assignee),
      due: cleanDue(o.due),
      done: false,
      createdAt: now,
      updatedAt: now,
    };
    await redisPipeline([
      ['SET', vKey(id), JSON.stringify(todo)],
      ['ZADD', IDX, String(now), id],
    ]);
    return publicTodo(todo);
  } catch (e) { return null; }
}

// Aufgabe ändern. Patch darf text/assignee/due/done enthalten (nur gesetzte
// Felder werden angefasst). Liefert die aktualisierte Aufgabe oder null.
async function updateTodo(id, patch) {
  if (!hasStore || !id) return null;
  patch = patch || {};
  try {
    const todo = await getTodo(id);
    if (!todo) return null;
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    if (has('text')) { const t = clean(patch.text); if (t) todo.text = t; }
    if (has('assignee')) todo.assignee = normAssignee(patch.assignee);
    if (has('due')) todo.due = cleanDue(patch.due);
    if (has('done')) todo.done = !!patch.done;
    todo.updatedAt = Date.now();
    await redisPipeline([['SET', vKey(id), JSON.stringify(todo)]]);
    return publicTodo(todo);
  } catch (e) { return null; }
}

// Aufgabe löschen. Liefert true bei Erfolg.
async function deleteTodo(id) {
  if (!hasStore || !id) return false;
  try { await redisPipeline([['DEL', vKey(id)], ['ZREM', IDX, String(id)]]); return true; }
  catch (e) { return false; }
}

module.exports = { listTodos, addTodo, updateTodo, deleteTodo, getTodo, hasStore };
