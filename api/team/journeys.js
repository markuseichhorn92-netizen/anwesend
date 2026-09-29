'use strict';

/**
 * Team-Backend: FINN Journeys (WhatsApp-Onboarding, Motivation, Comeback, Leads).
 *   GET                       -> Betriebsmodus, Journeys (an/aus), Vorlagen-Katalog mit
 *                                Zuordnung, Kennzahlen des Monats, Probelauf-Liste, Zähler
 *   GET ?view=kpi&month=YYYYMM
 *   GET ?view=member&customerId=  -> Journey-Status einer Person (Stufe, Kennzahlen, Läufe,
 *                                Einwilligungen, letzte Sendungen – nur Metadaten)
 *   POST { action:'journey', key, on }            Journey ein-/ausschalten
 *   POST { action:'template', key, sid?, meta?, lang? }  Vorlage zuordnen (Twilio HX… / Meta-Name)
 *   POST { action:'test', tpl, phone }            Testversand – NUR an JOURNEYS_TEST_NUMBERS
 *   POST { action:'twilio_submit', keys? }        Vorlagen bei Twilio anlegen + bei Meta einreichen
 *                                                 (ohne keys: alle offenen; fortsetzbar über remaining)
 *   POST { action:'twilio_resubmit', key }        abgelehnte/veraltete Fassung neu einreichen
 *   POST { action:'twilio_sync' }                 mit Twilio abgleichen: Vorlagen ohne SID über
 *                                                 Name/Text zuordnen (legt nie etwas an) + Stand
 *   POST { action:'twilio_link' }                 nur zuordnen, ohne Stand nachzulesen
 *
 * Rechte: alles nur Admin (admin.manage), das Mitglieds-Profil mit member.read.
 * Antworten enthalten keine Nachrichten an echte Personen und keine Rufnummern
 * (Testnummern nur maskiert).
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');

const SID_RE = /^HX[0-9a-f]{32}$/i;
const META_RE = /^[a-z0-9_]{1,512}$/;

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function overview() {
  const Config = require('../../lib/journeys/config');
  const Defs = require('../../lib/journeys/defs');
  const Templates = require('../../lib/journeys/templates');
  const KPI = require('../../lib/journeys/kpi');
  const Store = require('../../lib/journeys/store');
  const Sender = require('../../lib/journeys/sender');
  const Phone = require('../../lib/phone');
  const TC = require('../../lib/journeys/twilioContent');
  // Offene Freigaben beim Öffnen der Seite nachlesen (höchstens alle 3 Minuten).
  try { await TC.syncIfDue(Date.now(), 5000, 3 * 60000); } catch (e) {}
  const cfg = await Config.load(true);
  const journeys = [];
  for (const d of Defs.list()) {
    journeys.push({ key: d.key, title: d.title, description: d.description, on: await Config.journeyOn(d.key), envOff: Config.envOff(d.key),
      adminOn: !(cfg.journeys[d.key] && cfg.journeys[d.key].on === false) && (d.key !== 'invite' || !!(cfg.journeys[d.key] && cfg.journeys[d.key].on)) });
  }
  let WA = {}; try { WA = require('../../lib/whatsapp'); } catch (e) {}
  const month = KPI.ym();
  return {
    ok: true,
    mode: {
      on: Config.on(), tracking: Config.tracking(), mode: Config.mode(),
      testNumbers: Config.testNumbers().map((p) => Phone.masked(p)),
      provider: WA.hasTwilio ? 'twilio' : (WA.hasMeta ? 'meta' : null), ai: (function () { try { return !!require('../../lib/ai').hasAI; } catch (e) { return false; } })(),
      leadAi: process.env.JOURNEYS_LEAD_AI !== '0', leadAiScope: Config.leadAiScope(), invitePerDay: parseInt(process.env.JOURNEYS_INVITE_PER_DAY || '40', 10) || 40,
    },
    journeys: journeys,
    templates: Templates.catalog(cfg.templates),
    twilio: { configured: TC.configured(), open: TC.pending(cfg.templates).length, lastSync: (parseInt((await require('../../lib/finn/kv').get('jr:tplsync')) || '0', 10) || null) },
    kpi: await KPI.read(month, Defs.list().map((d) => d.key)),
    dry: (await Sender.dryLog(40)).map((x) => ({ at: x.at, j: x.j, s: x.s, tpl: x.tpl || null, via: x.via || null, cat: x.cat || null, subj: x.subj || null, action: !!x.action, text: x.text || null })),
    counts: { due: await Store.dueCount(), index: await Store.indexSize(), members: await Store.memberCount() },
    updatedAt: cfg.updatedAt, updatedBy: cfg.updatedBy,
  };
}

async function memberView(cid) {
  const Store = require('../../lib/journeys/store');
  const Engine = require('../../lib/journeys/engine');
  const Eng = require('../../lib/journeys/engagement');
  const Consent = require('../../lib/journeys/consent');
  const Defs = require('../../lib/journeys/defs');
  const st = await Store.load(cid);
  const h = await Eng.read(cid);
  const now = Date.now();
  const m = Eng.metrics(h, now, st && st.facts && st.facts.weeklyGoal);
  const stage = Eng.classify(m, (st && st.facts) || {}, now);
  let con = { service: false, marketing: false, suppressed: false };
  if (st && st.phone) con = await Consent.get(st.phone);
  const runs = [];
  if (st) {
    const ctx = await Engine.buildCtx(st, now);
    Object.keys(st.runs || {}).forEach((k) => {
      const run = st.runs[k]; const d = Defs.get(k); if (!d) return;
      runs.push({ key: k, title: d.title, startedAt: run.startedAt, exit: run.exit || null,
        steps: d.steps.map((s) => { const dn = run.done[s.id]; let at = null; try { at = s.at(st, run, ctx); } catch (e) {} return { id: s.id, done: dn ? { at: dn.at, r: dn.r } : null, due: dn && !s.repeat ? null : at, defer: run.defer && run.defer[s.id] ? run.defer[s.id] : null }; }) });
    });
  }
  return {
    ok: true, known: !!st, stage: stage, stageLabel: Eng.STAGE_LABEL[stage] || stage,
    metrics: { v7: m.v7, v28: m.v28, goal: m.goal, daysSince: m.daysSince, weekStreak: m.weekStreak, tot: m.tot, tracked: m.tracked },
    whatsapp: { connected: !!(st && st.phone), service: con.service, marketing: con.marketing, suppressed: con.suppressed },
    runs: runs,
    sent: ((st && st.sent) || []).slice(-10).reverse().map((x) => ({ at: x.at, j: x.j, s: x.s, cat: x.cat, via: x.via })),
    facts: st ? { joinAt: st.facts.joinAt || null, firstVisitAt: st.facts.firstVisitAt || null, inductionBookedAt: st.facts.inductionBookedAt || null, cancelled: !!st.facts.cancelled } : null,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  const J = (o, code) => { res.statusCode = code || 200; res.end(JSON.stringify(o)); };
  let q = {}; try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams.entries()); } catch (e) {}

  if (req.method === 'GET' && q.view === 'member') {
    if (!Cap.requireCap(sess, 'member.read', res)) return;
    const cid = String(q.customerId || '');
    if (!/^[0-9]{1,12}$/.test(cid)) return J({ ok: false, error: 'bad_customer' }, 400);
    return J(await memberView(cid));
  }
  if (!Cap.requireCap(sess, 'admin.manage', res)) return;
  if (!TA.isAdmin(sess)) return J({ ok: false, error: 'forbidden' }, 403);

  if (req.method === 'GET') {
    if (q.view === 'kpi') {
      const KPI = require('../../lib/journeys/kpi'), Defs = require('../../lib/journeys/defs');
      return J(Object.assign({ ok: true }, await KPI.read(q.month, Defs.list().map((d) => d.key))));
    }
    return J(await overview());
  }
  if (req.method !== 'POST') return J({ ok: false, error: 'method_not_allowed' }, 405);

  const b = await readBody(req);
  const action = String(b.action || '');
  const Config = require('../../lib/journeys/config');
  const who = String(sess.name || sess.user || 'admin');

  if (action === 'journey') {
    const key = String(b.key || '');
    if (Config.JOURNEY_KEYS.indexOf(key) < 0) return J({ ok: false, error: 'bad_key' }, 400);
    await Config.save({ journeys: { [key]: { on: b.on === true } } }, who);
    return J({ ok: true });
  }
  if (action === 'template') {
    const Templates = require('../../lib/journeys/templates');
    const key = String(b.key || '');
    if (!Templates.get(key)) return J({ ok: false, error: 'bad_key' }, 400);
    const sid = b.sid ? String(b.sid).trim() : '';
    const meta = b.meta ? String(b.meta).trim().toLowerCase() : '';
    if (sid && !SID_RE.test(sid)) return J({ ok: false, error: 'bad_sid', message: 'Content-SID beginnt mit HX und hat 34 Zeichen.' }, 400);
    if (meta && !META_RE.test(meta)) return J({ ok: false, error: 'bad_meta', message: 'Meta-Vorlagenname: Kleinbuchstaben, Ziffern, Unterstrich.' }, 400);
    const lang = /^[a-z]{2}(_[A-Z]{2})?$/.test(String(b.lang || '')) ? String(b.lang) : 'de';
    await Config.save({ templates: { [key]: (sid || meta) ? { sid: sid || null, meta: meta || null, lang: lang } : {} } }, who);
    return J({ ok: true });
  }
  if (action === 'test') {
    // Testversand NUR an Nummern, die in Vercel als Testnummern hinterlegt sind –
    // so lässt sich über das Backend niemandem sonst etwas schicken.
    const Phone = require('../../lib/phone');
    const Templates = require('../../lib/journeys/templates');
    const p = Phone.canon(b.phone);
    if (!p || Config.testNumbers().indexOf(p) < 0) return J({ ok: false, error: 'not_test_number', message: 'Nur an Nummern aus JOURNEYS_TEST_NUMBERS.' }, 400);
    const key = String(b.tpl || '');
    const t = Templates.get(key); if (!t) return J({ ok: false, error: 'bad_key' }, 400);
    const cfg = await Config.load(true); const tc = cfg.templates[key] || {};
    const vars = {}; (t.vars || []).forEach((name, i) => { vars[i + 1] = i === 0 ? 'Test' : (/Datum/.test(name) ? Templates.fmtDate(Date.now() + 86400000) : (/Uhrzeit/.test(name) ? '18:00' : (/Link/.test(name) ? Templates.JOIN_URL : '3'))); });
    let WA = null; try { WA = require('../../lib/whatsapp'); } catch (e) {}
    if (!WA || !WA.hasWhatsApp) return J({ ok: false, error: 'no_whatsapp' }, 400);
    const open = await require('../../lib/journeys/window').isOpen(p);
    let r;
    if (WA.hasTwilio && tc.sid && !Templates.sidUsable(tc) && !open) return J({ ok: false, error: 'not_approved', message: 'Die Vorlage ist noch nicht von Meta freigegeben (' + (tc.status || 'unbekannt') + ').' }, 400);
    if (WA.hasTwilio && Templates.sidUsable(tc)) r = await WA.twilioSendTemplate(p, tc.sid, Templates.twilioVars(key, vars));
    else if (!WA.hasTwilio && WA.hasMeta && tc.meta) { const v = Templates.twilioVars(key, vars); r = await WA.sendTemplate(p, tc.meta, tc.lang || 'de', Object.keys(v).sort((x, y) => x - y).map((k) => v[k])); }
    else if (open) r = await WA.sendText(p, Templates.render(key, vars));
    else return J({ ok: false, error: 'no_template', message: 'Keine Vorlage zugeordnet und das 24-h-Fenster ist zu. Schreib der Nummer vorher kurz, oder ordne die Vorlage zu.' }, 400);
    return J({ ok: !!(r && r.ok !== false), via: (Templates.sidUsable(tc) || tc.meta) ? 'template' : 'session', error: r && r.ok === false ? 'provider' : undefined });
  }
  if (action === 'twilio_submit' || action === 'twilio_resubmit') {
    // Vorlagen bei Twilio anlegen und bei Meta zur Prüfung einreichen. Die
    // Zugangsdaten bleiben serverseitig; gesendet wird hier an niemanden.
    const Templates = require('../../lib/journeys/templates');
    const TC = require('../../lib/journeys/twilioContent');
    if (!TC.configured()) return J({ ok: false, error: 'no_twilio', message: TC.NO_TWILIO }, 400);
    const cfg = await Config.load(true);
    let keys;
    if (action === 'twilio_resubmit') {
      const key = String(b.key || '');
      if (!Templates.get(key)) return J({ ok: false, error: 'bad_key' }, 400);
      const cur = cfg.templates[key] || {};
      if (!cur.auto || !cur.sid) return J({ ok: false, error: 'not_submitted', message: 'Diese Vorlage wurde noch nicht eingereicht.' }, 400);
      const outdated = cur.hash !== Templates.hashOf(key);
      if (!outdated && !cur.bodyDiff && ['rejected', 'paused', 'disabled', 'deleted', 'unsubmitted'].indexOf(cur.status) < 0) return J({ ok: false, error: 'not_resubmittable', message: 'Neu einreichen geht nach einer Ablehnung, bei abweichendem oder geändertem Text.' }, 400);
      // Abgelehnte Fassung entfernen, damit Meta die neue nicht als Doppel wertet.
      if (cur.status === 'rejected') { try { await TC.remove(cur.sid); } catch (e) {} }
      await Config.save({ templates: { [key]: Object.assign({}, cur, { rev: outdated ? (cur.rev || 0) : (cur.rev || 0) + 1, sid: null, status: null, name: null, bodyDiff: undefined, linked: undefined }) } }, who);
      keys = [key];
    } else {
      const wanted = Array.isArray(b.keys) ? b.keys.map(String).filter((k) => Templates.get(k)) : null;
      keys = wanted && wanted.length ? wanted : TC.pending(cfg.templates);
    }
    if (!keys.length) return J({ ok: true, results: [], remaining: [], submitted: 0 });
    return J(await TC.submitMany({ keys: keys, budgetMs: 40000, who: who }));
  }
  if (action === 'twilio_sync') {
    const TC = require('../../lib/journeys/twilioContent');
    if (!TC.configured()) return J({ ok: false, error: 'no_twilio', message: TC.NO_TWILIO }, 400);
    const r = await TC.sync({ budgetMs: 30000, who: who });
    return J({ ok: !!r.ok, checked: r.checked || 0, changed: r.changed || 0, linked: r.linked || [], missing: r.missing || [], bodyDiff: r.bodyDiff || [], approved: r.approved || 0, linkError: r.linkError });
  }
  if (action === 'twilio_link') {
    const TC = require('../../lib/journeys/twilioContent');
    if (!TC.configured()) return J({ ok: false, error: 'no_twilio', message: TC.NO_TWILIO }, 400);
    const r = await TC.link({ who: who });
    return J({ ok: !!r.ok, linked: r.linked, missing: r.missing, bodyDiff: r.bodyDiff, message: r.ok ? undefined : r.message }, r.ok ? 200 : 502);
  }
  return J({ ok: false, error: 'bad_action' }, 400);
};

module.exports.memberView = memberView;
module.exports.overview = overview;
