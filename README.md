# Fit-Inn Trier · Live-Auslastung

Zeigt die aktuelle Personenzahl im Studio als Live-Widget — für Website und Signage.
Die Zahl kommt aus der Magicline Open API (`GET /v1/studios/utilization`, Feld `count`).

**Architektur:** Ein kleiner Node-Proxy hält den API-Key serverseitig,
fragt Magicline höchstens alle 45 s ab und liefert eine **anonyme, aggregierte** JSON-Zahl.
Das Frontend-Widget spricht nur den Proxy an — der Key landet nie im Browser.

```
Browser/Signage ──> widget.html ──> dein Proxy ──x-api-key──> Magicline
```

Es gibt zwei Deployment-Wege — **Vercel** (Serverless, am einfachsten) oder **VPS/Docker**:

| | Vercel | VPS / Docker |
|---|---|---|
| Code | `api/*.js` + `widget.html` | `server.js` |
| Konfig | Environment Variables im Dashboard | `.env` |
| URL | `…vercel.app/api/auslastung` | `https://auslastung.fit-inn-trier.de/api/auslastung` |

---

## Variante A: Vercel (empfohlen) ▲

Vercel führt **Serverless Functions** aus — es startet *keinen* langlaufenden
`server.js`. Deshalb liegen die Endpunkte als Functions unter `api/`:

```
api/auslastung.js   ->  GET /api/auslastung
api/health.js       ->  GET /api/health
widget.html         ->  /  (per vercel.json auf die Wurzel gemappt)
```

1. **Repo mit Vercel verbinden** (Add New → Project → dieses GitHub-Repo importieren).
   Framework-Preset: *Other*. Build-Command leer lassen — Zero-Config genügt.
2. **Environment Variable setzen** (Project → Settings → Environment Variables):

   | Name | Wert |
   |---|---|
   | `ML_API_KEY` | **dein neuer Magicline-Key** (siehe Schritt 0) |
   | `MAX_CAPACITY` | `80` *(optional)* |
   | `YELLOW_AT` / `RED_AT` | `50` / `80` *(optional)* |

   > ⚠️ Ohne `ML_API_KEY` antwortet `/api/auslastung` mit `500 { "error": "missing_api_key" }`.
   > Nach dem Setzen **neu deployen**, damit die Variable greift.
3. **Deploy.** Danach prüfen:

   ```bash
   curl https://<dein-projekt>.vercel.app/api/auslastung
   # -> {"count":5,"max":80,"percent":6,"status":"low",...}
   ```

   Das Widget ist direkt unter der Projekt-Wurzel (`https://<dein-projekt>.vercel.app/`)
   erreichbar und ruft `/api/auslastung` auf derselben Domain ab.

---

## Variante B: VPS / Docker

## 0. Zuerst: API-Key rotieren 🔐

Der bisher genutzte Key ist im Klartext durch einen Chat gelaufen — den **vorher neu generieren**:
Developer Portal → deine Application → API-Key regenerieren. Den neuen Key nur in die `.env` (Schritt 2).

---

## 1. Dateien auf den VPS

```bash
scp -r fitinn-auslastung/ user@srv1309486:/opt/
# oder per git clone in ein privates Repo (.env ist via .gitignore ausgeschlossen)
cd /opt/fitinn-auslastung
```

## 2. `.env` anlegen

```bash
cp .env.example .env
nano .env          # ML_API_KEY = neuer Key, MAX_CAPACITY=80
```

## 3. Container starten

```bash
docker compose up -d --build
```

Lokal testen:

```bash
curl http://127.0.0.1:8080/api/auslastung
# -> {"count":5,"max":80,"percent":6,"status":"low",...}
```

## 4. Öffentlich erreichbar + HTTPS

DNS-A-Record anlegen: `auslastung.fit-inn-trier.de` → IP des VPS.

