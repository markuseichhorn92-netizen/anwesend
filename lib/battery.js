'use strict';

/**
 * Vital-Akku (energie-/erholungsbasierter Tages-„Akku", 0–100 %).
 * ---------------------------------------------------------------
 * Ein modellierter Energiewert im Stil einer „Body Battery" – aber aus den
 * Signalen, die die App wirklich hat (kein kontinuierliches Intraday-HR):
 *
 *   Ladung (Decke) = Erholung (HRV/Ruhepuls vs. Baseline) veredelt mit Schlaf
 *   Entladung       = jüngste Trainingslast (TRIMP, aktualitäts-gewichtet)
 *                     + kumulative Wochenlast + Übertrainings-/Regenerations-Signale
 *
 * Bewusst KEINE minütliche Kurve (die Datengrundlage fehlt) – der Wert aktualisiert
 * sich beim App-Öffnen / Daten-Sync. Wellness-Signal, kein Medizinprodukt.
 *
 * `compute` ist eine reine Funktion (keine Store-/IO-Abhängigkeit) und damit testbar.
 */

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Tages-Ladung aus Erholung (+ optional Schlaf): dieselbe Mischung wie in compute(),
// separat exportiert für die 7-Tage-Mini-Kurve. null, wenn kein Erholungs-Score da ist.
function dayCharge(readinessScore, sleepScore) {
  if (readinessScore == null) return null;
  const r = clamp(Math.round(readinessScore), 0, 100);
  if (sleepScore == null) return r;
  return Math.round(0.65 * r + 0.35 * clamp(Math.round(sleepScore), 0, 100));
}

/**
 * @param {object} inp
 *   readiness:      { score:0-100|null, level? }  – bester Erholungs-Score (Morgen-Check ODER passiv)
 *   sleepDetail:    { score:0-100 } | null        – Oura-artiger Schlaf-Score (optional)
 *   weekLoad:       { trimp, minutes, sessions, lastTs, lastLoad } | null  – 7-Tage-Trainingslast
 *   recoveryActive: boolean                        – aktiver Regenerations-/Pausenmodus
 *   overtraining:   { level:'ok'|'warn'|'alert' } | null
 *   source:         'morgen'|'passiv'|null         – Herkunft des Erholungs-Scores
 *   now:            number (ms)                     – für Aktualität der letzten Einheit
 * @returns {{ hasData, level, tone, label, headline, charge, drain, factors, source }}
 */
function compute(inp) {
  inp = inp || {};
  const readiness = inp.readiness || null;
  const now = (typeof inp.now === 'number') ? inp.now : Date.now();

  // Ohne echten Erholungs-Score kein Akku (nur mit HRV/Health-Daten, per Nutzerwunsch).
  if (!readiness || readiness.score == null) {
    return { hasData: false, level: null, tone: null, label: '', headline: '', charge: null, drain: null, factors: [], source: null };
  }

  const r = clamp(Math.round(readiness.score), 0, 100);
  const sleep = (inp.sleepDetail && inp.sleepDetail.score != null) ? clamp(Math.round(inp.sleepDetail.score), 0, 100) : null;
  const weekLoad = inp.weekLoad || null;
  const overtraining = inp.overtraining || null;
  const recoveryActive = !!inp.recoveryActive;

  const factors = [];

  // ── Ladung: Erholung veredelt mit Schlaf ─────────────────────────────────
  const charge = dayCharge(r, sleep);
  if (r >= 70) factors.push({ label: 'Erholung stark', dir: '+' });
  else if (r < 50) factors.push({ label: 'Erholung schwach', dir: '-' });
  if (sleep != null) {
    if (sleep >= 75) factors.push({ label: 'Schlaf gut', dir: '+' });
    else if (sleep < 55) factors.push({ label: 'Schlaf kurz', dir: '-' });
  }

  // ── Entladung: Trainingslast ─────────────────────────────────────────────
  let drain = 0;
  if (weekLoad && weekLoad.lastLoad > 0 && weekLoad.lastTs) {
    const hoursSince = (now - weekLoad.lastTs) / 3.6e6;
    // Frische Einheit entlädt stark, erholt sich über ~48 h.
    const recency = hoursSince <= 6 ? 1 : hoursSince <= 24 ? 0.6 : hoursSince <= 48 ? 0.3 : 0.1;
    // TRIMP ~50 = moderat, ~120 = hart -> bis zu 30 Punkte Entladung.
    const loadDrain = clamp(weekLoad.lastLoad / 4, 0, 30) * recency;
    drain += loadDrain;
    if (loadDrain >= 8) {
      const when = hoursSince <= 24 ? 'heute' : (hoursSince <= 48 ? 'gestern' : 'zuletzt');
      factors.push({ label: 'Training ' + when, dir: '-' });
    }
  }
  // Kumulative Wochenlast (Ermüdung über die Woche).
  if (weekLoad && weekLoad.trimp > 300) {
    drain += clamp((weekLoad.trimp - 300) / 40, 0, 12);
    factors.push({ label: 'Wochenlast hoch', dir: '-' });
  }
  // Übertraining / aktiver Regenerationsmodus senken den Akku deutlich.
  if (overtraining && overtraining.level === 'alert') { drain += 20; factors.push({ label: 'Übertraining', dir: '-' }); }
  else if (overtraining && overtraining.level === 'warn') { drain += 10; }
  if (recoveryActive) { drain += 15; factors.push({ label: 'Regenerationsmodus', dir: '-' }); }

  const level = clamp(Math.round(charge - drain), 5, 100);
  const tone = level >= 66 ? 'gruen' : level >= 40 ? 'gelb' : 'rot';
  const label = level >= 80 ? 'Voll geladen' : level >= 60 ? 'Gut geladen' : level >= 40 ? 'Solide' : level >= 25 ? 'Halb leer' : 'Reserve';
  const headline = tone === 'gruen'
    ? 'Dein Akku ist gut geladen – idealer Tag für ein forderndes Training.'
    : tone === 'gelb'
      ? 'Solide Energie – trainiere moderat und gib deinem Körper heute genug Erholung.'
      : 'Reserve niedrig – heute lieber locker, Fokus auf Schlaf und Erholung.';

  return {
    hasData: true,
    level: level,
    tone: tone,
    label: label,
    headline: headline,
    charge: Math.round(charge),
    drain: Math.round(drain),
    factors: factors.slice(0, 3),
    source: inp.source || null,
  };
}

module.exports = { compute, dayCharge };
