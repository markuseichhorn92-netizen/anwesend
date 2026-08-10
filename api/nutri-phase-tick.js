'use strict';

/**
 * Vercel Serverless Function · /api/nutri-phase-tick
 * --------------------------------------------------
 * Täglicher Cron (GitHub Actions, wie /api/nudge): meldet Mitgliedern den Wechsel
 * in eine neue Ernährungs-Phase – per Push UND als Postfach-Nachricht. Ohne das
 * hier würden sich die Tageswerte über Nacht ändern, ohne dass jemand erfährt warum.
 *
 * Die Zielwerte selbst wechseln ohnehin automatisch (sie werden bei jedem Read neu
 * aufgelöst) – dieser Job verschickt NUR die Information.
 *
 * Anti-Doppel-Versand: im Plan steht `lastPhaseKey`; erst wenn die heute gültige
 * Phase davon abweicht, wird benachrichtigt und der Marker nachgezogen.
 * Läuft ein Plan aus, bekommt das TEAM einmalig einen Hinweis zum Verlängern.
 *
 * Schutz wie /api/nudge: Secret als Authorization-Header verpflichtend.
 * Antwortet immer mit einer Zusammenfassung (Zahlen, keine Personendaten).
 */

const { requireCronAuth } = require('../lib/cronAuth');
const { redisPipeline, hasStore } = require('../lib/store');
const Phases = require('../lib/nutriPhases');

const PHIDX = 'nutri:phidx';
const PKEY = (id) => 'nutri:p:' + id;
const MAX_MEMBERS = 500;   // Sicherheitskappe pro Lauf

function ymdDE(ymd) { const t = String(ymd || '').split('-'); return t.length === 3 ? (t[2] + '.' + t[1] + '.' + t[0]) : String(ymd || ''); }

async function run() {
  const out = { scanned: 0, switched: 0, notified: 0, expired: 0 };
  if (!hasStore) return out;

  let ids = [];
  try { const [r] = await redisPipeline([['SMEMBERS', PHIDX]]); ids = Array.isArray(r) ? r.slice(0, MAX_MEMBERS) : []; } catch (e) { return out; }
  if (!ids.length) return out;

  const today = Phases.berlinToday();
  const Push = require('../lib/push');
  const Inbox = require('../lib/inbox');

  for (const id of ids) {
    out.scanned++;
    let profile = null;
    try { const [s] = await redisPipeline([['GET', PKEY(id)]]); profile = s ? JSON.parse(s) : null; } catch (e) { profile = null; }
    const plan = profile && profile.phasePlan;
    if (!plan) { try { await redisPipeline([['SREM', PHIDX, String(id)]]); } catch (e) {} continue; }

    // Minderjährige bekommen keine Phasenwerte -> auch keine Phasen-Nachricht.
    const age = parseInt(profile.age, 10);
    if (isFinite(age) && age < 18) continue;

    const r = Phases.resolve(plan, today);
    if (!r.ok) continue;

    // Plan ausgelaufen (Analyse-Plan ohne aktive Phase) -> einmalig das Team erinnern.
    if (r.expired && !r.current && !plan.expiredNotified) {
      try {
        const M = require('../lib/members');
        const SR = require('../lib/studioReply');
        let m = null; try { m = await M.getMember(id); } catch (e) {}
        const nm = m ? ((((m.firstName || '') + ' ' + (m.lastName || '')).trim()) || ('Mitglied ' + id)) : ('Mitglied ' + id);
        await SR.notifyStudio({
          member: m || { id: id },
          subject: '🗓️ Ernährungs-Phasenplan ausgelaufen – ' + nm,
          text: 'Der Phasenplan aus der Stoffwechselanalyse ist abgelaufen. Es gelten wieder die berechneten Zielwerte.\n\n'
            + 'Mitglied: ' + nm + '\nBitte im Team-Backend einen neuen Plan anlegen oder verlängern.',
        });
      } catch (e) {}
      plan.expiredNotified = true;
      try { await redisPipeline([['SET', PKEY(id), JSON.stringify(profile)]]); } catch (e) {}
      out.expired++;
      continue;
    }

    if (!r.current) continue;
    const key = r.current.key;
    if (!plan.lastPhaseKey) { plan.lastPhaseKey = key; plan.lastPhaseAt = Date.now(); try { await redisPipeline([['SET', PKEY(id), JSON.stringify(profile)]]); } catch (e) {} continue; }
    if (plan.lastPhaseKey === key) continue;   // kein Wechsel

    // ── Wechsel erkannt ──
    out.switched++;
    plan.lastPhaseKey = key;
    plan.lastPhaseAt = Date.now();
    try { await redisPipeline([['SET', PKEY(id), JSON.stringify(profile)]]); } catch (e) {}

    const name = r.current.name;
    const untilTxt = r.current.endDate ? (' Sie läuft bis ' + ymdDE(r.current.endDate) + '.') : '';
    const werte = [r.current.kcal ? (r.current.kcal + ' kcal') : '', r.current.protein ? (r.current.protein + ' g Eiweiß') : ''].filter(Boolean).join(' · ');
    const text = 'Deine neue Ernährungsphase startet: „' + name + '".' + untilTxt
      + (werte ? ('\n\nDeine neuen Tageswerte: ' + werte + '.') : '')
      + (r.current.note ? ('\n\n' + r.current.note) : '')
      + '\n\nDu siehst alles in der App unter Ernährung.';

    // Postfach: bleibt dauerhaft nachlesbar (kein Team-Alarm nötig).
    try {
      await Inbox.addVorgang(id, {
        type: 'allgemein',
        subject: 'Neue Ernährungsphase: ' + name,
        systemText: text,
        status: 'abgeschlossen', teamStatus: 'abgeschlossen', teamUnread: false,
      });
    } catch (e) {}
    // Push: bewusst ohne Zahlen auf dem Sperrbildschirm.
    try {
      const p = await Push.notifyMember(id, 'pushNews', { title: 'Neue Phase: ' + name, body: 'Deine Tageswerte wurden angepasst – schau in der App vorbei.' });
      if (p && p.ok) out.notified++;
    } catch (e) {}
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (!requireCronAuth(req, res)) return;
  try {
    const r = await run();
    // Nur Zahlen ins Log – keine Personen-/Gesundheitsdaten.
    try { console.log('[nutri-phase-tick]', JSON.stringify(r)); } catch (e) {}
    res.statusCode = 200;
    return res.end(JSON.stringify(Object.assign({ ok: true }, r)));
  } catch (e) {
    console.error('[nutri-phase-tick]', String(e && e.message));
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'tick_failed' }));
  }
};
module.exports.run = run;
