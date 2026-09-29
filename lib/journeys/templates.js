'use strict';

/**
 * FINN Journeys – Vorlagen-Registry.
 * -----------------------------------------------------------------------------
 * Jede Nachricht, die WIR anstoßen, braucht außerhalb des 24-h-Fensters eine
 * von Meta freigegebene Vorlage. Hier steht der Text genau so, wie er in Twilio
 * (Content Template Builder) bzw. im Meta Business Manager anzulegen ist –
 * {{1}}, {{2}} … sind die Variablen. Innerhalb des Fensters senden wir denselben
 * Text als normale Nachricht (kostenlos, mit Knöpfen, wenn möglich).
 *
 *   category  UTILITY | MARKETING  – wie bei Meta einzureichen (Meta entscheidet endgültig)
 *   consent   service | marketing | invite – welche Einwilligung der Versand braucht
 *
 * Die Zuordnung Schlüssel -> Content-SID (HX…) bzw. Meta-Vorlagenname pflegt das
 * Team im Team-Backend (jr:cfg.templates). Ohne Zuordnung und bei geschlossenem
 * Fenster wird der Schritt übersprungen („no_template") – nie Freitext riskiert.
 */

const BASE = (process.env.PUBLIC_BASE_URL || 'https://mitglieder.fit-inn-trier.de').replace(/\/+$/, '');
const JOIN_URL = process.env.JOURNEYS_JOIN_URL || (BASE + '/mitglied-werden');
const ADDRESS = 'Auf Hirtenberg 8, 54296 Trier';

const T = {
  // ── Leads & Probetraining ──
  fi_lead_followup: { category: 'MARKETING', consent: 'marketing', journey: 'lead',
    text: 'Hi {{1}}, hier ist nochmal Fit-Inn Trier. Hast du noch Lust auf ein kostenloses Probetraining? Sag mir einfach, wann es dir passt – morgens, mittags oder abends – und ich schlage dir freie Termine vor.',
    buttons: ['Termin finden', 'Später'], vars: ['Vorname'] },
  fi_lead_last: { category: 'MARKETING', consent: 'marketing', journey: 'lead',
    text: 'Hi {{1}}, ich melde mich ein letztes Mal: Falls du doch noch vorbeischauen möchtest, schreib mir einfach – ich finde einen passenden Termin für dich. Alles Gute! 🙂',
    buttons: [], vars: ['Vorname'] },
  fi_trial_24h: { category: 'UTILITY', consent: 'service', journey: 'lead',
    text: 'Hi {{1}}, morgen ist es so weit: Dein Probetraining bei Fit-Inn Trier ist am {{2}} um {{3}} Uhr. Bring bequeme Sportsachen, saubere Hallenschuhe und ein Handtuch mit. Wir freuen uns auf dich! 💪',
    buttons: ['Ich komme', 'Verschieben'], vars: ['Vorname', 'Datum', 'Uhrzeit'] },
  fi_trial_2h: { category: 'UTILITY', consent: 'service', journey: 'lead',
    text: 'Hi {{1}}, gleich geht\'s los: Dein Probetraining startet heute um {{2}} Uhr. Adresse: ' + ADDRESS + '. Bis gleich! 👋',
    buttons: [], vars: ['Vorname', 'Uhrzeit'] },
  fi_trial_after: { category: 'MARKETING', consent: 'marketing', journey: 'lead',
    text: 'Hi {{1}}, wie war dein Probetraining bei uns? Falls es heute nicht geklappt hat, suchen wir dir gern einen neuen Termin.',
    buttons: ['War super 💪', 'Neuer Termin', 'Ich habe Fragen'], vars: ['Vorname'] },
  fi_trial_offer: { category: 'MARKETING', consent: 'marketing', journey: 'lead',
    text: 'Hi {{1}}, schön, dass du bei uns reingeschnuppert hast! Wenn du weitermachen möchtest: Hier findest du alle Tarife und kannst direkt online starten: {{2}} – oder schreib mir einfach deine Fragen.',
    buttons: [], vars: ['Vorname', 'Link Tarife'] },

  // ── Onboarding ──
  fi_onb_welcome: { category: 'UTILITY', consent: 'service', journey: 'onboarding',
    text: 'Willkommen bei Fit-Inn Trier, {{1}}! 🎉 Für einen guten Start empfehlen wir dir das kostenlose Einführungstraining: Ein Trainer zeigt dir die Geräte und stellt dir dein erstes Programm zusammen. Soll ich dir freie Termine zeigen?',
    buttons: ['Termine zeigen', 'Später'], vars: ['Vorname'] },
  fi_onb_induction: { category: 'UTILITY', consent: 'service', journey: 'onboarding',
    text: 'Hi {{1}}, hast du schon einen Termin für dein Einführungstraining? Damit startest du sicher und mit Plan. Ich zeige dir gern freie Termine.',
    buttons: ['Termine zeigen', 'Mache ich später'], vars: ['Vorname'] },
  fi_first_visit: { category: 'MARKETING', consent: 'marketing', journey: 'onboarding',
    text: 'Stark, {{1}} – dein erstes Training bei uns ist geschafft! 💪 Der Anfang ist das Schwerste. Tipp: Trag dir deinen nächsten Trainingstag gleich fest in den Kalender.',
    buttons: [], vars: ['Vorname'] },
  fi_week_good: { category: 'MARKETING', consent: 'marketing', journey: 'onboarding',
    text: 'Hi {{1}}, du warst in deinen ersten Wochen schon {{2}}-mal bei uns – richtig gut! Bleib dran, genau so entstehen Gewohnheiten. 💪',
    buttons: [], vars: ['Vorname', 'Besuche'] },
  fi_week_nudge: { category: 'MARKETING', consent: 'marketing', journey: 'onboarding',
    text: 'Hi {{1}}, aller Anfang ist schwer – du warst bisher {{2}}-mal da. Wie wäre es mit zwei festen Trainingstagen pro Woche? Wenn du Hilfe beim Plan brauchst, buche dir gern einen Termin mit einem Trainer.',
    buttons: ['Trainer-Termin', 'Alles gut'], vars: ['Vorname', 'Besuche'] },
  fi_checkin_q: { category: 'MARKETING', consent: 'marketing', journey: 'onboarding',
    text: 'Hi {{1}}, du bist jetzt seit {{2}} Tagen bei Fit-Inn dabei! Wie läuft\'s bei dir?',
    buttons: ['Läuft super', 'Könnte besser', 'Trainer-Termin'], vars: ['Vorname', 'Tage'] },

  // ── Bindung ──
  fi_habit_below: { category: 'MARKETING', consent: 'marketing', journey: 'habit',
    text: 'Hi {{1}}, in den letzten vier Wochen warst du {{2}}-mal bei uns – dein Ziel sind {{3}} Besuche pro Woche. Kleiner Tipp: Leg dir einen festen Trainingstag in den Kalender. Brauchst du einen neuen Plan?',
    buttons: ['Trainer-Termin', 'Alles gut'], vars: ['Vorname', 'Besuche 4 Wochen', 'Wochenziel'] },
  fi_milestone: { category: 'MARKETING', consent: 'marketing', journey: 'habit',
    text: 'Glückwunsch, {{1}}! 🎉 Das war dein {{2}}. Besuch bei Fit-Inn Trier. Stark, dass du dranbleibst!',
    buttons: [], vars: ['Vorname', 'Anzahl'] },
  fi_streak: { category: 'MARKETING', consent: 'marketing', journey: 'habit',
    text: '{{1}}, du trainierst jetzt seit {{2}} Wochen jede Woche bei uns! 🔥 Weiter so!',
    buttons: [], vars: ['Vorname', 'Wochen'] },
  fi_comeback_1: { category: 'MARKETING', consent: 'marketing', journey: 'comeback',
    text: 'Hi {{1}}, wir haben dich eine Weile nicht gesehen – alles okay bei dir? Wenn du wieder einsteigen möchtest, helfen wir dir gern mit einem neuen Plan.',
    buttons: ['Bin bald wieder da', 'Trainer-Termin', 'Brauche eine Pause'], vars: ['Vorname'] },
  fi_comeback_2: { category: 'MARKETING', consent: 'marketing', journey: 'comeback',
    text: 'Hi {{1}}, dein letzter Besuch ist schon eine Weile her. Sollen wir dir einen kurzen Termin mit einem Trainer einrichten? 20 Minuten reichen, um wieder reinzukommen.',
    buttons: ['Ja, gern', 'Nein, danke'], vars: ['Vorname'] },

  // ── Einladung (fragt die Einwilligung ab) ──
  fi_invite: { category: 'MARKETING', consent: 'invite', journey: 'invite',
    text: 'Hi {{1}}, hier ist Fit-Inn Trier! Du erreichst uns ab sofort auch per WhatsApp – für Fragen, Termine und Erinnerungen. Möchtest du hier außerdem ab und zu Motivation und Tipps zu deinem Training bekommen? Höchstens zwei Nachrichten pro Woche, Abmeldung jederzeit mit STOP.',
    buttons: ['Ja, gern', 'Nein, danke'], vars: ['Vorname'] },
};

