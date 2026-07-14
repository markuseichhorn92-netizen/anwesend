# Open Food Facts – Produktkatalog & Barcode fürs Ernährungsmodul

Serverseitige, belastbare Integration von [Open Food Facts](https://world.openfoodfacts.org)
(OFF) in das Ernährungsmodul. Mitglieder können Lebensmittel per **Barcode** oder
**Suche** finden und – nach Bestätigung – ins Tagesprotokoll übernehmen.

> Hinweis: Dieses Dokument beschreibt die Implementierung im Repo, keine
> verbindliche Rechtsberatung. Für die konkrete Nutzung/Attribution bitte die
> offiziellen OFF-/ODbL-Bedingungen prüfen.

## Architektur

```
Mitglieder-App (mitglieder.html)
    ↓  (nur eingeloggt, Bearer-Token)
Vercel API  ── api/member/food-products.js   (barcode | search)
    ↓
Upstash Redis  ── Cache · Negativ-Cache · Locks · globale Limits   (lib/foodCatalog.js)
    ↓
lokaler Produktkatalog  ── off:product:<barcode>                    (lib/foodCatalog.js)
    ↓  nur bei unbekanntem/veraltetem Produkt
Open Food Facts API  ── lib/openFoodFacts.js  (Timeout, 1 Retry, Validierung)
```

**Open Food Facts wird niemals direkt aus dem Browser aufgerufen.** Jeder Zugriff
läuft serverseitig über `api/member/food-products.js`. Rohantworten, interne
Redis-Schlüssel oder Rohfehler verlassen den Server nie.

### Dateien
| Datei | Rolle |
|---|---|
| `lib/openFoodFacts.js` | OFF-Client: Fetch mit Timeout/Retry, strikte Validierung, Normalisierung |
| `lib/foodCatalog.js` | Storage-Abstraktion: Katalog, Cache, Negativ-Cache, Locks, globale Limits, Orchestrierung |
| `api/member/food-products.js` | Authentifizierte Member-API (`barcode`, `search`) |
| `api/member/nutrition.js` | Übernahme ins Protokoll via `confirm-log` (Bestätigungs-Flow) |
| `scripts/import-openfoodfacts.js` | Cold-Start-Importer (JSONL-Export, Streaming, Dry-Run) |

## Datenfluss Barcode
1. Barcode normalisieren/validieren (GTIN-8/12/13/14 inkl. Prüfziffer).
2. **Negativ-Cache** prüfen (`off:missing:<barcode>`).
3. **Katalog/Cache** prüfen (`off:product:<barcode>`). Frisch → direkt zurück.
4. Nur bei unbekannt/veraltet: **Lock** setzen (Coalescing), **globales Limit** atomar prüfen, dann **OFF** abfragen.
5. Ergebnis validieren, normalisieren, in Katalog schreiben, Cache aktualisieren.
6. Bei OFF-Ausfall/Limit: alten Katalog weiterverwenden und `stale: true` markieren.
7. Übernahme ins Protokoll erst nach **Nutzerbestätigung** (Portion/Gramm, Mahlzeit, Datum) über `nutrition.js` → `confirm-log` mit `{ source:'openfoodfacts', barcode, estimated:false }`.

## Normalisiertes Produktmodell
```json
{
  "barcode": "4000417025005",
  "name": "…", "brand": "…", "quantity": "500 g", "servingSize": "30 g",
  "nutritionBasis": "100g",
  "nutriments": { "kcal100g": 0, "protein100g": 0, "carbs100g": 0, "fat100g": 0,
                  "fiber100g": null, "sugars100g": null, "salt100g": null },
  "imageUrl": null, "countries": [], "source": "openfoodfacts",
  "sourceUrl": "…", "sourceModifiedAt": 0,
  "cachedAt": 0, "lastCheckedAt": 0, "lastUsedAt": 0, "usageCount": 0, "schemaVersion": 1
}
```
- **Fehlende Nährwerte bleiben `null`** – nie scheinbar korrekte `0`.
- Zahlen werden validiert und begrenzt (kcal ≤ 1000/100 g, Makros ≤ 100 g/100 g).
- Nur benötigte Felder werden gespeichert; **keine personenbezogenen Daten** im gemeinschaftlichen Katalog.
- Bild-URLs müssen HTTPS und ein erlaubter OFF-Host sein (`images|static|world|de.openfoodfacts.org`).

## Cache-Strategie
| Fall | Verhalten |
|---|---|
| Produkt < `FRESH_DAYS` (7) | direkt aus Katalog (`source: catalog`) |
| Produkt 7–30 Tage | sofort anzeigen, im Hintergrund/gelockt aktualisieren |
| Produkt > `MAX_STALE_DAYS` (30) | Aktualisierung bevorzugt |
| Barcode nicht gefunden | Negativ-Cache 16 h |
| Suchergebnisse | 3 h Cache (`off:search:<hash>`) |
| OFF-Ausfall | letzter Cache bleibt gültig, `stale: true` |

### Cache-Stampede-Schutz
Pro Barcode kurzer Redis-Lock (`SET … NX EX 8`). Parallele identische Anfragen
lösen **nur einen** externen Request aus; die übrigen liefern den Cache oder lesen
nach kurzer Wartezeit erneut. Keine langen Blockaden in Vercel Functions; Locks
laufen bei Fehlern automatisch aus (TTL).

## Limits
- **OFF erlaubt** (pro IP): ~100/min Produktabfragen, 10/min Suchabfragen.
- **Global (app-weit), atomar** über `INCR`+`EXPIRE` (bewusst darunter):
  - Produktabfragen: `OPENFOODFACTS_PRODUCT_LIMIT_PER_MINUTE` (Default 60/min)
  - Suchabfragen: `OPENFOODFACTS_SEARCH_LIMIT_PER_MINUTE` (Default 8/min)
- Wichtig: Durch das Caching wird OFF nur beim **ersten** Scan eines Produkts
  aufgerufen; Wiederholungen kommen aus dem Katalog. Das Limit zählt nur echte
  OFF-Aufrufe, nicht Cache-Treffer.
- **Pro Mitglied** (zusätzlich): 40 Barcode-/20 Such-Abfragen pro Stunde.
- Barcode-Abfragen werden gegenüber Freitextsuche priorisiert; für ungültige Barcodes gibt es keine externen Anfragen.
- Interne Quellenkennzeichnung: `cache | catalog | openfoodfacts` (+ `stale`).

## Open-Food-Facts-Client
- Produkt-Read: `GET {BASE}/api/v2/product/<barcode>.json?fields=…&lc=de`
- Suche: `GET {BASE}/cgi/search.pl?search_terms=…&json=1&page_size=…&fields=…`
- Timeout via `AbortController` (`OPENFOODFACTS_TIMEOUT_MS`, Default 4500 ms).
- Max. **1 Retry** bei 429/503/Netzwerk mit Backoff; **kein** Retry bei 400/404.
- Antwortgröße begrenzt (~700 KB). Nur benötigte Felder (`fields=`).
- **User-Agent:** `FitInnNutrition/1.0 (OPENFOODFACTS_CONTACT_EMAIL)`.
  Fehlt die Adresse, macht der Client **keine** externen Requests (`not_configured`)
  und die UI fällt auf manuelle Eingabe / KI-Schätzung zurück. Keine erfundene Adresse.

> Vor Go-Live die aktuelle OFF-API- und Lizenz-Doku gegenprüfen; die Endpunkte
> sind über `OPENFOODFACTS_BASE_URL` austauschbar.

## Katalog vorbefüllen (empfohlen vor Go-Live)
Damit gleich zu Beginn fast jeder Scan lokal trifft (statt live OFF zu fragen).
Beide Skripte brauchen dieselben `KV_*/UPSTASH_*`-Env wie die App **plus**
`OPENFOODFACTS_CONTACT_EMAIL`. Idempotent (Aktualisierung per Barcode).

**A) Warmup – schnell, empfohlen** (`scripts/warmup-openfoodfacts.js`)
Lädt die **meistgescannten** Deutschland-Produkte über die OFF-Suche
(nach `unique_scans_n`), paginiert mit Pause (schont das 10/min-Suchlimit).
```
node scripts/warmup-openfoodfacts.js --dry-run              # nur anzeigen
node scripts/warmup-openfoodfacts.js --limit 1000 --country de   # ~1000 Top-Produkte
```
~10 Aufrufe für bis zu 1000 Produkte, ~1–2 Minuten. Gelegentliche 503 werden
einmal wiederholt; einfach erneut laufen lassen füllt Lücken nach.

