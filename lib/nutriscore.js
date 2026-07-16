'use strict';

/**
 * Offizieller Nutri-Score (Update 2023) – rein rechnerisch, ohne Fremd-Dependency.
 * ------------------------------------------------------------------------------
 * Berechnet aus Nährwerten PRO 100 g/ml die Punkte und die Note A–E.
 *
 *   score({ kcal100, sugars100, satfat100, salt100, fiber100, protein100,
 *           fruitVegPct, isBeverage })
 *     -> { grade:'A'|'B'|'C'|'D'|'E', points:Number, negative:Number, positive:Number }
 *
 * Grundlage: FSAm-NPS-Algorithmus in der 2023 aktualisierten Fassung
 * (getrennte Schwellen für feste Lebensmittel und Getränke; Wasser = A).
 * Für Produkte, die von Open Food Facts bereits ein `nutriscore_grade` liefern,
 * wird DIESE Note bevorzugt (siehe gradeFromOFF) – gerechnet wird nur, wenn kein
 * offizieller Wert vorliegt (z. B. für selbst generierte Rezepte).
 *
 * Alle Eingaben werden defensiv geparst; fehlende Werte zählen als 0. Rückgabe
 * ist immer eine gültige Note, nie ein Wurf.
 */

function num(v) { const n = Number(v); return (isNaN(n) || n < 0) ? 0 : n; }

// Punkte aus einer aufsteigenden Schwellen-Tabelle: erster Grenzwert, der NICHT
// überschritten wird, bestimmt die Punktzahl (Index). Über der letzten Grenze -> Maxpunkt.
function pointsFrom(value, thresholds) {
  for (let i = 0; i < thresholds.length; i++) {
    if (value <= thresholds[i]) return i;
  }
  return thresholds.length;
}

// ── Schwellen (2023) ─────────────────────────────────────────────────────────
// Energie in kJ. Feste Lebensmittel 0–10.
const ENERGY_SOLID = [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350];
// Getränke: 0–10, eigene (niedrigere) Grenzen.
const ENERGY_BEV = [30, 90, 150, 210, 240, 270, 300, 330, 360, 390];
// Zucker (g) fest 0–15 (2023 verschärft).
const SUGAR_SOLID = [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51];
// Zucker (g) Getränke 0–15.
const SUGAR_BEV = [0.5, 2, 3.5, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 18];
// Gesättigte Fettsäuren (g) 0–10.
const SATFAT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// Salz (g) 0–20 (2023).
const SALT = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6, 2.8, 3.0, 3.2, 3.4, 3.6, 3.8, 4.0];
// Eiweiß (g) 0–7 (fest, 2023).
const PROTEIN = [2.4, 4.8, 7.2, 9.6, 12, 14, 17];
// Ballaststoffe (g, AOAC) 0–5 (2023).
const FIBER = [3.0, 4.1, 5.2, 6.3, 7.4];

function fruitVegPoints(pct, isBeverage) {
  const p = Math.max(0, Math.min(100, num(pct)));
  if (isBeverage) {
    if (p <= 40) return 0;
    if (p <= 60) return 2;
    if (p <= 80) return 4;
    return 6;   // >80 % (Getränke, 2023 max 6)
  }
  if (p <= 40) return 0;
  if (p <= 60) return 1;
  if (p <= 80) return 2;
  return 5;     // >80 % (fest, max 5)
}

/**
 * Nutri-Score aus Nährwerten pro 100 g/ml.
 * salt100 in Gramm Salz (nicht Natrium). Ist nur Natrium bekannt: salt = natrium(g) * 2.5.
 */
function score(input) {
  input = input || {};
  const bev = !!input.isBeverage;
  const kcal = num(input.kcal100);
  const energyKJ = input.energyKJ != null ? num(input.energyKJ) : Math.round(kcal * 4.184);

  // Reines Wasser (keine Energie, kein Zucker) -> immer A.
  if (bev && energyKJ === 0 && num(input.sugars100) === 0) {
    return { grade: 'A', points: 0, negative: 0, positive: 0 };
  }

  const pEnergy = pointsFrom(energyKJ, bev ? ENERGY_BEV : ENERGY_SOLID);
  const pSugar = pointsFrom(num(input.sugars100), bev ? SUGAR_BEV : SUGAR_SOLID);
  const pSat = pointsFrom(num(input.satfat100), SATFAT);
  const pSalt = pointsFrom(num(input.salt100), SALT);
  const negative = pEnergy + pSugar + pSat + pSalt;

  const pProtein = pointsFrom(num(input.protein100), PROTEIN);
  const pFiber = pointsFrom(num(input.fiber100), FIBER);
  const pFruitVeg = fruitVegPoints(input.fruitVegPct, bev);

  // Eiweiß-Regel: Bei festen Lebensmitteln zählt Eiweiß nicht mit, wenn die
  // negativen Punkte >= 11 sind – ES SEI DENN, die Frucht/Gemüse-Punkte sind maximal.
  let positive;
  if (!bev && negative >= 11 && pFruitVeg < 5) {
    positive = pFiber + pFruitVeg;             // Eiweiß fällt weg
  } else {
    positive = pProtein + pFiber + pFruitVeg;
  }

  const total = negative - positive;

  let grade;
  if (bev) {
    // Getränke-Grenzen (2023): A <=2, B 3–6, C 7–9, D 10–13, E >=14.
    grade = total <= 2 ? 'A' : total <= 6 ? 'B' : total <= 9 ? 'C' : total <= 13 ? 'D' : 'E';
  } else {
    // Feste Lebensmittel (2023): A <=0, B 1–2, C 3–10, D 11–18, E >=19.
    grade = total <= 0 ? 'A' : total <= 2 ? 'B' : total <= 10 ? 'C' : total <= 18 ? 'D' : 'E';
  }
  return { grade: grade, points: total, negative: negative, positive: positive };
}

/**
 * Nutri-Score für ein Rezept: aus Gesamt-Nährwerten + Gesamtgewicht (g) die
 * Werte pro 100 g bilden und bewerten. fruitVegPct optional (0 wenn unbekannt).
 * totals: { kcal, protein, carbs, fat, sugars?, satfat?, salt?, fiber? } (fürs GANZE Rezept).
 */
function scoreRecipe(totals, totalGrams, fruitVegPct) {
  totals = totals || {};
  const g = num(totalGrams);
  if (g < 1) return null;
  const f = 100 / g;
  // Fehlt ein Detailnährwert, konservativ abschätzen (Zucker~30 % der KH, gesätt. Fett~35 % Fett).
  const sugars = totals.sugars != null ? num(totals.sugars) : num(totals.carbs) * 0.30;
  const satfat = totals.satfat != null ? num(totals.satfat) : num(totals.fat) * 0.35;
  const salt = totals.salt != null ? num(totals.salt) : 0;
  const fiber = totals.fiber != null ? num(totals.fiber) : 0;
  return score({
    kcal100: num(totals.kcal) * f,
    sugars100: sugars * f,
    satfat100: satfat * f,
    salt100: salt * f,
    fiber100: fiber * f,
    protein100: num(totals.protein) * f,
    fruitVegPct: num(fruitVegPct),
    isBeverage: false,
  });
}

// Offizielle OFF-Note übernehmen (a–e -> A–E), sonst null.
function gradeFromOFF(g) {
  const s = String(g || '').trim().toUpperCase();
  return /^[ABCDE]$/.test(s) ? s : null;
}

module.exports = { score, scoreRecipe, gradeFromOFF };
