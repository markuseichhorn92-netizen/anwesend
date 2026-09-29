'use strict';

/**
 * FINN Journeys – die Abläufe als Daten.
 * -----------------------------------------------------------------------------
 * Schritt: { id, tpl, at(st,run,ctx) -> ms|null, grace?, when?(st,run,ctx), vars?(st,run,ctx),
 *            action?(st,run,ctx), repeat?, final? }
 *   at     Fälligkeit (null = noch nicht anwendbar, z. B. kein Probetraining gebucht)
 *   grace  wie lange nach Fälligkeit der Schritt noch sinnvoll ist (Standard 2 Tage);
 *          danach verfällt er – nach einem Ausfall kommt keine Nachrichtenlawine
 *   when   Bedingung zum Fälligkeitszeitpunkt; false = Schritt entfällt
 *   repeat Schritt bleibt offen (at() regelt selbst die Pause, z. B. alle 14 Tage)
 *   final  nach diesem Schritt endet der Lauf
 * Journey: { key, audience:'lead'|'member', title, description, steps, exit(st,run,ctx) -> Grund|null }
 *
 * ctx = { now, eng (Hash aus engagement), m (metrics), lead (Lead-Datensatz), stage }
 * Keine Gesundheitsdaten: Variablen sind Vorname, Termin, Besuchszahlen, Wochenziel.
 */

const Templates = require('./templates');
const Engagement = require('./engagement');

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const fn = (st) => (st && st.firstName) || '';

// ───────────────────────── Leads & Probetraining ─────────────────────────
const trialOk = (st) => !!(st.facts.trialAt && !st.facts.trialCancelledAt);
const won = (st, ctx) => !!(st.facts.wonAt || (ctx.lead && ctx.lead.status === 'gewonnen'));

const LEAD = {
  key: 'lead', audience: 'lead', title: 'Leads & Probetraining',
  description: 'Antwort in Sekunden über den FINN-Lead-Agenten, Erinnerungen vor dem Probetraining, Nachfassen danach, nach 14 Tagen „verloren".',
  steps: [
    { id: 'nudge_d1', tpl: 'fi_lead_followup', at: (st) => st.facts.leadAt ? st.facts.leadAt + DAY : null, grace: 2 * DAY,
      when: (st, run, ctx) => !st.facts.trialAt && !won(st, ctx), vars: (st) => ({ 1: fn(st) }) },
    { id: 'nudge_d4', tpl: 'fi_lead_last', at: (st) => st.facts.leadAt ? st.facts.leadAt + 4 * DAY : null, grace: 3 * DAY,
      when: (st, run, ctx) => !st.facts.trialAt && !won(st, ctx), vars: (st) => ({ 1: fn(st) }) },
    { id: 'trial_24h', tpl: 'fi_trial_24h', at: (st) => trialOk(st) ? st.facts.trialAt - 24 * HOUR : null,
      until: (st) => st.facts.trialAt - 4 * HOUR,
      // Wer kurzfristig bucht, hat die Bestätigung gerade erst bekommen.
      when: (st) => trialOk(st) && (!st.facts.trialBookedAt || st.facts.trialAt - st.facts.trialBookedAt >= 20 * HOUR),
      vars: (st) => ({ 1: fn(st), 2: Templates.fmtDate(st.facts.trialAt), 3: Templates.fmtTime(st.facts.trialAt) }) },
    { id: 'trial_2h', tpl: 'fi_trial_2h', at: (st) => trialOk(st) ? st.facts.trialAt - 2 * HOUR : null,
      until: (st) => st.facts.trialAt - 15 * MIN,
      when: (st) => trialOk(st) && (!st.facts.trialBookedAt || st.facts.trialAt - st.facts.trialBookedAt >= 3 * HOUR),
      vars: (st) => ({ 1: fn(st), 2: Templates.fmtTime(st.facts.trialAt) }) },
    { id: 'after', tpl: 'fi_trial_after', at: (st) => trialOk(st) ? st.facts.trialAt + 3 * HOUR : null, grace: 27 * HOUR,
      when: (st, run, ctx) => trialOk(st) && !won(st, ctx), vars: (st) => ({ 1: fn(st) }) },
    { id: 'offer_d2', tpl: 'fi_trial_offer', at: (st) => trialOk(st) ? st.facts.trialAt + 2 * DAY : null, grace: 2 * DAY,
      when: (st, run, ctx) => trialOk(st) && !won(st, ctx), vars: (st) => ({ 1: fn(st) }) },
    { id: 'last_d6', tpl: 'fi_lead_last', at: (st) => trialOk(st) ? st.facts.trialAt + 6 * DAY : null, grace: 3 * DAY,
      when: (st, run, ctx) => trialOk(st) && !won(st, ctx), vars: (st) => ({ 1: fn(st) }) },
    { id: 'lost', final: true, always: true, grace: 30 * DAY,
      at: (st) => { const base = st.facts.trialAt || st.facts.leadAt; return base ? base + 14 * DAY : null; },
      when: (st, run, ctx) => !won(st, ctx),
      action: async (st, run, ctx) => {
        if (!st.leadId) return;
        const LF = require('../leadflow');
        const lead = ctx.lead || await LF.getLead(st.leadId);
        if (lead && ['gewonnen', 'verloren', 'angebot'].indexOf(lead.status) < 0) { await LF.setLeadStatus(st.leadId, 'verloren'); await require('./kpi').bump('lead', 'lost'); }
      } },
  ],
  exit: (st, run, ctx) => (won(st, ctx) ? 'won' : null),
};