function get(key) { return T[String(key || '')] || null; }
function keys() { return Object.keys(T); }

// {{n}} ersetzen. vars: { 1:'Mara', 2:'…' } oder Array.
function render(key, vars) {
  const t = get(key); if (!t) return '';
  const v = Array.isArray(vars) ? vars.reduce((o, x, i) => { o[i + 1] = x; return o; }, {}) : (vars || {});
  return t.text.replace(/\{\{(\d+)\}\}/g, (m, n) => (v[n] != null && String(v[n]).trim() !== '' ? String(v[n]) : ''))
    .replace(/\s+([,!.?])/g, '$1').replace(/Hi\s*,/g, 'Hi,').replace(/\s{2,}/g, ' ').trim();
}

// Variablen für Twilio: nie leer (Twilio lehnt leere Variablen ab) – Ersatzwert „du".
function twilioVars(key, vars) {
  const t = get(key); if (!t) return {};
  const v = Array.isArray(vars) ? vars.reduce((o, x, i) => { o[i + 1] = x; return o; }, {}) : (vars || {});
  const out = {};
  (t.vars || []).forEach((name, i) => { const val = v[i + 1]; out[String(i + 1)] = (val != null && String(val).trim() !== '') ? String(val).slice(0, 300) : (i === 0 ? 'du' : '–'); });
  return out;
}

// Admin-Ansicht: Text, Kategorie, Knöpfe + ob eine Zuordnung existiert.
function catalog(cfgTemplates) {
  cfgTemplates = cfgTemplates || {};
  return keys().map((k) => {
    const t = T[k]; const c = cfgTemplates[k] || {};
    return { key: k, journey: t.journey, category: t.category, consent: t.consent, text: t.text, buttons: t.buttons || [], vars: t.vars || [], sid: c.sid || null, meta: c.meta || null, ready: !!(c.sid || c.meta) };
  });
}

// Deutsche Datums-/Zeitdarstellung (Berlin).
function fmtDate(ts) { try { return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ts)); } catch (e) { return ''; } }
function fmtTime(ts) { try { return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts)); } catch (e) { return ''; } }

module.exports = { T, get, keys, render, twilioVars, catalog, fmtDate, fmtTime, JOIN_URL, ADDRESS };
