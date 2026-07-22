'use strict';

/**
 * GET/POST /api/member/morning   (Mitglieds-Session erforderlich)
 * ----------------------------------------------------------------
 * Morgen-Check mit dem Polar-H9-Brustgurt: Trainingsbereitschaft aus Ruhepuls
 * (und – falls ein stabiler R-R-Stream ankommt – HRV) gegen die persönliche
 * Baseline. Der Client misst live per Bluetooth und schickt die abgeleiteten
 * Werte; Bewertung (Ampel), Baseline und Verlauf werden serverseitig berechnet.
 * Die Daten fließen in FINN (coach.js) und in die FINN-Einschätzung.
 *
 *  GET                              -> { ok, available, premium, consent, list, latest, baseline, eval, readiness, trend, ... }
 *  POST { action:'consent', value } -> Einwilligung setzen (true=Premium) / widerrufen (false=löscht Daten)
 *  POST { action:'save', measurement } -> Messung speichern (Premium + Einwilligung)
 *  POST { action:'delete', sel }    -> Messung (date/ts) löschen
 *  POST { action:'assess' }         -> FINN-Einschätzung (Premium)
 *
 * KOMPLETT PREMIUM: Messen/Auswerten nur mit Coach Premium. Herz-/HRV-Werte sind
 * Gesundheitsdaten (DSGVO Art. 9) -> ausdrückliche Einwilligung, jederzeit
 * widerrufbar (löscht die Daten). Kein Medizinprodukt: Wellness-Signal, keine Diagnose.
 * Ohne KV-Store: available:false.
 */

const M = require('../../lib/members');
const MO = require('../../lib/morning');
const V = require('../../lib/vitals');
const WO = require('../../lib/workouts');
const Battery = require('../../lib/battery');
const AI = require('../../lib/ai');
const Ent = require('../../lib/entitlements');
const Coaching = require('../../lib/coaching');
const Training = require('../../lib/training');
const Inbox = require('../../lib/inbox');
const SR = require('../../lib/studioReply');
const { hasStore } = require('../../lib/store');

// Herzgurt-Angebot (muss zu den Frontend-Konstanten MO_H9_PRICE/MO_H9_DISC passen).
const STRAP_PRICE = 59.95;      // offizieller Polar-H9-Preis (€)
const STRAP_DISCOUNT = 0.20;    // Coach-Premium-Rabatt
function euro(n) { return (Math.round(n * 100) / 100).toFixed(2).replace('.', ',') + ' €'; }

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

const PREMIUM_MSG = 'Der Vital-Check (Bereitschaft, HRV & Trainingssteuerung) ist ein Coach-Premium-Feature.';

