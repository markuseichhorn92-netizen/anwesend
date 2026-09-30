'use strict';

/**
 * Einmalige Inhalts-Migrationen für die Hilfe-Artikel (Team-Backend → FINN, App).
 * -----------------------------------------------------------------------------
 * Für Artikel, die ohne Team-Login angelegt werden müssen (z. B. eine Aktion zum
 * Monatsstart). Jede Migration läuft genau einmal (Marke `art:mig:<key>`, SET NX) und legt
 * den Artikel nur an, wenn es noch keinen mit gleichem Titel gibt. Danach ist er ein ganz
 * normaler Artikel: das Team kann ihn im Backend bearbeiten, auf „Entwurf" setzen oder
 * löschen – die Marke verhindert, dass er wieder auftaucht.
 *
 * Ausgelöst von Articles.list() (einmal je Instanz, danach gemerkt).
 */

const MIGRATIONS = [
  {
    key: 'okt26',
    // Ablauf: kein Ablaufdatum im Backend – Erinnerung am 01.11.2026 im Kalender des Betreibers,
    // den Artikel auf „Entwurf" zu setzen.
    article: {
      title: 'Oktober-Aktion 2026: 12 Wochen für je 5 €',
      cat: 'mitglied',
      status: 'veröffentlicht',
      body: [
        'Als Neumitglied zahlst du in den ersten 12 Wochen je 5 € pro Woche.',
        'Danach gilt der reguläre Wochenbeitrag: Basic 12 € pro Woche bei 52 Wochen Laufzeit, Premium 9 € pro Woche bei 104 Wochen Laufzeit.',
        'Die 12 Vorteilswochen sind Teil der Laufzeit und verlängern sie nicht.',
        'Gesamtbetrag: 540 € über 52 Wochen bzw. 888 € über 104 Wochen, zzgl. einmalig 39 € Aufnahmegebühr. Alle Preise inkl. MwSt.',
        'Der Einzug erfolgt alle 14 Tage per SEPA-Lastschrift.',
        'Gültig für Neuabschlüsse bis 31.10.2026, nur für Neumitglieder, ab 18 Jahren, nicht mit anderen Aktionen oder Rabatten kombinierbar, nicht auf bestehende Verträge übertragbar.',
        'Nach der Erstlaufzeit läuft dein Vertrag unbefristet weiter und ist mit einem Monat Frist kündbar; zum Ende der Erstlaufzeit mit 4 Wochen Frist.',
        'Der Flex-Tarif (4 Wochen, 15 € pro Woche) ist nicht Teil der Aktion.',
        'In jeder Mitgliedschaft enthalten: komplette Clubnutzung, Gesundheits-Check-up mit Körperanalyse, Einweisung an jedem Gerät, Trainingspläne, TechnoGym App, Cardio-Entertainment, Mineralgetränke, WLAN, Duschen, Umkleiden.',
        'Abschluss der Aktion: vor Ort im Studio, am besten nach einem kostenlosen, unverbindlichen Probetraining (rund 90 Minuten, mit oder ohne Trainer).',
        'Es gelten die AGB (fit-inn-trier.de/agbs-fit-inn-trier) und die Hausordnung.',
      ].join('\n\n'),
    },
  },
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
      const all = await Articles.listRaw();
      const title = m.article.title.trim().toLowerCase();
      if (!all.some((a) => String(a.title || '').trim().toLowerCase() === title)) {
        await Articles.save(Object.assign({}, m.article));
        applied.push(m.key);
      }
    } catch (e) {
      try { await redisPipeline([['DEL', FLAG(m.key)]]); } catch (x) {}   // beim nächsten Mal erneut versuchen
      return { applied: applied };
    }
  }
  done = true;
  return { applied: applied };
}

function _reset() { done = false; }

module.exports = { run, MIGRATIONS, _reset };
