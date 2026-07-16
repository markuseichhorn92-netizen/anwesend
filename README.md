# Fit-Inn Trier · Mitglieder-Portal, Team-Backend & Live-Auslastung

Digitale Plattform des Fitnessstudios Fit-Inn Trier auf Basis von
**Vercel Serverless Functions + Upstash Redis + Magicline Open API** –
bewusst ohne Framework und (bis auf Dev-Tools) ohne npm-Dependencies.

## Was hier drin ist

| Bereich | Einstieg | Beschreibung |
|---|---|---|
| **Mitglieder-App** | `mitglieder.html` (`/`) | Vertrag, Termine, Check-in, Mitgliedskarte, Dokumente, Postfach, FINN-KI-Coach, Fortschritt/Vitalpunkte, Training (Technogym-Inventar), Ernährung*, Community* — läuft im Browser **und** als Capacitor-App (iOS/Android) |
| **Team-Backend** | `team-backend.html` (`/team`) | Posteingang, Mitgliederverwaltung, Termine, Statistiken, Schichtplan, Leads, Rückholung, Moderation — rollenbasiert (admin/trainer) |
| **Live-Auslastung** | `widget.html`, `auslastung.html` | Anonyme Personenzahl als einbettbares Widget + „typische Auslastung"-Kurve |
| **APIs** | `api/**` | ~125 Serverless Functions (Mitglied, Team, Webhooks, interne Crons) |
| **Fachlogik** | `lib/**` | Sessions/Magicline (`members.js`), Team-Auth + Capabilities, Push (FCM/APNs), Inbox, Stripe-Premium, KI (`ai.js`), Social, Cron-Auth … |

\* Ernährung/Community sind über **serverseitige Feature-Flags** geschaltet
(`FEATURE_ERN`/`FEATURE_SOCIAL`, Produktion standardmäßig aus – siehe unten).

## Architektur

```
Browser / Capacitor-App
   │  (Bearer-Token, JSON)
   ▼
Vercel Serverless Functions (api/**)          ← Security-Header via vercel.json
   │            │              │
   ▼            ▼              ▼
lib/** ──► Upstash Redis   Magicline Open API   Dritt-Dienste (nur wo nötig):
(Fach-     (Sessions,      (Mitglieder,          Stripe (Premium-Abo),
 logik)     Push-Tokens,    Verträge,            Anthropic-KI (FINN),
            Inbox, Flags,   Check-ins,           Resend (E-Mail), Twilio/WA,
            Historie)       Termine)             Open Food Facts, FCM/APNs
```

- **Frontend:** je Bereich EINE HTML-Datei (Vanilla-JS-IIFE, Zustands-Objekt
  `S`, `render()`, delegierte Events, `esc()` gegen XSS). Kein Build-Schritt.
- **Single-Tenant:** eine Magicline-Instanz (`ML_TENANT`), ein Studio.
- **Sicherheitsmodell** (Sessions, Rollen-Matrix, Cron-Auth, Check-in,
  Push-Token-Bindung, Header/CSP): **[docs/SECURITY.md](docs/SECURITY.md)**
- **Seitengrößen & Modularisierungs-Fahrplan:** [docs/PERFORMANCE.md](docs/PERFORMANCE.md)
- Weitere Doku: `docs/STRIPE-PREMIUM.md` (Premium-Abo), `docs/EIGENE-APP.md`
  (Capacitor), `docs/COMMUNITY-RECHT.md`, `docs/NUTRITION-REZEPTE.md`,
  `docs/OPEN-FOOD-FACTS.md`, `docs/CUSTOM_DOMAIN.md`

## Lokal entwickeln

```bash
git clone <repo> && cd anwesend
cp .env.example .env        # Werte eintragen – NIEMALS committen
npm start                   # Node-Server (server.js) für das Auslastungs-Widget
# Frontends sind statische Dateien – z. B.:  npx serve .
```

Die meisten `api/`-Funktionen brauchen echte Zugangsdaten (Magicline, Redis).
Ohne sie melden die Module sauber „not_configured"/„unavailable" statt zu
crashen. Für UI-Arbeit genügt es, die HTML-Dateien statisch auszuliefern und
`/api/**` im Browser/Playwright zu mocken (so arbeiten auch die E2E-Tests).