**B) Voll-Import – gründlich** (`scripts/import-openfoodfacts.js`)
Streamt den offiziellen JSONL-Voll-Export (mehrere GB) und filtert
Deutschland-relevante Produkte mit brauchbaren Nährwerten.
```
node scripts/import-openfoodfacts.js --file products.jsonl --limit 20000 --country de
```
Nur manuell/als Job laufen lassen – nie im Vercel-Deploy.

## Umgebungsvariablen
```
OPENFOODFACTS_CONTACT_EMAIL=            # Pflicht für externe Abfragen (echte Adresse!)
OPENFOODFACTS_PRODUCT_LIMIT_PER_MINUTE=12
OPENFOODFACTS_SEARCH_LIMIT_PER_MINUTE=8
OPENFOODFACTS_FRESH_DAYS=7
OPENFOODFACTS_MAX_STALE_DAYS=30
# OPENFOODFACTS_BASE_URL=https://world.openfoodfacts.org
# OPENFOODFACTS_TIMEOUT_MS=4500
# CRON_SECRET=                          # nur falls Hot-Refresh-Cron ergänzt wird
```
Upstash/KV nutzt die bestehenden `KV_REST_API_URL/TOKEN` bzw. `UPSTASH_REDIS_REST_URL/TOKEN`.

