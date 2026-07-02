'use strict';

/**
 * Churn-Radar – deterministischer Risiko-Score fürs Team-Backend.
 * ---------------------------------------------------------------
 * Bündelt vorhandene Signale (Zahlstatus, Vertrag, offene Kündigungs-Vorgänge,
 * Trainings-Inaktivität) zu einem nachvollziehbaren Risiko-Wert (0..100) mit
 * kurzen deutschen Gründen. So kann das Team gefährdete (kündigungs-/
 * abwanderungsnahe) Mitglieder erkennen und proaktiv gegensteuern.
 *
 * Grundsätze:
 *  - Deterministisch: kein Date.now()/Random im Score selbst (die Rohsignale
 *    liefern die Zeitbasis, siehe M.daysSinceLastCheckin).
 *  - Graceful Degradation: Jeder Magicline-/Store-Zugriff ist 403-/fehlersicher
 *    gekapselt. Fehlt ein Signal, wird es einfach weggelassen – nie geworfen.
 *  - Keine Roh-/Personendaten (IBAN o. Ä.): nur aggregierter Score + Gründe.
 */

const M = require('./members');
const MLAccount = require('./mlAccount');
const Inbox = require('./inbox');
const View = require('./teamView');

// Reiner, deterministischer Score aus den bereits gesammelten Signalen.
// Erwartet: { account, contract, vorgaenge, daysSince }. Fehlende/nicht
// verfügbare Signale werden ausgelassen (nur addieren, wenn vorhanden).
function scoreSignals(sig) {
  sig = sig || {};
  var account = sig.account || null;
  var contract = sig.contract || null;
  var vorgaenge = Array.isArray(sig.vorgaenge) ? sig.vorgaenge : [];
  var daysSince = (typeof sig.daysSince === 'number' && Number.isFinite(sig.daysSince)) ? sig.daysSince : null;

  var score = 0;
  var reasons = [];

  // ── Zahlstatus (nur wenn Beitragskonto lesbar; sonst { available:false }) ──
  if (account && account.available) {
    if (account.inDebtCollection) { score += 40; reasons.push('In Inkasso'); }
    var dl = parseInt(account.dunningLevel, 10);
    if (Number.isFinite(dl) && dl > 0) { score += Math.min(dl * 12, 30); reasons.push('Mahnstufe ' + dl); }
    var oc = parseInt(account.openCount, 10);
    if (Number.isFinite(oc) && oc > 0) { score += 8; reasons.push(oc + ' offene Beträge'); }
  }

  // ── Vertrag: aktive Kündigung ──
  if (contract && contract.cancelled) {
    score += 35;
    reasons.push('Hat gekündigt' + (contract.cancellationDate ? (' zum ' + contract.cancellationDate) : ''));
  }

  // ── Offener Kündigungs-/Widerruf-Vorgang im Postfach ──
  var hasOpenCancel = false;
  for (var i = 0; i < vorgaenge.length; i++) {
    var v = vorgaenge[i]; if (!v) continue;
    var ty = String(v.type || '');
    if ((ty === 'kuendigung' || ty === 'widerruf') && v.teamStatus !== 'abgeschlossen') { hasOpenCancel = true; break; }
  }
  if (hasOpenCancel) { score += 18; reasons.push('Offener Kündigungs-Vorgang'); }

  // ── Trainings-Inaktivität (Tage seit letztem Check-in) ──
  // null = kein verlässliches Signal (kein Check-in bekannt) -> nichts addieren.
  if (daysSince !== null) {
    if (daysSince >= 28) { score += 28; reasons.push('Seit ' + daysSince + ' Tagen nicht da'); }
    else if (daysSince >= 21) { score += 20; reasons.push('Seit ' + daysSince + ' Tagen nicht da'); }
    else if (daysSince >= 14) { score += 12; reasons.push('Seit ' + daysSince + ' Tagen nicht da'); }
    else if (daysSince >= 10) { score += 6; reasons.push('Seit ' + daysSince + ' Tagen nicht da'); }
  }

  if (score > 100) score = 100;
  if (score < 0) score = 0;
  var level = score >= 50 ? 'hoch' : (score >= 25 ? 'mittel' : 'niedrig');
  return { score: score, level: level, reasons: reasons };
}

// Sammelt alle Signale eines Mitglieds 403-/fehlersicher, bewertet sie und
// liefert einen kompakten Eintrag. Wirft NIE – im Fehlerfall score 0/'niedrig'.
// opts: { name?, nr?, initials?, vorgaenge? }  (Snapshot-Daten aus der Inbox,
//        um Doppel-Reads zu sparen).
async function assess(id, opts) {
  opts = opts || {};
  var sid = String(id);
  try {
    var contract = null;
    var account = { available: false };
    var daysSince = null;
    var vorgaenge = null;

    try { contract = await M.getContract(sid); } catch (e) { contract = null; }
    try { account = await MLAccount.accountSummary(sid); } catch (e) { account = { available: false }; }
    try { daysSince = await M.daysSinceLastCheckin(sid, { pages: 1 }); } catch (e) { daysSince = null; }

    // Vorgänge bevorzugt aus opts (schon geladen), sonst gezielt nachladen.
    if (Array.isArray(opts.vorgaenge)) {
      vorgaenge = opts.vorgaenge;
    } else {
      try { vorgaenge = await Inbox.list(sid); } catch (e) { vorgaenge = []; }
    }

    // Name/Nr/Initialen möglichst aus dem Snapshot; sonst gezielt nachladen.
    var name = opts.name || null;
    var nr = (opts.nr != null) ? opts.nr : null;
    var initials = opts.initials || null;
    if (!name) {
      try {
        var m = await M.getMember(sid);
        var p = M.publicProfile(m) || {};
        var full = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
        if (full) name = full;
        if (nr == null) nr = p.customerNumber || null;
      } catch (e) {}
    }
    if (!name) name = 'Mitglied ' + sid;
    if (!initials) { try { initials = View.initials(name); } catch (e) { initials = 'M'; } }

    var scored = scoreSignals({ account: account, contract: contract, vorgaenge: vorgaenge, daysSince: daysSince });

    return {
      id: sid, name: name, nr: nr, initials: initials,
      score: scored.score, level: scored.level, reasons: scored.reasons,
      lastVisitDays: daysSince,
    };
  } catch (e) {
    return {
      id: sid, name: opts.name || ('Mitglied ' + sid), nr: (opts.nr != null) ? opts.nr : null,
      initials: opts.initials || 'M', score: 0, level: 'niedrig', reasons: [], lastVisitDays: null,
    };
  }
}

module.exports = { scoreSignals, assess };