## Tests & Checks

```bash
npm run lint    # Syntax-Check aller JS-Dateien + JSON-Konfigurationen
npm run scan    # Secret-Scan über alle versionierten Dateien
npm test        # Node-Harnesses in tests/ (ohne Netz, ohne echte Secrets)
npm run check   # alles zusammen – läuft auch in GitHub Actions (ci.yml)
```

Abgedeckt u. a.: Widerruf (Erfolg/Fehler/Timeout), Nummern-Login-Härtung,
Server-Logout + Session-Revoke, Push-Token-Rebinding, Check-in-Prüfungen,
Team-Capabilities (403-Fälle), Cron-Auth (fehlend/falsch/gültig),
Security-Header, Feature-Flags/Demo-Opt-in.

## Deployment (Vercel)

1. Repo mit Vercel verbinden (Preset *Other*, kein Build-Command).
2. Environment-Variablen setzen — vollständige, kommentierte Liste in
   **[.env.example](.env.example)**. Minimum für den Mitglieder-Bereich:
   `ML_TENANT`, `ML_API_KEY`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`;
   für interne Crons **Pflicht**: `CRON_SECRET` (fail-closed, siehe
   docs/SECURITY.md §3).
3. Routing/Sicherheits-Header kommen aus `vercel.json` (`/` → Mitglieder,
   `/team` → Team-Backend, `/auslastung` + `/widget.html` → Auslastung).
4. Cron-Jobs (Nudges, Erinnerungen, Historie) rufen die internen Endpunkte
   mit `Authorization: Bearer $CRON_SECRET` auf.

### Feature-Flags (Staging → Produktion)

`/api/app-info` liefert `features:{ern,social,demo}` aus `FEATURE_ERN`,
`FEATURE_SOCIAL`, `FEATURE_DEMO` (jeweils `1` = an, alles andere = aus).
Demo-Daten (`FEATURE_DEMO`, `SOCIAL_DEMO` = Demo-Buddy „TEST99") sind in
Produktion **standardmäßig deaktiviert** und nur fürs Staging gedacht.

## Live-Auslastung (ursprünglicher Kern)

Ein kleiner Proxy hält den Magicline-Key serverseitig, fragt höchstens alle
45 s ab und liefert eine **anonyme, aggregierte** Zahl:

```json
{ "count": 5, "max": 80, "percent": 6, "status": "low", "updatedAt": "…", "cached": true }
```

- Ampel-Schwellen über `YELLOW_AT`/`RED_AT`; Kapazität über `MAX_CAPACITY`.
- „Typische Auslastung": `/api/record` (Cron, **Secret Pflicht**) schreibt
  Slots nach Redis (`typical:sum/cnt:{wd}`), `/api/typical` liefert die
  Kurve; gleitender Schnitt via `TYPICAL_MAX_SAMPLES`; einmaliger Seed aus
  `data/baseline.json` über `/api/seed` (Secret Pflicht).
- Alternativ als Docker/VPS-Variante über `server.js` (`PORT`, Reverse-Proxy
  mit HTTPS davor).

## Sicherheit / DSGVO (Kurzfassung)

- Alle Zugriffs- und Berechtigungsprüfungen serverseitig; Client trifft
  keine Sicherheitsentscheidungen ([docs/SECURITY.md](docs/SECURITY.md)).
- Datenminimierung gegenüber der KI: nur Vorname + fachlich nötige,
  aggregierte Daten – kein Nachname, keine Mitgliedsnummer, keine
  Bank-/Adressdaten.
- Private API-Antworten mit `Cache-Control: private, no-store`; global
  `nosniff` + Referrer-Policy; CSP zunächst Report-Only (Begründung und
  Fahrplan in docs/SECURITY.md §6).
- `.env` ist gitignored; `.env.example` enthält keine echten Werte; CI
  führt einen Secret-Scan aus.
- Auslastungs-Widget liefert ausschließlich anonyme Aggregate.
