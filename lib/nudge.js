'use strict';

/**
 * Fit-Inn Trier · Reaktivierungs-Push-Nudges („Wir vermissen dich")
 * -----------------------------------------------------------------
 * Ein täglicher Cron (api/nudge.js + .github/workflows/nudge.yml) schickt
 * aktiven Mitgliedern, die länger nicht mehr da waren, eine freundliche
 * „Wir vermissen dich"-Push. Einwilligungskonform und spamfrei:
 *
 *  - Versand NUR, wenn Push eingerichtet ist (Push.hasPush) und ein Store da ist,
 *    sonst sauberer No-Op ({ran:false}), es wird nie geworfen.
 *  - Einwilligung: Push-Hauptschalter (push) UND Kategorie (pushNews) müssen an
 *    sein. notifyMember prüft das nochmals serverseitig (doppelt sicher).
 *  - Anti-Spam: pro Mitglied nie öfter als alle NUDGE_COOLDOWN_DAYS Tage
 *    (Sperr-Key nudge:sent:<id> mit TTL). Tages-Lock verhindert Doppelläufe.
 *  - Keine gekündigten/ehemaligen Mitglieder (contract.active/cancelled).
 *
 * Env-Schwellen (mit Defaults):
 *   NUDGE_MIN_DAYS       10   Nudge erst ab so vielen Tagen ohne Check-in
 *   NUDGE_MAX_DAYS       120  darüber gilt jemand als „weg" -> kein Nudge
 *   NUDGE_COOLDOWN_DAYS  14   Mindestabstand zwischen zwei Nudges pro Mitglied
 *   NUDGE_LOCK_SEC       72000 (~20 h) Tages-Lock gegen Doppelläufe
 */

var Push = require('./push');
var Store = require('./store');
var Prefs = require('./prefs');
var M = require('./members');
var AI = require('./ai');

var redisPipeline = Store.redisPipeline;
var hasStore = Store.hasStore;

var LOCK_KEY = 'nudge:lock';
var LOCK_TTL = parseInt(process.env.NUDGE_LOCK_SEC || '72000', 10);          // ~20 h
var MIN_DAYS = parseInt(process.env.NUDGE_MIN_DAYS || '10', 10);
var MAX_DAYS = parseInt(process.env.NUDGE_MAX_DAYS || '120', 10);
var COOLDOWN_DAYS = parseInt(process.env.NUDGE_COOLDOWN_DAYS || '14', 10);
var COOLDOWN_SEC = String(Math.max(1, COOLDOWN_DAYS) * 86400);
var CONCURRENCY = 5;

// Deterministischer Hash über die Mitglieds-ID -> stabile Text-Variante (kein Random).
function idHash(s) {
  var str = String(s == null ? '' : s);
  var h = 0;
  for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
  return h;
}

// Statische Text-Varianten (warm, per „du", ohne Emoji – das Emoji sitzt im Titel).
function staticBody(id, name, days) {
  var lead = name ? ('Hey ' + name + '! ') : '';
  var variants = [
    lead + 'Wir haben dich die letzten ' + days + ' Tage vermisst – dein Training wartet auf dich. Komm bald wieder vorbei!',
    lead + 'Seit ' + days + ' Tagen war es ruhig um dich bei uns. Wie wäre es mit einem frischen Start diese Woche?',
    lead + 'Dein Platz im Fit-Inn ist seit ' + days + ' Tagen frei. Wir freuen uns riesig, dich wiederzusehen!',
    lead + 'Die letzten ' + days + ' Tage ohne dich waren lang. Schnür die Schuhe und schau bald wieder rein!',
  ];
  return variants[idHash(id) % variants.length];
}

// Nachricht bauen: optional personalisiert per KI (FINN), sonst statische Variante.
async function buildBody(id, name, days) {
  if (AI.hasAI) {
    try {
      var r = await AI.coachTip('War ' + days + ' Tage nicht im Studio', '');
      if (r && r.ok && r.answer) {
        var a = String(r.answer).trim();
        if (a) return name ? ('Hey ' + name + '! ' + a) : a;
      }
    } catch (e) { /* Fallback auf statisch */ }
  }
  return staticBody(id, name, days);
}