## Cold-Start-Import
```
node scripts/import-openfoodfacts.js --file products.jsonl [--limit 20000] [--dry-run] [--country de] [--batch 50]
```
- Streaming (zeilenweise), lädt die Datei **nicht** komplett in den Speicher.
- Eingabe: offizieller OFF-**JSONL**-Export (entpackt). Kein Bilder-Download.
- Übernimmt nur Datensätze mit gültigem Barcode + brauchbaren Nährwerten, Deutschland-relevant.
- Idempotent: Duplikate werden per Barcode **aktualisiert**, nicht vervielfacht → beliebig wiederholbar/fortsetzbar.
- `--dry-run` schreibt nichts und braucht kein KV.
- **Nie** automatisch im Vercel-Deploy ausführen.

**Empfehlung:** Für 10 000–20 000 relevante Produkte ist Upstash grenzwertig
(Speicher/Kosten pro Key). Ab dieser Größenordnung → **Postgres (Neon/Supabase)**
für Katalog + Volltextsuche; Upstash bleibt für Cache/Locks/Limits.

## Wechsel Upstash → Postgres
Nur die Katalog-Funktionen in `lib/foodCatalog.js` (`catalogGet` / `catalogPut` /
`searchProducts`) gegen Postgres reimplementieren (Tabelle `food_products` mit
`barcode PRIMARY KEY`, Nährwert-Spalten `NULL`-fähig, `GIN`/`tsvector`-Index für die
Suche). Cache, Locks und globale Limits bleiben unverändert auf Upstash. SQL-Skizze:
```sql
CREATE TABLE food_products (
  barcode text PRIMARY KEY,
  name text, brand text, quantity text, serving_size text,
  kcal100g numeric, protein100g numeric, carbs100g numeric, fat100g numeric,
  fiber100g numeric, sugars100g numeric, salt100g numeric,
  image_url text, countries text[], source text, source_url text,
  source_modified_at timestamptz, last_checked_at timestamptz, usage_count int DEFAULT 0,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('german', coalesce(name,'')||' '||coalesce(brand,''))) STORED
);
CREATE INDEX ON food_products USING gin (tsv);
```
> Aktuell (Upstash-MVP): **Barcode**-Lookup voll funktionsfähig; **Freitextsuche**
> geht ergänzend an OFF (gecacht), da Upstash keinen Volltextindex bietet. Der
> lokale Volltext-Katalog wird erst mit Postgres wirksam.