**Variante Caddy** (automatisches Let's-Encrypt-Zertifikat) — im `Caddyfile`:

```caddy
auslastung.fit-inn-trier.de {
    reverse_proxy 127.0.0.1:8080
}
```

**Variante nginx** — Server-Block:

```nginx
server {
    server_name auslastung.fit-inn-trier.de;
    location / {
        proxy_pass http://127.0.0.1:8080;
    }
}
# danach: certbot --nginx -d auslastung.fit-inn-trier.de
```

Prüfen:

```bash
curl https://auslastung.fit-inn-trier.de/api/auslastung
```

## 5. Widget einbinden

In `widget.html` ganz unten im `CONFIG`-Block die Proxy-URL eintragen:

```js
endpoint: 'https://auslastung.fit-inn-trier.de/api/auslastung',
```

Einbetten:
- **Sanity / Next.js-Seite:** den `.fi-auslastung`-Block + `<style>` übernehmen, oder die ganze Datei als `<iframe src="…/widget.html">`.
- **Onepage / Signage:** als Custom-HTML-Block bzw. Vollbild-Seite. Für Großbildschirme die Klasse `fi-auslastung--signage` am Element ergänzen.

---

## Antwort-Format

```json
{
  "count": 5,          // aktuell anwesende Personen
  "max": 80,           // Maximalwert für die Ampel
  "percent": 6,        // count / max
  "status": "low",     // low | medium | high  -> Ampel grün/gelb/rot
  "rawCapacity": null, // was Magicline selbst meldet
  "updatedAt": "2026-06-26T…Z",
  "cached": true       // aus dem 45s-Cache?
}
```

Ampel-Schwellen: grün < 50 % · gelb 50–79 % · rot ≥ 80 %. Anpassbar über `YELLOW_AT` / `RED_AT` in der `.env`.

## Typische Auslastung / „Stoßzeiten"

Die Magicline API liefert **nur den aktuellen Live-Wert** — keine historische
„so voll ist es normalerweise um diese Zeit"-Kurve. Diese bauen wir selbst auf,
indem wir den Live-Wert regelmäßig mitschreiben und pro Wochentag + 30-Min-Slot
mitteln (wie Google Maps' „Stoßzeiten"). Gespeichert werden **nur anonyme,
aggregierte Durchschnittszahlen**.

**Bausteine:**

1. **Speicher — Upstash Redis** (Vercel → Storage → Upstash → Redis → mit Projekt
   verbinden). Setzt automatisch `KV_REST_API_URL` + `KV_REST_API_TOKEN`.
2. **Taktgeber — GitHub Actions** (`.github/workflows/record.yml`): ruft alle
   15 min `/api/record` auf. Läuft nur auf dem Default-Branch des Repos.
3. **Endpunkte:**
   - `GET /api/record` — schreibt den aktuellen Wert in die Historie (vom Cron).
   - `GET /api/typical` — liefert „normal um diese Zeit" + Tageskurve fürs Widget.

**Datenmodell (Redis):** je Wochentag zwei Hashes `typical:sum:{wd}` und
`typical:cnt:{wd}` mit Feld = Slot (0–47). Durchschnitt = `sum / cnt`.

**Live-Daten haben Priorität (gleitender Speicher):** Ab `TYPICAL_MAX_SAMPLES`
Messungen pro Slot (Standard 40 ≈ ~20 Wochen) läuft ein gleitender Schnitt
(EWMA) — jede neue Live-Messung verdrängt den ältesten Anteil. So spiegelt die
Kurve immer die jüngere Realität wider und die historische Basis verblässt über
einige Monate. Niedrigerer Wert = schnellere Anpassung an Veränderungen.

**Optionaler Schutz:** Repo-Secret `RECORD_SECRET` anlegen **und** dieselbe
Env-Variable in Vercel setzen — dann akzeptiert `/api/record` nur Aufrufe mit
passendem `Authorization: Bearer …`. Ohne Secret ist der Endpunkt offen
(für den anonymen Zähl-Zweck unkritisch).

Nach ~1 Woche entsteht eine brauchbare Kurve, nach ~3–4 Wochen eine solide.
Das Widget zeigt dann „Jetzt: X · Normal um diese Zeit: ~Y" plus ein kleines
Tagesdiagramm. Zeitzone via `STUDIO_TZ` (Standard `Europe/Berlin`).

**Historische Basis (Seed):** Aus einem Check-in-Export lässt sich eine
Startkurve vorab eintragen. Die anonymen Aggregate (Ø Anwesende je
Wochentag+Slot) liegen in `data/baseline.json`; der Endpunkt `/api/seed?confirm=1`
schreibt sie **einmalig** in den Speicher (idempotent — zweiter Aufruf tut nichts,
`&force=1` überschreibt). Das Gewicht (`weight` in der JSON) bestimmt, wie schnell
die Live-Daten die Basis überschreiben — bewusst niedrig gehalten. Im Export
landen **nur Aggregate**, keine personenbezogenen Daten.

## Sicherheit / DSGVO

- Ausgeliefert wird nur eine **anonyme, aggregierte Zahl** — keine personenbezogenen Daten.
- `.env` niemals committen (ist in `.gitignore`).
- Magicline wird durch den Cache geschont (Schutz vor Rate-Limit / 429).
- Bei kurzem Magicline-Aussetzer liefert der Proxy den letzten bekannten Wert (`stale: true`) statt zu crashen.
