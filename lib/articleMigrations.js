'use strict';

/**
 * Einmalige Inhalts-Migrationen für die Hilfe-Artikel (Team-Backend → FINN, App).
 * -----------------------------------------------------------------------------
 * Für Artikel, die ohne Team-Login angelegt oder geändert werden müssen (z. B. eine Aktion).
 * Jede Migration läuft genau einmal (Marke `art:mig:<key>`, SET NX). Danach sind die Artikel
 * ganz normale Artikel: das Team kann sie im Backend bearbeiten, auf „Entwurf" setzen oder
 * löschen – die Marke verhindert, dass etwas wieder auftaucht.
 *
 * Ausgelöst von Articles.list() (einmal je Instanz, danach gemerkt).
 *
 * Verlauf:
 *   okt26     (30.09.2026) „Oktober-Aktion 2026: 12 Wochen für je 5 €" – ersetzt durch herbst26
 *   herbst26  (30.09.2026) Aktion „5 € pro Woche bis Silvester" + neue Telefonnummer
 */

const PHONE_NEW = '0651 493 688 19';
const PHONE_OLD = /(?:\+49[\s-]?|0)651[\s/-]*308\s?524/g;
const LANDING = 'fit-inn-trier-dark-landing.onepage.me/5-euro-woche';
const OLD_LANDING = /(?:https?:\/\/)?angebot\.fit-inn-trier\.de[^\s)]*/g;

const HERBST_TITLE = 'Aktion „5 € pro Woche bis Silvester" (Herbst 2026)';
const OKT_TITLE = 'Oktober-Aktion 2026: 12 Wochen für je 5 €';

const HERBST_BODY = [
  'Das Angebot',
  '- Als Neumitglied zahlst du ab deinem Vertragsbeginn bis einschließlich 31.12.2026 nur 5 € pro Woche – in beiden Tarifen.\n'
    + '- Ab Januar 2027 (01.01.2027) gilt der reguläre Wochenbeitrag: Basic 12 € pro Woche bei 52 Wochen Laufzeit, Premium 9 € pro Woche bei 104 Wochen Laufzeit.\n'
    + '- Vertragsbeginn ist der Tag des Abschlusses. Die Laufzeit beginnt mit dem Vertragsbeginn; der Aktionszeitraum zählt zur Laufzeit und verlängert sie nicht.\n'
    + '- Nur die ersten 25 Neuanmeldungen bekommen das Angebot. Frühester Start ist der 01.10.2026, spätestens bis 31.12.2026 – solange Plätze frei sind.',
  'So viel sparst du',
  'Je früher du startest, desto mehr sparst du (Basic 7 €, Premium 4 € pro Woche weniger als regulär). Faustregel Basic: jeder Tag früher = 1 € mehr Ersparnis.\n'
    + '- Start 1. Oktober: Basic 92 € gespart, Premium 53 €\n'
    + '- Start 1. November: Basic 61 €, Premium 35 €\n'
    + '- Start 1. Dezember: Basic 31 €, Premium 18 €',
  'Konditionen',
  '- Einmalige Aufnahmegebühr 39 €.\n'
    + '- Einzug alle 14 Tage per SEPA-Lastschrift. Alle Preise inkl. MwSt.\n'
    + '- Nur für Neumitglieder, ab 18 Jahren. Nicht mit anderen Aktionen oder Rabatten kombinierbar, nicht auf bestehende Verträge übertragbar.\n'
    + '- Nach der Erstlaufzeit läuft dein Vertrag unbefristet weiter und ist mit 1 Monat Frist kündbar; zum Ende der Erstlaufzeit kündigst du mit 4 Wochen Frist.\n'
    + '- Der reguläre Flex-Tarif (4 Wochen, 15 € pro Woche) ist nicht Teil der Aktion.',
  'In jeder Mitgliedschaft enthalten',
  'Komplette Clubnutzung (über 100 Geräte auf zwei Etagen), Gesundheits-Check-up mit Körperanalyse, Einweisung an jedem Gerät, individuelle Trainingspläne, TechnoGym App, Cardio-Entertainment, Mineralgetränke, WLAN, Duschen, Umkleiden.',
  'Probetraining',
  '- Kostenlos und unverbindlich, rund 90 Minuten, wahlweise mit oder ohne Trainer, ab 18 Jahren.\n'
    + '- Buchbar direkt auf der Aktionsseite (Abschnitt „Einmal vorbeikommen" oder im Chat mit FINN) oder telefonisch.',
  'Kontakt & Fragen',
  '- Telefon: ' + PHONE_NEW + '\n'
    + '- E-Mail: info@fit-inn-trier.de\n'
    + '- Aktionsseite: ' + LANDING + '\n'
    + '- Wie viele Plätze noch frei sind, zu deinem konkreten Vertragsstart und bei Sonderfällen hilft dir das Team weiter.\n'
    + '- Es gelten die AGB (fit-inn-trier.de/agbs-fit-inn-trier). Bei Vertragsfragen wende dich bitte ans Team.',
].join('\n\n');

