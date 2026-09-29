'use strict';

/**
 * FINN Journeys – Versandprotokoll: wer hat wann welche Nachricht bekommen?
 * -----------------------------------------------------------------------------
 * Ein Eintrag je echtem Versand, Anbieterfehler oder Testversand – ohne
 * Nachrichtentext (der steht im WhatsApp-Gespräch der Person) und ohne
 * Klarnummer (nur „…44"). Probelauf-Sendungen stehen in jr:dry, nicht hier.
 *
 *   jr:log   Liste, neueste vorn, höchstens 500 Einträge, 90 Tage
 *   Eintrag  { at, subj, kind: member|lead|test, j, s, tpl, via, cat, id, pm, err }
 *
 * Sichtbar nur für Admins (api/team/journeys?view=log). Der Zustellstand kommt
 * beim Anzeigen aus jr:out:<id> (7 Tage): zugestellt / gelesen / fehlgeschlagen.
 * Löscht eine Person ihre App-Daten, fallen ihre Einträge mit heraus (erase).
 */

const KV = require('../finn/kv');
const Phone = require('../phone');

const KEY = 'jr:log';
const CAP = 500;
const TTL = 90 * 86400;

function kindOf(subj) { return /^L\d+$/.test(String(subj || '')) ? 'lead' : 'member'; }

async function add(o) {
  o = o || {};
  const e = {
    at: o.at || Date.now(),
    subj: o.subj ? String(o.subj).slice(0, 24) : null,
    kind: o.kind || kindOf(o.subj),
    j: o.j ? String(o.j).slice(0, 20) : null,
    s: o.s ? String(o.s).slice(0, 30) : null,
    tpl: o.tpl ? String(o.tpl).slice(0, 40) : null,
    via: o.via || null,
    cat: o.cat || null,
    id: o.id ? String(o.id).slice(0, 64) : null,
    pm: o.phone ? Phone.masked(o.phone) : (o.pm || null),
    err: o.err ? String(o.err).slice(0, 40) : undefined,
  };
  try { await KV.lpush(KEY, e, CAP, TTL); } catch (x) {}
  return e;
}

async function list(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 30));
  const before = parseInt(opts.before, 10) || 0;
  const all = await KV.lrangeJSON(KEY, 0, CAP - 1);
  const rows = before ? all.filter((e) => e.at < before) : all;
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

// Zustand aus jr:out: gesendet → zugestellt → gelesen; fehlgeschlagen mit Code.
function statusOf(e, out) {
  if (e.err) return { status: 'failed', code: e.err };
  if (!out) return { status: 'sent' };
  if (out.f) return { status: 'failed', code: out.f === 1 ? null : String(out.f) };
  if (out.r) return { status: 'read' };
  if (out.d) return { status: 'delivered' };
  return { status: 'sent' };
}

/** Für das Team-Backend: Einträge mit Name, Profil-/Lead-Verweis und Zustellstand. */
async function view(opts) {
  const { rows, more } = await list(opts);
  const Store = require('./store');
  const names = new Map();
  const nameOf = async (e) => {
    if (!e.subj) return null;
    if (names.has(e.subj)) return names.get(e.subj);
    let n = null;
    try {
      if (e.kind === 'lead') { const lead = await require('../leadflow').getLead(e.subj); n = lead && lead.name && !/^\+?\d+$/.test(lead.name) ? String(lead.name) : null; }
      if (!n) { const st = await Store.load(e.subj); n = st && st.firstName ? String(st.firstName) : null; }
    } catch (x) {}
    names.set(e.subj, n);
    return n;
  };
  const out = [];
  for (const e of rows) {
    let rec = null;
    if (e.id) { try { rec = await KV.getJSON('jr:out:' + e.id); } catch (x) {} }
    const st = statusOf(e, rec);
    out.push({ at: e.at, kind: e.kind, subj: e.subj, name: await nameOf(e), pm: e.pm, j: e.j, s: e.s, tpl: e.tpl, via: e.via, cat: e.cat, status: st.status, code: st.code || null });
  }
  return { ok: true, rows: out, more: more, next: out.length ? out[out.length - 1].at : null };
}

// Einträge einer Person entfernen (Löschung der App-Daten).
async function eraseSubj(subj) {
  if (!subj) return 0;
  const all = await KV.lrangeJSON(KEY, 0, CAP - 1);
  const keep = all.filter((e) => String(e.subj) !== String(subj));
  if (keep.length === all.length) return 0;
  await KV.lreplace(KEY, keep, TTL);
  return all.length - keep.length;
}

module.exports = { add, list, view, eraseSubj, statusOf, KEY, CAP, TTL };
