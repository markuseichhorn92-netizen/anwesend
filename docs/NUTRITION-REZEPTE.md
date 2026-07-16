# Ernährung · Rezepte, Koch-Plan & Nutri-Score

Kurzüberblick über das neue Rezept-Konzept im Ernährungs-Modul (Mitglieder-App).
Statt statischer Rezepte generiert **FINN** Rezepte, die dauerhaft in einer
**studioweiten, wachsenden Bibliothek** landen. Alle KI-Funktionen sind **Premium**
(server-seitig gegated). `ERN_LAUNCH` bleibt bis zum finalen Start `false`.

## Bausteine

| Datei | Aufgabe |
|---|---|
| `lib/nutriscore.js` | Offizieller Nutri-Score A–E (Update 2023), rein rechnerisch. `score()` für Werte je 100 g, `scoreRecipe()` aus Gesamt-Nährwerten + Portionsgewicht, `gradeFromOFF()`. |
| `lib/recipes.js` | Studio-Bibliothek: `addToLibrary` (Dedup via `HSETNX` auf normalisiertem Titel), `getLibrary`, `searchLibrary`, `seedOnce`. `normalizeRecipe` rechnet den Nutri-Score dazu. |
| `lib/ai.js` → `nutritionRecipes` | Generiert Rezepte im reichen Format: Zutaten `{name,grams}`, `weightG`, `fruitVegPct`, Zubereitung, `finnRating{stars,text}`. |
| `api/member/nutrition.js` | Actions: `recipes`, `recipe-library`, `recipe-save/-get/-delete`, `recipe-log`, `cookplan-add/-get/-remove/-done`, `cook-check`, `cook-clear-checked`. |
| `api/member/food-products.js` + `lib/openFoodFacts.js` | Produkt-Nutri-Score: offizielle OFF-Note (`nutriscore_grade`), sonst berechnet. |
| `mitglieder.html` | Rezept-Screen (Generator + Bibliothek + Suche), Rezept-Detail (Nutri-Score-Skala, FINN-Bewertung, Gramm-Zutaten, Zubereitung), Koch-Plan-Tab, Einkaufsliste, Koch-Modus. |

## Redis-Schlüssel

```
nutri:lib:idx          LIST   Rezept-IDs der Bibliothek (neueste zuerst, LTRIM 300)
nutri:lib:r:<id>       STRING das kanonische Rezept (JSON)
nutri:lib:titles       HASH   normalisierter Titel -> id (Dedup)
nutri:lib:seeded       STRING Flag „Startbestand übernommen"
nutri:rec:<memberId>   STRING persönliche gespeicherte Rezepte (max 40)
nutri:cook:<memberId>  STRING Koch-Plan { items[], checked{} } + abgeleitete Einkaufsliste
```

## Kanonische Rezept-Form (Makros gelten PRO PORTION)

```json
{
  "id": "…", "title": "…", "source": "ai|seed|member",
  "servings": 2, "minutes": 20,
  "kcal": 480, "protein": 35, "carbs": 40, "fat": 16,
  "weightG": 450, "fruitVegPct": 55,
  "ingredients": [{ "text": "120 g Reis", "grams": 120 }],
  "steps": ["…"],
  "finnRating": { "stars": 5, "text": "…" },
  "nutri": { "grade": "A", "points": -2 },
  "macrosComplete": true
}
```

## Nutri-Score (2023)

- Feste Lebensmittel & Getränke haben getrennte Schwellen; Wasser = A.
- Für Rezepte: Werte je 100 g aus `Gesamt-Nährwerte / Portionsgewicht (weightG)`.
  Fehlt ein Detailwert, wird konservativ geschätzt (Zucker ≈ 30 % KH, gesätt. Fett ≈ 35 % Fett).
- Für Produkte: bevorzugt die offizielle OFF-Note; sonst berechnet.
- Validiert gegen Referenzen (Nutella = E, Wasser = A, Magerjoghurt ≤ B …).

## Startbestand

Die 8 bisher kuratierten Rezepte werden einmalig als `source:'seed'` übernommen
(`Recipes.seedOnce(ERN_SEED)` in `nutrition.js`, idempotent via `SETNX`-Flag).

## Datenschutz

Koch-Plan und persönliche Rezepte sind im DSGVO-Export enthalten und werden bei
„Alle Daten löschen" mitgelöscht. Die studioweite Bibliothek ist anonym (keine
personenbezogenen Daten) und bleibt bestehen.
