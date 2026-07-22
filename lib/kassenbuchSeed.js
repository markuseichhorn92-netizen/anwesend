'use strict';

/**
 * Kassenbuch – Altbestände 2026 (Import aus den bisherigen Excel-/Scan-Blättern).
 * ------------------------------------------------------------------------------
 * Diese Monate stammen aus den bereits an den Steuerberater übergebenen
 * Kassenbüchern (HiDrive-Archiv). Sie werden als abgeschlossene Archiv-Monate mit
 * den ERFASSTEN Summen hinterlegt (Anfangsbestand + Einnahmen − Ausgaben =
 * Endbestand), damit der laufende Monat nahtlos anschließt.
 *
 * Wichtig – bewusst NICHT „glattgezogen":
 *  - Jan/Feb (älteres Blatt-Layout) haben manuell gesetzte Anfangsbestände, die
 *    NICHT auf den Vormonat aufsetzen (Bar-Korrekturen/Einlagen). So auf dem
 *    Original-Beleg → so hinterlegt.
 *  - März→April→Mai→Juni ziehen sauber durch (Endbestand = nächster Anfang).
 *  - Der Kaffeepreis stieg zum Juni von 1,50 € auf 2,00 € (in den Summen bereits
 *    berücksichtigt; die Summen sind maßgeblich, nicht die Tagesrechnung).
 *
 * Jede Zeile ist in sich geprüft: anfang + einnahmen − ausgaben === endbestand.
 * Blatt-Nr. läuft fortlaufend (838 … 843) → der Folgemonat startet mit 844.
 */

// Aktuelle Preisliste (Stand Juni 2026) – gilt für den laufenden Monat weiter.
const SEED_PRICES = { kaffee: 2.0, eiweissshake: 2.5, eiweissbeutel: 20.5 };

// key, blattNr, anfangsbestand, sumEinnahmen, sumAusgaben, endbestand, kaffeePrice (der jeweiligen Zeit)
const SEED_2026 = [
  { key: '2026-01', blattNr: '838', anfangsbestand: 690.64, sumEinnahmen: 147.00, sumAusgaben: 216.99, endbestand: 620.65, kaffee: 1.5 },
  { key: '2026-02', blattNr: '839', anfangsbestand: 766.15, sumEinnahmen: 154.50, sumAusgaben: 0.00, endbestand: 920.65, kaffee: 1.5 },
  { key: '2026-03', blattNr: '840', anfangsbestand: 777.15, sumEinnahmen: 213.00, sumAusgaben: 0.00, endbestand: 990.15, kaffee: 1.5 },
  { key: '2026-04', blattNr: '841', anfangsbestand: 990.15, sumEinnahmen: 220.00, sumAusgaben: 0.00, endbestand: 1210.15, kaffee: 1.5 },
  { key: '2026-05', blattNr: '842', anfangsbestand: 1210.15, sumEinnahmen: 173.00, sumAusgaben: 10.57, endbestand: 1372.58, kaffee: 1.5 },
  { key: '2026-06', blattNr: '843', anfangsbestand: 1372.58, sumEinnahmen: 777.00, sumAusgaben: 1516.52, endbestand: 633.06, kaffee: 2.0 },
];

// Ein Seed-Eintrag -> vollständiger, abgeschlossener Archiv-Monat für den Store.
function seedRecord(s) {
  const [y, m] = s.key.split('-');
  return {
    key: s.key, year: parseInt(y, 10), month: parseInt(m, 10),
    blattNr: s.blattNr, anfangsbestand: s.anfangsbestand,
    gezaehlterEndbestand: null,
    prices: { kaffee: s.kaffee, eiweissshake: 2.5, eiweissbeutel: 20.5 },
    days: {},
    imported: { sumEinnahmen: s.sumEinnahmen, sumAusgaben: s.sumAusgaben, endbestand: s.endbestand },
    source: 'import',
    closed: true, closedAt: null, closedBy: 'Import (Altbestand 2026)',
  };
}

module.exports = { SEED_PRICES, SEED_2026, seedRecord };