## Optionaler Hot-Refresh-Cron (noch nicht implementiert)
Falls ergänzt: geschützte Route mit `CRON_SECRET`, pro Lauf nur eine kleine
konfigurierbare Anzahl „heißer" Produkte (`off:hot:<barcode>`) aktualisieren, globale
Limits respektieren, keine Vollsynchronisierung. `vercel.json` nur anpassen, wenn es
zum bestehenden Aufbau passt.

## Datenschutz & Sicherheit
- Nur authentifizierte Mitglieder dürfen die Member-API nutzen.
- Gemeinschaftliche Produktdaten enthalten **keine** Mitgliedskennung; Favoriten/Protokolle bleiben pro Mitglied getrennt.
- Keine Kamerabilder dauerhaft speichern; keine Produktbilder in Blob kopieren – nur externe (validierte) URLs.
- Alle Texte werden vor der HTML-Ausgabe escaped (`esc()` im Client).
- Clientdaten werden nie vertraut; Strings/Arrays/Zahlen serverseitig begrenzt.
- OFF ist **keine medizinisch geprüfte Quelle** – Angaben können unvollständig/fehlerhaft sein.

## Lizenz & Quellenhinweis
Produktdaten stammen von **Open Food Facts** und stehen unter der **Open Database
License (ODbL)**. Im Ernährungsmodul wird angezeigt:

> „Produktdaten: Open Food Facts – verfügbar unter der Open Database License (ODbL).
> Angaben können unvollständig oder fehlerhaft sein."

Mit Links zu Open Food Facts und zur ODbL-Lizenz. Produktbilder stehen i. d. R. unter
**CC-BY-SA** – der jeweils erforderliche Bild-/Quellenhinweis ist zu berücksichtigen.

- **Verwendete Daten:** Produktname, Marke, Menge, Portionsgröße, Nährwerte je 100 g, optional Bild-URL, Herkunftsländer, `last_modified`.
- **Attribution:** Hinweis + Link im Modul; pro Produkt Link zur OFF-Produktseite (`sourceUrl`).
- **Kommerzielle Nutzung** ist unter Einhaltung der ODbL möglich.
- **Share-Alike:** Wird eine öffentlich bereitgestellte *abgeleitete Datenbank* verteilt, können Share-Alike-Pflichten (ODbL) greifen. (Keine Rechtsberatung.)

## Fehlerfälle (UX)
Behandelt bzw. vorgesehen: Produkt gefunden / nicht gefunden / ohne vollständige
Nährwerte (`incomplete`/`complete:false`) / ungültiger Barcode / OFF nicht erreichbar
/ externes Limit / Mitgliedslimit / veralteter Cache (`stale`) / parallele Anfrage
(`busy`) / Übernahme erfolgreich / Speicherfehler. Die Erfassung bleibt bei OFF-Ausfall
nutzbar: **manuelle Eingabe** und **KI-Schätzung** sind immer als Fallback verfügbar.

## Manuelle Launch-Checkliste
1. `OPENFOODFACTS_CONTACT_EMAIL` mit **echter** Adresse setzen (Vercel-Env).
2. Optional: `products.jsonl` besorgen und `scripts/import-openfoodfacts.js --dry-run` prüfen, dann echten Import fahren (nicht im Deploy).
3. Ab ~10–20 k Produkten Postgres einrichten (siehe oben) und Katalog-Funktionen umstellen.
4. Frontend-Erfassung (Barcode-Scan/Suche) an den `confirm-log`-Flow anschließen (siehe „Offen").
5. `ERN_ON` erst nach Prüfung auf `true` setzen.

## Offen / noch nicht umgesetzt
- **Frontend**: „Barcode scannen" (BarcodeDetector + manuelle Eingabe-Fallback) und Produktsuche-UI, jeweils eingehängt in den bestehenden Bestätigungs-/Entwurfs-Flow. Backend + API stehen und sind getestet.
- **Postgres-Katalog + Volltextsuche** (Upstash-MVP nur Barcode-Lookup lokal).
- **Optionaler Hot-Refresh-Cron**.
