'use strict';

/**
 * GET /api/ops?key=<OPS_KEY>   (bzw. Header x-api-key)
 * -----------------------------------------------------------------------------
 * Anonymer Betriebs-Überblick für „wie kommt die App an / wo sind Probleme".
 * Liefert AUSSCHLIESSLICH nicht-personenbezogene AGGREGATE (Zahlen, Kategorien,
 * Plattform-Mix) – KEINE Freitexte, Namen, Mitglieds-IDs oder E-Mails. Die
 * inhaltlichen Feedback-Texte liest das Team weiterhin nur im Team-Backend
 * (ordentlich authentifiziert).
 *
 * Secret: OPS_KEY (bevorzugt) oder – falls nicht gesetzt – MAGICLINE_WEBHOOK_KEY.
 * Ohne Secret -> 503, falsches Secret -> 401. Best effort, wirft nie.
 */

const OPS_KEY = process.env.OPS_KEY || process.env.MAGICLINE_WEBHOOK_KEY || '';

function daysAgo(ms) { return Math.floor((Date.now() - (Number(ms) || 0)) / 86400000); }
function tsOfFeedbackId(id) { const n = parseInt(String(id || '').slice(0, 14), 10); return isFinite(n) ? n : 0; }
function inc(obj, key) { const k = String(key || 'unbekannt'); obj[k] = (obj[k] || 0) + 1; }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  if (!OPS_KEY) { res.statusCode = 503; return res.end(JSON.stringify({ ok: false, error: 'not_configured' })); }
  let key = req.headers['x-api-key'] || '';
  if (!key) { try { key = new URL(req.url, 'http://x').searchParams.get('key') || ''; } catch (e) {} }
  if (key !== OPS_KEY) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const out = { ok: true, generatedDaysNote: 'd1/d7/d30 = letzte 1/7/30 Tage; alles anonym/aggregiert' };

  // ── Feedback (anonym): Kategorien, Status, Plattform-Mix, Alter ──
  try {
    const FB = require('../lib/feedback');
    const r = await FB.list({ limit: 500 });
    const items = (r && r.items) || [];
    const byCategory = {}, byStatus = {}, byPlatform = {};
    let last7 = 0, last30 = 0;
    items.forEach((o) => {
      inc(byCategory, o.category);
      inc(byStatus, o.status || 'new');
      inc(byPlatform, (o.meta && (o.meta.platform || o.meta.os)) || 'unbekannt');
      const age = daysAgo(tsOfFeedbackId(o.id));
      if (age <= 7) last7++; if (age <= 30) last30++;
    });
    out.feedback = { total: (r && r.total) || items.length, open: (r && r.open) || 0, last7: last7, last30: last30, byCategory: byCategory, byStatus: byStatus, byPlatform: byPlatform };
  } catch (e) { out.feedback = { error: true }; }

  // ── App-Fehler & WhatsApp-KI-Nutzung (anonyme Zähler, 1/7/30 Tage) ──
  try { const Ops = require('../lib/opsStat'); out.counters = await Ops.read(); } catch (e) { out.counters = { error: true }; }

  // ── Wachstum: neue Mitglieder (aus CONTRACT_CREATED-Webhook) ──
  try {
    const NM = require('../lib/newMembers');
    const joins = await NM.listJoins(60);
    let j7 = 0, j30 = 0;
    joins.forEach((o) => { const age = daysAgo(Date.parse(o.joinedAt || '')); if (age <= 7) j7++; if (age <= 30) j30++; });
    out.newMembers = { known: joins.length, last7: j7, last30: j30 };
  } catch (e) { out.newMembers = { error: true }; }

  // ── Leads/Interessenten: Quelle + Status ──
  try {
    const LF = require('../lib/leadflow');
    const leads = await LF.listLeads({ limit: 500 });
    const bySource = {}, byStatus = {};
    let l7 = 0;
    leads.forEach((l) => { inc(bySource, l.source); inc(byStatus, l.status || 'neu'); if (daysAgo(l.createdAt) <= 7) l7++; });
    out.leads = { total: leads.length, last7: l7, bySource: bySource, byStatus: byStatus };
  } catch (e) { out.leads = { error: true }; }

  // ── Magicline-Webhook-Feed (kommen Events an?) ──
  try {
    const ML = require('../lib/mlEvents');
    let stats = {}; try { stats = await ML.readStats(); } catch (e) {}
    let checkins = 0, present = 0;
    try { checkins = (await ML.recentCheckins(120)).length; } catch (e) {}
    try { present = await ML.presentCount(); } catch (e) {}
    out.webhookFeed = { feedReady: !!ML.hasStore, eventStats: stats, checkinsStored: checkins, presentToday: present };
  } catch (e) { out.webhookFeed = { error: true }; }

  // ── Studio-Auslastung/Stoßzeiten: wie viele Messungen liegen vor? ──
  try {
    const Store = require('../lib/store');
    const week = await Store.getTypicalWeek();
    let slotsWithData = 0;
    (week || []).forEach((day) => (day || []).forEach((v) => { if (v != null && v > 0) slotsWithData++; }));
    out.attendance = { slotsWithData: slotsWithData };
  } catch (e) { out.attendance = { error: true }; }

  res.statusCode = 200;
  return res.end(JSON.stringify(out));
};
