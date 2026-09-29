'use strict';

/**
 * Team-Backend: Lead-/Interessenten-Pipeline.
 *   GET  (Bearer Team-Token) -> { ok:true, leads:[{id,name,contact,source,createdAt,status,assignee}] }
 *                               neueste zuerst. Ohne Store -> { ok:true, leads:[] }.
 *   POST { id, action:'status'|'assign', status?, assignee? } -> { ok:true, lead }
 *
 * Datenquelle ist der lokale Lead-Store aus lib/leadflow (Upstash). Degradiert
 * sauber: kein Store -> leere Liste, jeder externe Zugriff try/catch, wirft nie.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const Leads = require('../../lib/leadflow');

const STATUSES = (Leads && Array.isArray(Leads.LEAD_STATUSES)) ? Leads.LEAD_STATUSES : ['neu', 'kontaktiert', 'gewonnen', 'verloren'];

// Nach außen nur die für die Pipeline nötigen Felder ausliefern.
function mapLead(l) {
  if (!l) return null;
  return {
    id: String(l.id),
    name: l.name || l.contact || 'Interessent',
    contact: l.contact || l.email || l.phone || '',
    source: l.source || 'sonstige',
    createdAt: l.createdAt || 0,
    status: STATUSES.indexOf(l.status) >= 0 ? l.status : 'neu',
    assignee: l.assignee || null,
    trialAt: l.trialAt || null,
    hasPhone: !!l.phone,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'admin.manage', res)) return;
  if (!TA.isAdmin(sess)) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden' })); }

  // ── GET: Liste der Interessenten (neueste zuerst) ──
  if (req.method === 'GET') {
    // ?conv=<leadId>: Schlüssel des WhatsApp-Gesprächs (Kunden-Id oder „wa<Nummer>") für „Gespräch öffnen".
    let cq = null; try { cq = new URL(req.url, 'http://x').searchParams.get('conv'); } catch (e) { cq = null; }
    if (cq) {
      let key = null;
      try {
        const lead = await Leads.getLead(String(cq).slice(0, 20));
        if (lead) {
          const Inbox = require('../../lib/inbox');
          const Phone = require('../../lib/phone');
          const cands = [];
          if (lead.customerId) cands.push(String(lead.customerId));
          const p = Phone.canon(lead.phone); if (p) cands.push('wa' + p);
          try { const linked = p ? await Leads.resolveKnownLead(p) : null; if (linked && linked.id) cands.unshift(String(linked.id)); } catch (e) {}
          for (const m of cands) {
            const list = await Inbox.list(m);
            const v = (list || []).find((x) => x.channel === 'whatsapp' && x.status !== 'abgeschlossen') || (list || []).find((x) => x.channel === 'whatsapp') || (list || [])[0];
            if (v) { key = m + ':' + v.id; break; }
          }
        }
      } catch (e) { key = null; }
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, key: key }));
    }
    let leads = [];
    try {
      const l = await Leads.listLeads({ limit: 500 });
      leads = Array.isArray(l) ? l.map(mapLead).filter(Boolean) : [];
    } catch (e) { leads = []; }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, leads: leads }));
  }

  // ── POST: Status ändern / Mitarbeiter zuweisen ──
  if (req.method === 'POST') {
    let b = {};
    try { b = await M.readBody(req); } catch (e) { b = {}; }
    const id = String((b && b.id) || '').trim();
    const action = String((b && b.action) || '').trim();
    if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'missing_id' })); }

    let lead = null;
    if (action === 'status') {
      const status = String(b.status || '').trim();
      if (STATUSES.indexOf(status) < 0) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'invalid_status' }));
      }
      try { lead = await Leads.setLeadStatus(id, status); } catch (e) { lead = null; }
    } else if (action === 'assign') {
      let assignee = null;
      const a = b.assignee;
      if (a && typeof a === 'object') {
        const nm = a.name != null ? String(a.name).trim().slice(0, 80) : '';
        const aid = a.id != null ? String(a.id).trim() : '';
        assignee = (nm || aid) ? { id: aid || null, name: nm || null } : null;
      } else if (typeof a === 'string' && a.trim()) {
        assignee = a.trim().slice(0, 80);
      }
      try { lead = await Leads.assignLead(id, assignee); } catch (e) { lead = null; }
    } else {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'invalid_action' }));
    }

    if (!lead) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, lead: mapLead(lead) }));
  }

  res.statusCode = 405;
  return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
