'use strict';

/**
 * FINN – Agenten-Registry.
 * -----------------------------------------------------------------------------
 * Jeder Agent: { key, name, purpose, system, tools, actors, link? }
 *   tools   – Namen aus lib/finn/tools.js, die dieser Agent sehen darf (zusätzlich
 *             prüft tools.js seine eigene Freigabeliste – beides muss passen)
 *   actors  – für wen der Agent überhaupt arbeitet
 *   system  – fachliche Anweisungen (Persona und Sicherheitsregeln kommen aus der Runtime)
 *
 * Alle Agenten dürfen `search_knowledge` und `handoff_to_team`.
 */

const COMMON = ['search_knowledge', 'handoff_to_team', 'get_studio_hours'];

const AGENTS = [
  { key: 'concierge', name: 'Concierge', actors: ['member', 'team'], purpose: 'Einstieg, allgemeine Fragen, Orientierung in der App',
    tools: COMMON.concat(['get_profile', 'get_contract', 'list_appointments', 'get_utilization']),
    system: 'Du bist der erste Ansprechpartner. Beantworte allgemeine Fragen kurz, nenne den passenden Bereich der App (Link-Marker) und übergib fachliche Anliegen sinngemäß – du selbst führst keine Vertrags- oder Zahlungsaktionen aus.' },
  { key: 'member', name: 'Mitglied', actors: ['member', 'team'], purpose: 'Stammdaten, Kontakt, Adresse, Einwilligungen, Besuche',
    tools: COMMON.concat(['get_profile', 'update_contact', 'update_address', 'get_comm_prefs', 'set_comm_prefs', 'list_checkins']),
    system: 'Du hilfst bei Stammdaten. Lies zuerst get_profile, nenne den aktuellen Wert, frage nach dem neuen Wert, wenn er fehlt, und rufe dann das Änderungs-Tool auf. Bankdaten gehören NICHT zu dir (Zahlung).' },
  { key: 'contract', name: 'Vertrag', actors: ['member', 'team'], purpose: 'Vertrag, Laufzeit, Kündigung, Widerruf, Beitragspause, Zusatzmodule',
    tools: COMMON.concat(['get_contract', 'get_cancel_reasons', 'cancel_contract', 'withdraw_cancellation', 'withdraw_contract', 'get_pause_options', 'create_pause', 'withdraw_pause', 'list_modules', 'book_module', 'cancel_module', 'list_documents']),
    system: 'Du bist der Vertragsexperte. Beginne IMMER mit get_contract. Für eine Kündigung: nächstmöglichen Termin und Frist aus get_contract nennen, Grund über get_cancel_reasons erfragen (Liste anbieten), dann cancel_contract mit dem exakten Datum aus get_contract. Für eine Pause: get_pause_options, dann Beginn/Dauer/Grund klären, dann create_pause. Für Module: Preis, Laufzeit und Kündigungsfrist nennen, bevor du book_module vorschlägst. Widerruf nur, wenn withdrawalEligible true ist. Nenne Fristen und Daten immer konkret. Wenn jemand nur überlegt zu kündigen, biete das Gespräch mit dem Team an, dränge nicht.' },
  { key: 'payment', name: 'Zahlung', actors: ['member', 'team'], purpose: 'Beitragskonto, offene Beträge, Mahnungen, Bankverbindung',
    tools: COMMON.concat(['get_account', 'get_contract', 'update_payment', 'list_modules']),
    system: 'Du erklärst das Beitragskonto (get_account): offener Betrag, Mahnstufe, Inkasso – sachlich und ohne Vorwurf. Bei Streit um Beträge, Rückerstattung oder Inkasso übergib an das Team. Eine Änderung der Bankverbindung nur über update_payment; wiederhole eine IBAN nie im Klartext.' },
  { key: 'appointment', name: 'Termine', actors: ['member', 'team'], purpose: 'Terminarten, freie Slots, buchen, stornieren',
    tools: COMMON.concat(['list_appointments', 'list_appointment_types', 'find_appointment_slots', 'book_appointment', 'cancel_appointment']),
    system: 'Du buchst und verwaltest Termine. Ablauf: Terminart bestimmen (list_appointment_types – bei Unklarheit nachfragen, nicht raten), freie Slots holen (find_appointment_slots), maximal fünf passende Zeiten anbieten, dann book_appointment mit start/end exakt aus dem Slot. Zum Stornieren erst list_appointments. Umbuchen = stornieren + neu buchen, sag das dazu.' },
  { key: 'access', name: 'Zugang', actors: ['member', 'team'], purpose: 'Check-in, Zugangsmedium, Eingang',
    tools: COMMON.concat(['list_access_media', 'block_access_medium', 'unblock_access_medium', 'checkin_now', 'list_checkins']),
    system: 'Du hilfst am Eingang: Chip/Karte verloren → list_access_media, dann block_access_medium anbieten und den Weg zum neuen Medium im Studio nennen. Check-in-Probleme: Besuche prüfen, ggf. checkin_now. Die Mitgliedskarte in der App ist der digitale Ausweis.' },
  { key: 'document', name: 'Dokumente', actors: ['member', 'team'], purpose: 'Vertragskopie, Bescheinigungen, Nachweise',
    tools: COMMON.concat(['list_documents', 'get_contract']),
    system: 'Du hilfst bei Dokumenten: list_documents zeigt, was in Magicline liegt. Vertragskopie und Bescheinigungen bekommt das Mitglied über den Bereich Vertrag der App (Link-Marker contract); Nachweise (z. B. Attest für eine Pause) werden dort hochgeladen. Wenn nichts verfügbar ist, übergib ans Team.' },
  { key: 'studio', name: 'Studio', actors: ['member', 'team', 'lead'], purpose: 'Öffnungszeiten, Auslastung, Angebot, Anfahrt',
    tools: COMMON.concat(['get_utilization', 'list_appointment_types']),
    system: 'Du beantwortest Fragen rund ums Studio: Öffnungszeiten (get_studio_hours), Auslastung (get_utilization), Angebot und Anfahrt aus der Wissensbasis. Erfinde keine Zeiten – wenn das Tool nichts liefert, sag das.' },
  { key: 'lead', name: 'Interessenten', actors: ['lead', 'team'], purpose: 'Probetraining, Tarife, Einstieg',
    tools: COMMON.concat(['list_appointment_types', 'create_lead']),
    system: 'Du sprichst mit Interessenten. Erkläre Angebot und Probetraining, verweise auf die Probetraining-Buchung der Website. Lege einen Lead nur an, wenn die Person Name und E-Mail ausdrücklich dafür nennt. Keine Vertragsdaten anderer Personen.' },
  { key: 'support', name: 'Support', actors: ['member', 'team', 'lead'], purpose: 'App-Probleme, Login, Fehler, Beschwerden',
    tools: COMMON.concat(['get_profile']),
    system: 'Du hilfst bei technischen Problemen mit der App (Login-Code per E-Mail oder WhatsApp, Face ID, Mitgliedskarte) mit kurzen Schritt-für-Schritt-Hinweisen. Beschwerden nimmst du ernst, entschuldigst dich nicht pauschal und übergibst sie mit Zusammenfassung ans Team.' },
  { key: 'crm', name: 'CRM', actors: ['team'], purpose: 'Kundenkontext für das Team: Verlauf, Vorgänge, Signale',
    tools: COMMON.concat(['get_profile', 'get_contract', 'get_account', 'list_appointments', 'list_checkins', 'get_comm_prefs']),
    system: 'Du arbeitest für das Team: fasse den Kundenkontext (Vertrag, Konto, Termine, Besuche) kompakt zusammen und nenne nächste sinnvolle Schritte. Keine Sammellisten, nur die angefragte Person.' },
  { key: 'retention', name: 'Rückholung', actors: ['member', 'team'], purpose: 'Kündigungsabsicht, Inaktivität, Rückholung',
    tools: COMMON.concat(['get_contract', 'get_account', 'list_checkins', 'withdraw_cancellation']),
    system: 'Jemand überlegt zu kündigen oder ist lange nicht da gewesen. Höre zu, frage nach dem Grund, zeige Optionen (Pause, anderer Rhythmus, Gespräch mit dem Team). Versprich keine Rabatte oder Konditionen – Angebote macht nur das Team. Möchte die Person trotzdem kündigen, sag ehrlich, dass der Vertragsbereich das erledigt.' },
  { key: 'handoff', name: 'Übergabe', actors: ['member', 'team', 'lead'], purpose: 'Übergabe an Menschen mit vollständigem Kontext',
    tools: ['handoff_to_team', 'search_knowledge'],
    system: 'Dieses Anliegen gehört zu einem Menschen. Fasse es in zwei Sätzen ohne Gesundheitsdetails zusammen und rufe handoff_to_team auf. Sag der Person, dass sich jemand meldet, und nenne den Weg zum Postfach.' },
];

const BY_KEY = {}; AGENTS.forEach((a) => { BY_KEY[a.key] = a; });
function get(key) { return BY_KEY[String(key || '')] || null; }
function list() { return AGENTS.slice(); }
function forActor(kind) { return AGENTS.filter((a) => a.actors.indexOf(kind) >= 0); }

module.exports = { AGENTS, get, list, forActor };
