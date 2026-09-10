'use strict';

/**
 * Fit-Inn Trier · Ernährungs-Coaching · Täglicher Motivations-Impuls (Push)
 * -------------------------------------------------------------------------
 * Ein täglicher Cron (api/nutrition-impulse.js + .github/workflows/nutrition-
 * impulse.yml) schickt eingeschriebenen Premium-Mitgliedern morgens FINNs
 * Tagesimpuls als Push. Muster wie lib/nudge.js – einwilligungskonform & spamfrei:
 *
 *  - Nur wenn Push eingerichtet ist (Push.hasPush) und ein Store da ist, sonst
 *    sauberer No-Op ({ran:false}); es wird nie geworfen.
 *  - Einwilligung: Push-Hauptschalter (push) UND Kategorie (pushCoach) an.
 *  - Nur EINGESCHRIEBENE (nutri:coach) und nur PREMIUM (der Impuls ist die
 *    KI-Leistung; Gratis-Nutzer sehen den statischen Impuls in der App).
 *  - Kosten: der Impuls wird pro Berlin-Tag gecacht (Coaching.ensureImpulse);
 *    der Cron erzeugt ihn ggf. und pusht ihn -> höchstens 1 KI-Call/Tag/Mitglied.
 *    Anti-Doppel-Push über impulse.pushedAt + Tages-Lock.
 */

var Push = require('./push');
var Store = require('./store');
var Prefs = require('./prefs');
var M = require('./members');
var AI = require('./ai');
var Ent = require('./entitlements');
var Coaching = require('./coaching');

var redisPipeline = Store.redisPipeline;
var hasStore = Store.hasStore;

var LOCK_KEY = 'nutri:impulse:lock';
var LOCK_TTL = parseInt(process.env.IMPULSE_LOCK_SEC || '72000', 10); // ~20 h
var CONCURRENCY = 5;

async function acquireLock() {
  try {
    var res = await redisPipeline([['SET', LOCK_KEY, '1', 'NX', 'EX', String(LOCK_TTL)]]);
    var r = res && res[0];
    return r === 'OK' || r === 'ok' || (r && r.result === 'OK');
  } catch (e) { return false; }
}

// KI-Generator für ein Mitglied (nur Premium; rate-limitiert => 1 Call/Tag).
function makeAiGen(id, st, today) {
  if (!AI.hasAI) return null;
  return async function () {
    if (!(await M.rateLimit('nutri-impulse:' + id, 5, 86400))) return null;
    var prof = (await Coaching.kvGetJson('nutri:p:' + id)) || {};
    var firstName = ''; try { var m = await M.getMember(id); firstName = (m && m.firstName) || ''; } catch (e) {}
    var wk = Coaching.activeWeek(st, today); var meta = Coaching.lessonMeta(wk);
    var streak = Coaching.habitStreak(await Coaching.getHabitRec(id), today);
    var r = await AI.coachDailyImpulse({ firstName: firstName, goal: prof.goal, week: wk, lessonTitle: meta.title, streak: streak, under18: (Number(prof.age) || 99) < 18 });
    return (r && r.ok && r.text) ? { text: r.text, focusHabitId: null, source: 'ai' } : null;
  };
}

// Ein Mitglied prüfen und ggf. den Tagesimpuls pushen. Wirft nie. -> { eligible, sent }.
async function processMember(id) {
  try {
    var today = Coaching.berlinToday();
    // a. Einwilligung: Hauptschalter + Coaching-Kategorie.
    var prefs = await Prefs.getPrefs(id);
    if (!prefs || prefs.push === false || prefs.pushCoach === false) return { eligible: false, sent: false };
    // b. Gerät vorhanden?
    var tokens = await Push.tokensFor(id);
    if (!tokens || !tokens.length) return { eligible: false, sent: false };
    // c. Eingeschrieben?
    var st = await Coaching.getState(id);
    if (!st || !st.enrolled) return { eligible: false, sent: false };
    // d. Premium? (Impuls-Push ist die KI-Leistung.)
    var premium = false; try { premium = Ent.isPremium(await Ent.getEntitlement(id)); } catch (e) { premium = false; }
    if (!premium) return { eligible: false, sent: false };
    // e. Heute schon gepusht? (Anti-Doppel)
    var prev = await Coaching.getImpulse(id);
    if (prev && prev.date === today && prev.pushedAt) return { eligible: false, sent: false };
    // -> eligible. Impuls sicherstellen (aus Cache oder 1× erzeugen) und pushen.
    var rec = await Coaching.ensureImpulse(id, st, today, makeAiGen(id, st, today));
    if (!rec || !rec.text) return { eligible: true, sent: false };
    var res = await Push.notifyMember(id, 'pushCoach', { title: 'Dein Ernährungs-Coach', body: rec.text, url: '/mitglieder?ern=coach' });
    if (res && res.ok) { try { await Coaching.markImpulsePushed(id, today); } catch (e) {} return { eligible: true, sent: true }; }
    return { eligible: true, sent: false };
  } catch (e) {
    return { eligible: false, sent: false };
  }
}

/**
 * Tagesimpulse verschicken.
 * @param {{force?:boolean}} opts force=true überspringt den Tages-Lock (Cron).
 * @returns {Promise<{ran:boolean, scanned:number, eligible:number, sent:number}>}
 */
async function run(opts) {
  // Ohne sichtbares Ernährungsmodul kein Ernährungs-Push: ein Impuls zu einem
  // Bereich, den die App nicht mehr zeigt, wäre für das Mitglied nur verwirrend.
  if (!require('./features').ernOn()) return { ran: false, reason: 'ern_off', scanned: 0, eligible: 0, sent: 0 };
  opts = opts || {};
  if (!Push.hasPush || !hasStore) return { ran: false, scanned: 0, eligible: 0, sent: 0 };
  if (!opts.force) { var got = await acquireLock(); if (!got) return { ran: false, scanned: 0, eligible: 0, sent: 0 }; }

  var members = await Push.allPushMembers();
  var scanned = 0, eligible = 0, sent = 0;
  for (var i = 0; i < members.length; i += CONCURRENCY) {
    var slice = members.slice(i, i + CONCURRENCY);
    var results = await Promise.all(slice.map(function (id) { return processMember(id); }));
    results.forEach(function (r) { scanned++; if (r && r.eligible) eligible++; if (r && r.sent) sent++; });
  }
  return { ran: true, scanned: scanned, eligible: eligible, sent: sent };
}

module.exports = { run, processMember };
