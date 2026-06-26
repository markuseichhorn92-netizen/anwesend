# Fit-Inn Trier · Live-Auslastung

Zeigt die aktuelle Personenzahl im Studio als Live-Widget — für Website und Signage.
Die Zahl kommt aus der Magicline Open API (`GET /v1/studios/utilization`, Feld `count`).

**Architektur:** Ein kleiner Node-Proxy (Docker) auf dem VPS hält den API-Key serverseitig,
fragt Magicline höchstens alle 45 s ab und liefert eine **anonyme, aggregierte** JSON-Zahl.
Das Frontend-Widget spricht nur den Proxy an — der Key landet nie im Browser.

```
Browser/Signage ──> widget.html ──> dein Proxy (VPS) ──x-api-key──> Magicline
```

---

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

## Sicherheit / DSGVO

- Ausgeliefert wird nur eine **anonyme, aggregierte Zahl** — keine personenbezogenen Daten.
- `.env` niemals committen (ist in `.gitignore`).
- Magicline wird durch den Cache geschont (Schutz vor Rate-Limit / 429).
- Bei kurzem Magicline-Aussetzer liefert der Proxy den letzten bekannten Wert (`stale: true`) statt zu crashen.