// ───────────────────────── Onboarding (erste 90 Tage) ─────────────────────────
const since = (ctx, st) => Engagement.visitsSince(ctx.eng, st.facts.joinAt);
const joined = (st) => st.facts.joinAt || null;

const ONBOARDING = {
  key: 'onboarding', audience: 'member', title: 'Onboarding',
  description: 'Willkommen, Einführungstraining, erster Besuch, Wochen-Check an Tag 7/14/21 gegen das Wochenziel, Nachfrage an Tag 30/60/90.',
  steps: [
    { id: 'welcome', tpl: 'fi_onb_welcome', at: (st) => joined(st) ? st.facts.joinAt + 10 * MIN : null, grace: 3 * DAY,
      vars: (st) => ({ 1: fn(st) }) },
    { id: 'induction', tpl: 'fi_onb_induction', at: (st) => joined(st) ? st.facts.joinAt + 3 * DAY : null, grace: 3 * DAY,
      when: (st, run, ctx) => !st.facts.inductionBookedAt && since(ctx, st) === 0, vars: (st) => ({ 1: fn(st) }) },
    { id: 'first_visit', tpl: 'fi_first_visit', at: (st) => st.facts.firstVisitAt ? st.facts.firstVisitAt + 2 * HOUR : null, grace: 2 * DAY,
      when: (st) => !!st.facts.firstVisitAt && (!st.facts.joinAt || st.facts.firstVisitAt >= st.facts.joinAt - DAY), vars: (st) => ({ 1: fn(st) }) },
    { id: 'week1', tpl: (st, run, ctx) => (since(ctx, st) >= 2 ? 'fi_week_good' : 'fi_week_nudge'),
      at: (st) => joined(st) ? st.facts.joinAt + 7 * DAY : null, grace: 2 * DAY,
      vars: (st, run, ctx) => ({ 1: fn(st), 2: String(since(ctx, st)) }) },
    { id: 'week2', tpl: (st, run, ctx) => (since(ctx, st) >= 3 ? 'fi_week_good' : 'fi_week_nudge'),
      at: (st) => joined(st) ? st.facts.joinAt + 14 * DAY : null, grace: 2 * DAY,
      // höchstens einer von Tag 7 / Tag 14
      when: (st, run) => !(run.done.week1 && /^(sent|dry)$/.test(run.done.week1.r)), vars: (st, run, ctx) => ({ 1: fn(st), 2: String(since(ctx, st)) }) },
    { id: 'week3', tpl: (st, run, ctx) => (since(ctx, st) >= 4 ? 'fi_week_good' : 'fi_week_nudge'),
      at: (st) => joined(st) ? st.facts.joinAt + 21 * DAY : null, grace: 3 * DAY,
      vars: (st, run, ctx) => ({ 1: fn(st), 2: String(since(ctx, st)) }),
      // Tag 21 mit weniger als 4 Besuchen: zusätzlich eine Aufgabe fürs Team (Anruf wirkt am stärksten).
      after: async (st, run, ctx) => { if (since(ctx, st) < 4) await teamTask(st, 'Onboarding Tag 21: erst ' + since(ctx, st) + ' Besuche – kurz anrufen und beim Einstieg helfen.'); } },
    { id: 'q30', tpl: 'fi_checkin_q', at: (st) => joined(st) ? st.facts.joinAt + 30 * DAY : null, grace: 3 * DAY, vars: (st) => ({ 1: fn(st), 2: '30' }) },
    { id: 'q60', tpl: 'fi_checkin_q', at: (st) => joined(st) ? st.facts.joinAt + 60 * DAY : null, grace: 3 * DAY, vars: (st) => ({ 1: fn(st), 2: '60' }) },
    { id: 'q90', tpl: 'fi_checkin_q', final: true, at: (st) => joined(st) ? st.facts.joinAt + 90 * DAY : null, grace: 3 * DAY, vars: (st) => ({ 1: fn(st), 2: '90' }) },
  ],
  exit: (st, run, ctx) => {
    if (st.facts.cancelled) return 'cancelled';
    if (st.facts.joinAt && ctx.now > st.facts.joinAt + 96 * DAY) return 'done';
    return null;
  },
};