// Tages-Lock: nur wer 'OK' bekommt, darf arbeiten (NX = nur wenn noch nicht gesetzt).
async function acquireLock() {
  try {
    var res = await redisPipeline([['SET', LOCK_KEY, '1', 'NX', 'EX', String(LOCK_TTL)]]);
    var r = res && res[0];
    return r === 'OK' || r === 'ok' || (r && r.result === 'OK');
  } catch (e) { return false; }
}

// Ein Mitglied prüfen und ggf. nudgen. Wirft nie. -> { eligible, sent }.
async function processMember(id) {
  try {
    // a. Anti-Spam: kürzlich schon genudged? (billigster Check zuerst)
    var exRes = await redisPipeline([['EXISTS', 'nudge:sent:' + id]]);
    if (Number(exRes && exRes[0]) > 0) return { eligible: false, sent: false };

    // b. Einwilligung (spart Magicline-Calls, wenn aus): Hauptschalter + Kategorie.
    var prefs = await Prefs.getPrefs(id);
    if (!prefs || prefs.push === false || prefs.pushNews === false) return { eligible: false, sent: false };

    // c. Hat das Mitglied überhaupt (noch) ein Gerät?
    var tokens = await Push.tokensFor(id);
    if (!tokens || !tokens.length) return { eligible: false, sent: false };

    // d. Keine gekündigten/ehemaligen Mitglieder nudgen.
    var contract = null;
    try { contract = await M.getContract(id); } catch (e) { contract = null; }
    if (!contract || contract.active === false || contract.cancelled) return { eligible: false, sent: false };

    // e. Wie lange nicht mehr da? Nur im Fenster [MIN_DAYS, MAX_DAYS] nudgen.
    var days = null;
    try { days = await M.daysSinceLastCheckin(id, { pages: 1 }); } catch (e) { days = null; }
    if (days == null || days < MIN_DAYS || days > MAX_DAYS) return { eligible: false, sent: false };

    // -> eligible: passt alle Kriterien, wir versuchen zu nudgen.
    // f. Nachricht bauen (Vorname + Tageszahl).
    var member = null;
    try { member = await M.getMember(id); } catch (e) { member = null; }
    var name = (member && member.firstName) ? String(member.firstName).trim() : '';
    var title = 'Wir vermissen dich! 💪';
    var body = await buildBody(id, name, days);

    // g. Senden (respektiert Prefs nochmals -> doppelt sicher).
    var res = await Push.notifyMember(id, 'pushNews', { title: title, body: body, url: '/mitglieder' });

    // h. Bei Erfolg Anti-Spam-Sperre setzen.
    if (res && res.ok) {
      try { await redisPipeline([['SET', 'nudge:sent:' + id, '1', 'EX', COOLDOWN_SEC]]); } catch (e) {}
      return { eligible: true, sent: true };
    }
    return { eligible: true, sent: false };
  } catch (e) {
    // Ein einzelnes Mitglied darf den Lauf nie abbrechen.
    return { eligible: false, sent: false };
  }
}

/**
 * Reaktivierungs-Nudges verschicken.
 * @param {{force?:boolean}} opts force=true überspringt den Tages-Lock (Cron).
 * @returns {Promise<{ran:boolean, scanned:number, eligible:number, sent:number}>}
 */
async function run(opts) {
  opts = opts || {};
  if (!Push.hasPush || !hasStore) return { ran: false, scanned: 0, eligible: 0, sent: 0 };

  // Tages-Lock gegen Doppelläufe (force darf ihn überspringen).
  if (!opts.force) {
    var got = await acquireLock();
    if (!got) return { ran: false, scanned: 0, eligible: 0, sent: 0 };
  }

  var members = await Push.allPushMembers();
  var scanned = 0, eligible = 0, sent = 0;

  // Begrenzte Nebenläufigkeit (Slices ~5), damit Magicline nicht überrannt wird.
  for (var i = 0; i < members.length; i += CONCURRENCY) {
    var slice = members.slice(i, i + CONCURRENCY);
    var results = await Promise.all(slice.map(function (id) { return processMember(id); }));
    results.forEach(function (r) {
      scanned++;
      if (r && r.eligible) eligible++;
      if (r && r.sent) sent++;
    });
  }

  return { ran: true, scanned: scanned, eligible: eligible, sent: sent };
}

module.exports = { run };