async function readState(id) {
  const list = await MO.list(id);
  let consent = false; try { consent = await MO.getConsent(id); } catch (e) {}
  let teamShare = false; try { teamShare = await MO.getTeamShare(id); } catch (e) {}
  let strapReserved = false; try { strapReserved = await MO.getStrapReserved(id); } catch (e) {}
  let recovery = null; try { recovery = await MO.getRecovery(id); } catch (e) {}
  let age = 0; try { const prof = (await Coaching.kvGetJson('nutri:p:' + id)) || {}; age = Number(prof.age) || 0; } catch (e) {}
  const tier = Ent.publicTier(await Ent.getEntitlement(id));
  const base = MO.baseline(list);
  const latest = list[0] || null;
  const readiness = latest ? MO.readiness(latest, base) : null;
  const ot = MO.overtraining(list);
  // EIN widerspruchsfreies Tages-Urteil – Basis für alle Tages-Karten + FINN.
  const verdict = MO.dayVerdict({ readiness: readiness, overtraining: ot, recovery: recovery, latest: latest });
  const trList = await MO.trList(id);
  const trLatest = trList[0] || null;
  // Passive Vitalwerte aus Apple Health (Apple Watch/Waage) – nur bei Einwilligung.
  let vList = [];
  try { if (consent) vList = await V.list(id); } catch (e) {}
  let vitalsBlock = null;
  try {
    if (consent && vList.length) {
      const vLatest = V.latest(vList);
      const vBase = V.baseline(vList);
      vitalsBlock = {
        latest: vLatest, baseline: vBase,
        readiness: V.readiness(vLatest, vBase),
        sleep: V.sleepRef(vLatest, vBase),
        sleepDetail: V.sleepDetail(vLatest),
        eval: V.evaluate(vLatest, vBase),
        trend: V.trend(vList),
        days: vList.length,
      };
    }
  } catch (e) {}
  // Vital-Akku: modellierte Tagesenergie aus Erholung + Schlaf minus Trainingslast.
  // Nur mit echtem Erholungs-Score (HRV/Ruhepuls) und Einwilligung – sonst null (Client zeigt Teaser).
  let battery = null;
  try {
    if (consent) {
      let best = null, src = null;
      if (readiness && readiness.score != null) { best = readiness; src = 'morgen'; }
      else if (vitalsBlock && vitalsBlock.readiness && vitalsBlock.readiness.score != null) { best = vitalsBlock.readiness; src = 'passiv'; }
      if (best) {
        let weekLoad = null; try { weekLoad = WO.weeklyLoad(await WO.list(id)); } catch (e) {}
        battery = Battery.compute({
          readiness: best,
          sleepDetail: vitalsBlock ? vitalsBlock.sleepDetail : null,
          weekLoad: weekLoad,
          recoveryActive: !!recovery,
          overtraining: ot,
          source: src,
        });
        // 7-Tage-Mini-Kurve: pro Tag die Ladung (Erholung + Schlaf) aus den passiven
        // Vitalwerten – nur als Trend (Ladehöhe je Morgen), ohne Tages-Entladung.
        if (battery && battery.hasData && vList.length >= 3) {
          try {
            const vBase = V.baseline(vList);
            const series = vList.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 7).map((d) => {
              const rr = V.readiness(d, vBase); const sd = V.sleepDetail(d);
              const lvl = Battery.dayCharge(rr && rr.score, sd && sd.score);
              return (lvl == null) ? null : { date: d.date, level: lvl };
            }).filter(Boolean).reverse();   // ältester zuerst (links)
            if (series.length >= 3) battery.series = series;
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
  return {
    ok: true, available: true,
    premium: !!tier.premium, tier: tier.tier, trialing: tier.trialing,
    consent: consent,
    teamShare: teamShare,
    strapReserved: strapReserved,
    list: list,
    latest: latest,
    baseline: base,
    eval: latest ? MO.evaluate(latest, base) : [],
    readiness: readiness,
    balance: latest ? MO.balance(latest, base) : null,
    bioAge: latest ? MO.hrvAge(latest, age, base) : null,
    bioAgeSeries: MO.hrvAgeSeries(list),
    zones: MO.trainingZones(age),
    trainingLoad: readiness ? MO.trainingLoad(readiness, latest) : null,
    insights: MO.insights(list),
    overtraining: ot,
    // EIN widerspruchsfreies Tages-Urteil (Physiologie + Frühwarnung + Erholungsphase +
    // subjektive Signale verrechnet). Client leitet ALLE Tages-Karten daraus ab.
    verdict: verdict,
    // Erholungs-/Pausen-Steuerung: aktiver Modus (+ „stale", wenn heute wieder erholt) +
    // (falls keiner aktiv) der aktuelle Vorschlag.
    recovery: recovery ? Object.assign({}, recovery, { stale: !!verdict.recoveryStale }) : recovery,
    recoverySuggest: recovery ? { suggest: false } : MO.recoverySuggest(list),
    weekly: MO.weeklyReport(list),
    trend: MO.trend(list),
    minCalib: MO.MIN_CALIB,
    vitalLedger: MO.vpLedger(list).concat(MO.vpLedgerTraining(trList)),
    // Trainings-Check-in (kurzer Puls-Check vorm Workout) – gegen die Morgen-Baseline.
    training: {
      list: trList,
      latest: trLatest,
      readiness: trLatest ? MO.trainReadiness(trLatest, base) : null,
      hasBaseline: base.rhr != null || base.hrv != null,
    },
    vitals: vitalsBlock,
    battery: battery,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  const sess = await M.getSession(M.bearer(req));
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!hasStore) return j(res, 200, { ok: true, available: false });
  const id = sess.id;

  if (req.method === 'GET') {
    try { return j(res, 200, await readState(id)); }
    catch (e) { return j(res, 200, { ok: false, available: true, error: 'load_failed' }); }
  }
  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });

  const body = await M.readBody(req);
  const action = String((body && body.action) || '');
  // Einwilligungs-Widerruf (DSGVO) ist IMMER erlaubt – nicht ratelimiten.
  const isConsentRevoke = action === 'consent' && !(body.value === true || body.value === 'true' || body.value === 1);
  if (!isConsentRevoke && !(await M.rateLimit('morning:' + id, 60, 3600))) return j(res, 429, { ok: false, error: 'rate_limited' });

  try {
    const premium = Ent.isPremium(await Ent.getEntitlement(id));

    // Einwilligung. Widerruf (value:false) ist IMMER erlaubt (DSGVO) und löscht die Messwerte.
    if (action === 'consent') {
      const on = body.value === true || body.value === 'true' || body.value === 1;
      if (on && !premium) return j(res, 200, { ok: false, error: 'premium_required', message: PREMIUM_MSG });
      await MO.setConsent(id, on);
      if (!on) { try { await V.clear(id); } catch (e) {} }   // Widerruf löscht auch die Apple-Health-Vitalwerte
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // Passive Vitalwerte aus Apple Health (Apple Watch/Waage) speichern. Gesundheitsdaten
    // (Art. 9) -> Premium + dieselbe Einwilligung wie der Vital-Check. Ein Eintrag pro Tag.
    if (action === 'vitals') {
      if (!premium) return j(res, 200, { ok: false, error: 'premium_required', message: PREMIUM_MSG });
      if (!(await MO.getConsent(id))) return j(res, 200, { ok: false, error: 'consent_required', message: 'Bitte stimme zuerst der Verarbeitung deiner Herzdaten zu.' });
      const r = await V.add(id, body.vitals || {}, Date.now());
      if (!r.ok) return j(res, 200, { ok: false, error: r.error || 'save_failed' });
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // Messung speichern (Premium + Einwilligung nötig). Morgen-Check-in ODER
    // kurzer Trainings-Check-in (measurement.kind === 'training').
    if (action === 'save') {
      if (!premium) return j(res, 200, { ok: false, error: 'premium_required', message: PREMIUM_MSG });
      if (!(await MO.getConsent(id))) return j(res, 200, { ok: false, error: 'consent_required', message: 'Bitte stimme zuerst der Verarbeitung deiner Herzdaten zu.' });
      const meas = body.measurement || {};
      const isTrain = meas.kind === 'training';
      const r = isTrain ? await MO.trAdd(id, meas, Date.now()) : await MO.add(id, meas, Date.now());
      if (!r.ok) return j(res, 200, { ok: false, error: r.error || 'save_failed', message: 'Es kam kein verwertbarer Messwert an. Miss bitte ruhig und versuch es erneut.' });
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // Trainer-Freigabe der Bereitschaft (Opt-in). Einschalten nur mit bestehender Einwilligung.
    if (action === 'teamshare') {
      const on = body.value === true || body.value === 'true' || body.value === 1;
      if (on && !(await MO.getConsent(id))) return j(res, 200, { ok: false, error: 'consent_required', message: 'Aktiviere zuerst den Vital-Check.' });
      await MO.setTeamShare(id, on);
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // Herzgurt (Polar H9) unverbindlich an der Rezeption reservieren.
    // KEIN Online-Kauf, KEINE Zahlung: Bezahlung & Übergabe an der Theke
    // -> kein Fernabsatz, kein Widerruf. Für alle Mitglieder (nicht premium-gated).
    if (action === 'strapReserve') {
      // Schon reserviert? Nicht doppelt melden – nur bestätigen.
      let already = false; try { already = await MO.getStrapReserved(id); } catch (e) {}
      if (already) return j(res, 200, { ok: true, reserved: true, message: 'Schon reserviert – wir legen dir den Polar H9 an der Rezeption bereit.' });
      if (!(await M.rateLimit('strap-reserve:' + id, 4, 86400))) {
        return j(res, 200, { ok: false, error: 'rate_limited', message: 'Du hast den Herzgurt schon reserviert – wir legen ihn dir an der Rezeption bereit.' });
      }
      let mem = null; try { mem = await M.getMember(id); } catch (e) {}
      const disc = STRAP_PRICE * (1 - STRAP_DISCOUNT);
      const preis = premium ? (euro(disc) + ' (Coach Premium −20 %, regulär ' + euro(STRAP_PRICE) + ')') : euro(STRAP_PRICE);
      const nm = mem ? (((mem.firstName || '') + ' ' + (mem.lastName || '')).trim()) : '';
      let ok = false, vorgang = null;
      try {
        vorgang = await Inbox.addVorgang(id, {
          type: 'kontakt',
          subject: 'Herzgurt reservieren · Polar H9',
          systemText: 'Du hast den Polar H9 unverbindlich reserviert. Bezahlung (' + preis + ') und Abholung erfolgen direkt an der Rezeption – die Reservierung ist kostenlos und unverbindlich.',
          teamText: 'Hallo' + (mem && mem.firstName ? (' ' + mem.firstName) : '') + ', wir legen dir einen Polar H9 an der Rezeption bereit. Bezahlung & Abholung an der Theke – deine Reservierung ist unverbindlich.',
          needsAction: true,
        });
        if (vorgang) ok = true;
      } catch (e) {}
      try {
        const who = (nm || '—')
          + (mem && mem.customerNumber ? (' (' + mem.customerNumber + ')') : '')
          + (mem && mem.email ? (' · ' + mem.email) : '');
        const text = 'Herzgurt-Reservierung über den Vital-Check (unverbindlich)\n\n'
          + 'Mitglied: ' + who + '\n'
          + 'Produkt: Polar H9 Herzfrequenz-Brustgurt\n'
          + 'Preis: ' + preis + '\n'
          + 'Coach Premium: ' + (premium ? 'ja (−20 %)' : 'nein') + '\n\n'
          + 'Bitte einen Polar H9 an der Rezeption bereitlegen. Bezahlung & Übergabe an der Theke '
          + '(kein Online-Kauf, kein Versand -> kein Widerruf). Die Reservierung ist unverbindlich.';
        const r = await SR.notifyStudio({ member: mem, vorgang: vorgang, subject: '❤️ Herzgurt-Reservierung – ' + (nm || 'Mitglied'), text: text });
        if (r && r.ok) ok = true;
      } catch (e) {}
      if (!ok) return j(res, 200, { ok: false, message: 'Reservierung konnte gerade nicht gespeichert werden – bitte später erneut oder frag an der Rezeption.' });
      try { await MO.setStrapReserved(id, true); } catch (e) {}
      return j(res, 200, { ok: true, reserved: true, message: 'Reserviert! Wir legen dir den Polar H9 an der Rezeption bereit – bezahlen und mitnehmen kannst du ihn direkt an der Theke.' });
    }

    // Erholungs-/Pausen-Modus annehmen. Dauer/Grund kommen aus dem SERVER-Vorschlag
    // (nicht vom Client vertraut) – nur wenn aktuell ein Vorschlag aktiv ist.
    if (action === 'recovery-start') {
      const list = await MO.list(id);
      const sug = MO.recoverySuggest(list);
      if (!sug.suggest) return j(res, 200, { ok: false, error: 'no_suggestion', message: 'Aktuell ist keine Pause nötig.' });
      const r = await MO.setRecovery(id, sug.days, sug.reason);
      if (!r.ok) return j(res, 200, { ok: false, error: 'save_failed' });
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }
    // Erholungsphase vorzeitig beenden (immer erlaubt – eigene Entscheidung).
    if (action === 'recovery-end') {
      await MO.clearRecovery(id);
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // Messung löschen (immer erlaubt – eigene Daten). scope:'training' -> Trainings-Check-in.
    if (action === 'delete') {
      const sel = body.sel != null ? body.sel : body.date;
      if (body.scope === 'training') await MO.trRemove(id, sel);
      else await MO.remove(id, sel);
      return j(res, 200, Object.assign({ ok: true }, await readState(id)));
    }

    // FINN-Einschätzung zum Morgen-Check (Premium).
    if (action === 'assess') {
      if (!premium) return j(res, 200, { ok: false, error: 'premium_required', message: 'Die FINN-Einschätzung ist Teil von Coach Premium.' });
      const list = await MO.list(id);
      if (!list.length) return j(res, 200, { ok: false, error: 'no_data', message: 'Miss zuerst deinen Morgen-Check.' });
      if (!AI.hasAI) return j(res, 200, { ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar.' });
      const m = list[0]; const base = MO.baseline(list); const t = MO.trend(list);
      const bal = MO.balance(m, base); const ba = MO.hrvAge(m, 0, base);
      let firstName = '', goal = '', age = 0, plannedTraining = '';
      try { const mem = await M.getMember(id); firstName = (mem && mem.firstName) || ''; } catch (e) {}
      try { const prof = (await Coaching.kvGetJson('nutri:p:' + id)) || {}; goal = prof.goal || ''; age = Number(prof.age) || 0; } catch (e) {}
      try { const act = await Training.resolveActive(id); if (act && act.plan) plannedTraining = act.plan.title || ''; } catch (e) {}
      const r = await AI.coachMorningCheck({
        firstName: firstName, goal: goal,
        rhr: m.rhr, rhrBaseline: base.rhr, hrv: m.hrvRmssd, hrvBaseline: base.hrv, sdnn: m.hrvSdnn,
        balance: (bal && bal.value != null) ? bal.value : null, balanceLabel: (bal && bal.value != null) ? bal.label : '',
        respRate: m.respRate, orthostatic: m.orthostaticDelta,
        sleepSelf: m.sleepSelf, sleepHours: m.sleepHours, moodSelf: m.moodSelf, stressSelf: m.stressSelf, soreness: m.soreness, sick: m.sick,
        trendRhr: (t && t.sincePrev) ? t.sincePrev.rhr : null,
        plannedTraining: plannedTraining, calibrating: base.calibrating,
        under18: age > 0 && age < 18,
      });
      if (!r.ok) return j(res, 200, { ok: false, error: r.error || 'gen_failed', message: 'Das hat gerade nicht geklappt – bitte gleich noch einmal.' });
      return j(res, 200, { ok: true, check: r.check });
    }

    return j(res, 200, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return j(res, 200, { ok: false, error: 'action_failed' });
  }
};
