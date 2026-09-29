'use strict';

/**
 * FINN Journeys – Kennzahlen ohne Personenbezug.
 * jr:kpi:<yyyymm>:<journey>:<metrik>  -> Zähler (400 Tage)
 * Metriken: enrolled, sent, sent_service, sent_marketing, dry, deferred, skipped,
 *           failed, replied, optin, optout, trial_booked, trial_showed, won,
 *           reactivated, team_task, delivered, read
 */

const KV = require('../finn/kv');

const TTL = 400 * 86400;
const METRICS = ['enrolled', 'sent', 'sent_service', 'sent_marketing', 'dry', 'deferred', 'skipped', 'no_template', 'failed', 'delivered', 'read', 'replied', 'optin', 'optout', 'trial_booked', 'trial_showed', 'won', 'lost', 'reactivated', 'team_task'];

function ym(at) {
  const d = new Date(at || Date.now());
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(d);
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return g('year') + g('month');
}
function key(month, journey, metric) { return 'jr:kpi:' + month + ':' + String(journey || 'all').replace(/[^a-z_]/g, '') + ':' + String(metric).replace(/[^a-z_]/g, ''); }

async function bump(journey, metric, at) {
  if (!journey || !metric) return null;
  return KV.incr(key(ym(at), journey, metric), TTL);
}

// { <journey>: { <metric>: n } } für einen Monat (yyyymm).
async function read(month, journeys) {
  month = /^[0-9]{6}$/.test(String(month || '')) ? String(month) : ym();
  const out = {};
  const keys = []; const map = [];
  (journeys || []).concat(['all']).forEach((j) => METRICS.forEach((m) => { keys.push(key(month, j, m)); map.push([j, m]); }));
  const vals = await KV.mgetJSON(keys);
  vals.forEach((v, i) => { const [j, m] = map[i]; if (v != null && Number(v) > 0) { (out[j] = out[j] || {})[m] = Number(v); } });
  return { month: month, data: out };
}

module.exports = { METRICS, ym, key, bump, read };