function sameTitle(a, t) { return String((a && a.title) || '').trim().toLowerCase() === t.trim().toLowerCase(); }

// Aktion: Oktober-Artikel an Ort und Stelle ersetzen (gleiche Id), sonst neu anlegen; dann in
// allen Artikeln die alte Telefonnummer und die alte Angebotsseite ersetzen.
async function herbst26(Articles, all) {
  const art = { title: HERBST_TITLE, cat: 'mitglied', status: 'veröffentlicht', body: HERBST_BODY };
  const okt = all.find((a) => sameTitle(a, OKT_TITLE));
  let ownId = null;
  if (okt) { await Articles.save(Object.assign({ id: okt.id }, art)); ownId = okt.id; }
  else if (!all.some((a) => sameTitle(a, HERBST_TITLE))) { const n = await Articles.save(art); ownId = n && n.id; }
  for (const a of all) {
    if (a.id === ownId) continue;
    const body = String(a.body || '');
    const next = body.replace(PHONE_OLD, PHONE_NEW).replace(OLD_LANDING, LANDING);
    if (next !== body) await Articles.save({ id: a.id, body: next });
  }
}

const MIGRATIONS = [
  { key: 'herbst26', apply: herbst26 },
];

const FLAG = (k) => 'art:mig:' + k;
let done = false;

/**
 * Offene Migrationen ausführen. Articles wird übergeben (kein Zirkel-Import).
 * -> { applied:[keys] }
 */
async function run(Articles, redisPipeline) {
  if (done) return { applied: [] };
  // Erst nach der Erstbefüllung (art:seeded) – sonst hielte seedDefaults() den Store für
  // „schon befüllt" und legte die Standard-Artikel nicht an.
  let seeded = null;
  try { [seeded] = await redisPipeline([['GET', 'art:seeded']]); } catch (e) { return { applied: [] }; }
  if (!seeded) return { applied: [] };
  const applied = [];
  for (const m of MIGRATIONS) {
    let got = null;
    try { [got] = await redisPipeline([['SET', FLAG(m.key), String(Date.now()), 'NX']]); } catch (e) { return { applied: applied }; }
    if (got !== 'OK' && got !== true && got !== 1) continue;          // schon gelaufen
    try {
      await m.apply(Articles, await Articles.listRaw());
      applied.push(m.key);
    } catch (e) {
      try { await redisPipeline([['DEL', FLAG(m.key)]]); } catch (x) {}   // beim nächsten Mal erneut versuchen
      return { applied: applied };
    }
  }
  done = true;
  return { applied: applied };
}

function _reset() { done = false; }

module.exports = { run, MIGRATIONS, HERBST_TITLE, HERBST_BODY, PHONE_NEW, _reset };