// ───────────────────────── Motivation (Habit) ─────────────────────────
const HABIT_STEPS = [
  { id: 'below_goal', tpl: 'fi_habit_below', repeat: true, grace: 3 * DAY,
    at: (st, run, ctx) => {
      if (ctx.stage !== 'rutscht_ab') return null;
      if (st.facts.joinAt && ctx.now - st.facts.joinAt < 90 * DAY) return null;   // Onboarding hat Vorrang
      // Wer gerade aus einer Pause zurückkommt, bekommt keinen „unter dem Ziel"-Hinweis.
      const cb = st.runs && st.runs.comeback;
      if (cb && (!cb.exit || ctx.now - cb.exit.at < 14 * DAY)) return null;
      const d = run.done.below_goal; return d ? d.at + 14 * DAY : ctx.now;
    },
    vars: (st, run, ctx) => ({ 1: fn(st), 2: String(ctx.m ? ctx.m.v28 : 0), 3: String(ctx.m ? ctx.m.goal : 2) }) },
].concat(Engagement.MILESTONES.map((n) => ({
  id: 'ms_' + n, tpl: 'fi_milestone', grace: 3 * DAY,
  // ms:<n> > 1 = Zeitpunkt, an dem der Meilenstein live erreicht wurde (1 = schon vor dem Nachlauf erreicht)
  at: (st, run, ctx) => { const t = Number(ctx.eng && ctx.eng['ms:' + n]); return t > 1 ? t + 2 * HOUR : null; },
  vars: (st) => ({ 1: fn(st), 2: String(n) }),
}))).concat(Engagement.STREAKS.map((n) => ({
  id: 'streak_' + n, tpl: 'fi_streak', grace: 7 * DAY,
  at: (st, run, ctx) => (ctx.m && ctx.m.tracked && ctx.m.weekStreak >= n && ctx.m.weekStreak < n + 2 && run.startedAt < ctx.now - 7 * DAY ? ctx.now : null),
  vars: (st) => ({ 1: fn(st), 2: String(n) }),
})));

const HABIT = {
  key: 'habit', audience: 'member', title: 'Motivation',
  description: 'Hinweis bei zwei Wochen unter dem Wochenziel (höchstens alle 14 Tage), Glückwunsch zu 10/25/50/100/250 Besuchen und zu Wochenserien.',
  steps: HABIT_STEPS,
  exit: (st) => (st.facts.cancelled ? 'cancelled' : null),
};

// ───────────────────────── Comeback ─────────────────────────
const lastVisit = (ctx) => (ctx.m && ctx.m.last) || null;
const COMEBACK = {
  key: 'comeback', audience: 'member', title: 'Comeback',
  description: '10 Tage nicht da: sanfter Anstoß. 21 Tage: Trainer-Termin anbieten. 28 Tage: Aufgabe fürs Team (anrufen), keine Automatik mehr. Ein Check-in beendet den Ablauf sofort.',
  steps: [
    { id: 'c10', tpl: 'fi_comeback_1', at: (st, run, ctx) => (lastVisit(ctx) ? lastVisit(ctx) + 10 * DAY : null), until: (st, run, ctx) => lastVisit(ctx) + 20 * DAY,
      vars: (st) => ({ 1: fn(st) }) },
    { id: 'c21', tpl: 'fi_comeback_2', at: (st, run, ctx) => (lastVisit(ctx) ? lastVisit(ctx) + 21 * DAY : null), until: (st, run, ctx) => lastVisit(ctx) + 27 * DAY,
      vars: (st) => ({ 1: fn(st) }) },
    { id: 'team', final: true, grace: 14 * DAY, at: (st, run, ctx) => (lastVisit(ctx) ? lastVisit(ctx) + 28 * DAY : null),
      action: async (st) => { await teamTask(st, 'Seit 28 Tagen nicht im Studio – bitte anrufen (Comeback). Ein persönliches Gespräch hilft am meisten.'); } },
  ],
  exit: (st, run, ctx) => {
    if (st.facts.cancelled) return 'cancelled';
    if (lastVisit(ctx) && lastVisit(ctx) > run.startedAt) return 'visited';
    return null;
  },
};

// ───────────────────────── Einladung (Einwilligung abfragen) ─────────────────────────
const INVITE = {
  key: 'invite', audience: 'member', title: 'Einladung',
  description: 'Einmalige Frage an bekannte Nummern aktiver Mitglieder, ob sie Motivation und Tipps per WhatsApp möchten („Ja, gern" / „Nein, danke"). Nur nach Rechtsprüfung einschalten.',
  steps: [
    { id: 'invite', tpl: 'fi_invite', final: true, grace: 14 * DAY, at: (st, run) => run.startedAt, when: (st) => !st.facts.cancelled, vars: (st) => ({ 1: fn(st) }),
      after: async (st) => { await require('./inbound').ask(st.phone, ['service', 'marketing'], 'invite', st.subj); } },
  ],
  exit: () => null,
};

async function teamTask(st, text) {
  try {
    const Todos = require('../todos');
    const who = (st.firstName || 'Mitglied') + (st.cid ? (' (Kd. ' + st.cid + ')') : '');
    await Todos.addTodo({ text: 'FINN-Journey · ' + who + ': ' + text });
    await require('./kpi').bump('all', 'team_task');
  } catch (e) {}
}

const ALL = { lead: LEAD, onboarding: ONBOARDING, habit: HABIT, comeback: COMEBACK, invite: INVITE };
function get(key) { return ALL[String(key || '')] || null; }
function list() { return Object.keys(ALL).map((k) => ALL[k]); }

module.exports = { ALL, get, list, teamTask, MIN, HOUR, DAY };
