# Sicherheitsmodell

Stand: Branch `improve/security-stability`. Dieses Dokument beschreibt, wie
Authentifizierung, Autorisierung und Missbrauchsschutz in diesem Projekt
funktionieren – und welche Migrationen bewusst geplant, aber noch nicht
umgesetzt sind.

Grundsatz: **Der Client trifft keine Sicherheitsentscheidungen.** Alle
Prüfungen (Sitzung, Vertrag, Rolle/Capability, Rate-Limits, Cron-Secrets)
laufen serverseitig in `api/` + `lib/`.

---

## 1. Sitzungen

| | Mitglieder | Team |
|---|---|---|
| Key im Store | `msess:<token>` | `tsess:<token>` |
| Token | `crypto.randomBytes(32)` hex | `crypto.randomBytes(32)` hex |
| Lebensdauer | 30 Tage nur nach **verifiziertem** Login (E-Mail-/WhatsApp-Code, Apple/Google); wissensbasierter Login (Mitgliedsnummer + Geburtsdatum) max. **24 h** („angemeldet bleiben") bzw. 30 min | 12 h (`TEAM_SESSION_TTL`) |
| Transport | `Authorization: Bearer <token>` | `Authorization: Bearer <token>` |
| Ablage im Client | `localStorage` (Web) bzw. Capacitor-WebView-Storage (App) | `localStorage` |
| Server-Logout | `POST /api/member/logout` – widerruft die Sitzung in Redis (DEL), meldet optional den Push-Token ab, ist idempotent und loggt keine Tokens | `POST /api/team/logout` (analog) |

Die Logout-Buttons in Web, Team-Backend und App rufen **zuerst** den
Server-Logout auf (keepalive) und löschen erst danach die lokalen Daten –
eine gestohlene Sitzung bleibt damit nicht serverseitig gültig.

### Geplante Migration: HttpOnly-Cookies

Bearer-Token in `localStorage` sind für XSS lesbar. Die Migration auf
`HttpOnly`/`Secure`/`SameSite=Lax`-Cookies ist vorbereitet, aber **bewusst
nicht in diesem Branch** umgesetzt, weil die Capacitor-App die API von einem
anderen Origin (capacitor://) aufruft und Cookie-Login dort ohne zusätzliche
Arbeit brechen würde. Pfad:

1. Server setzt beim Login zusätzlich ein `HttpOnly`-Cookie und akzeptiert
   Cookie ODER Bearer (Doppelbetrieb).
2. Web-Client (gleicher Origin) stellt auf Cookie um, hört auf, das Token in
   `localStorage` zu legen; CSRF-Schutz über `SameSite=Lax` + Custom-Header.
3. Native App bleibt auf Bearer, legt das Token aber in sicheren
   Gerätespeicher (Capacitor SecureStorage/Keychain) statt WebView-Storage.
4. Danach Bearer-über-localStorage im Web abschalten.

### Wissensbasierter Login (Mitgliedsnummer + Geburtsdatum)

`api/member/login-number.js` ist gehärtet (strikte Normalisierung/Validierung,
Rate-Limit pro IP **und** pro Nummer, generische Fehlermeldung ohne
Enumeration, kurze Sitzungsdauer). Er bleibt trotzdem wissensbasiert –
Mitgliedsnummer + Geburtsdatum sind keine Geheimnisse im starken Sinn.
**Empfohlener Ausbau:** ein Besitz-Nachweis als zweiter Schritt (OTP per
E-Mail/WhatsApp an die im System hinterlegte Adresse/Nummer – die Bausteine
existieren bereits im Code-Login) oder eine einmalige Geräte-Aktivierung im
Studio. Bis dahin gilt: kurze TTL, keine 30-Tage-Sitzung über diesen Weg.

---

## 2. Rollen & Capabilities (Team-Backend)

Jeder Team-Endpunkt prüft nach der Sitzungs-Prüfung eine explizite
Capability (`lib/capabilities.js`, `requireCap(sess, '<cap>', res)`).
Fehlende Berechtigung ⇒ `403`.

| Capability | Bedeutung | admin | trainer |
|---|---|:---:|:---:|
| member.read | Mitglieder suchen/ansehen, Dubletten | ✅ | ✅ |
| member.write | Stammdaten, Tags, Zugangsmedien, Pausen | ✅ | ✅ |
| documents.read | Dokumente/PDF-Bestätigungen ansehen | ✅ | ✅ |
| documents.write | Dokumente hochladen/ans Mitglied senden | ✅ | ✅ |
| checkin.manage | Check-in-Verlauf, Anwesenheitsbestätigungen | ✅ | ✅ |
| training.manage | Trainingspläne des Mitglieds | ✅ | ✅ |
| nutrition.manage | Ernährungsdaten/Coaching | ✅ | ✅ |
| conversations.manage | Posteingang, Snippets, Smart-Reply | ✅ | ✅ |
| appointments.manage | Termine ansehen/buchen/absagen | ✅ | ✅ |
| shifts.manage | Schichtplan, Tausch, Team-Chat | ✅ | ✅ |
| todos.manage | interne Aufgabenliste | ✅ | ✅ |
| content.manage | Hilfe-Artikel pflegen | ✅ | ✅ |
| **admin.manage** | Statistiken, Broadcast/Direktnachricht, Leads, KI-Assistent, Rückholung/Churn, Community-Moderation, Impersonation, Mahnliste, Premium-Gratis-Schaltung | ✅ | ❌ |

Alt-Sitzungen ohne Rolle (Passwort-Login) gelten als `admin` – das ist der
Bestands-Inhaber-Login. Unbekannte Rollen erhalten **keine** Capabilities.

### Geplante Migration: persönliche Konten + MFA

Der geteilte Passwort-Login (`TEAM_PASSWORD`) ist eine Übergangslösung.
Trainer-Logins laufen bereits personalisiert über E-Mail-Codes echter
Mitarbeiter. Plan:

1. Auch den Inhaber-/Admin-Zugang auf ein persönliches Mitarbeiter-Konto
   mit E-Mail-Code umstellen (Infrastruktur vorhanden).
2. Zweiten Faktor ergänzen (TOTP oder WebAuthn/Passkey).
3. `TEAM_PASSWORD` entfernen; Alt-Sitzungen ohne Rolle laufen nach 12 h aus.
4. Audit-Log je Mitarbeiter (wer hat welches Mitglied geöffnet/geändert).

---

## 3. Interne/Cron-Endpunkte

`lib/cronAuth.js` – für `/api/nudge`, `/api/record`, `/api/plan-remind`,
`/api/social-remind`, `/api/nutrition-impulse`, `/api/winback-autopilot`,
`/api/seed`, `/api/admin/off-warmup`:

- Secret ist **Pflicht**: ohne konfiguriertes Secret ⇒ `503` (fail-closed,
  kein „offener Modus").
- Secret ausschließlich per `Authorization: Bearer <secret>` – **nie** als
  Query-Parameter (landet sonst in Logs/Verläufen).
- Vergleich mit `crypto.timingSafeEqual`.
- Der Header `x-vercel-cron` wird **nicht** als Nachweis akzeptiert (von
  jedem Aufrufer frei setzbar).
- Env-Auflösung: `CRON_SECRET` (zentral), `RECORD_SECRET` (Bestands-Alias),
  je Endpunkt optional `WINBACK_SECRET` / `SEED_SECRET` / `OFF_WARMUP_KEY`.

Vercel-Cron-Jobs müssen den Header mitschicken (Cron-Konfiguration →
benutzerdefinierter Header bzw. Aufruf über einen Wrapper).

---

## 4. Check-in

`api/member/checkin.js` – serverseitige Pflicht-Prüfungen:

1. gültige Mitglieder-Sitzung (Bearer),
2. Vertrag **ladbar und aktiv** (nicht ladbar ⇒ Ablehnung, fail-closed),
3. Wiederholungs-/Missbrauchsschutz (3 / 30 min und 8 / Tag je Mitglied).

Entfernt: der `?nfc=1`-URL-Bypass im Client (ein NFC-Tag/Link löst keinen
Check-in mehr automatisch aus, er öffnet nur den Check-in-Screen) und jeder
client-seitige Standort-„Nachweis" als Sicherheitsmerkmal.

### Bewusst offen: signierte Kurzzeit-Challenge (QR/NFC)

Ein wirklich belastbarer Anwesenheits-Nachweis braucht einen **studioseitigen
Generator**, den es derzeit nicht gibt. Bewusst wurde KEIN unsicherer Ersatz
(statische Codes, Mitgliedsnummer-Fallback, Client-Geolocation) eingebaut.
Ziel-Design, sobald Hardware/Anzeige im Studio verfügbar ist:

- Ein Gerät im Studio (Display/NFC-Tag mit E-Ink/Controller) zeigt einen
  **kurzlebigen, signierten, idealerweise einmaligen** Code:
  `base64(exp‖nonce‖HMAC(secret, exp‖nonce))`, Gültigkeit ~30–60 s.
- Die App scannt/liest den Code und sendet ihn mit dem Check-in-Request.
- Der Server prüft HMAC + Ablauf und entwertet die Nonce in Redis
  (`SETNX ci:nonce:<nonce>` mit TTL) ⇒ Einmal-Verwendung.
- Secret nur serverseitig + im Generator; Rotation über Key-ID im Code.

---

## 5. Push-Tokens

`lib/push.js`: Ein Gerät (Token) gehört zu **genau einem** Konto. Bei der
Registrierung wird der bisherige Besitzer (Mitglied **oder** Team-Pool) im
selben Redis-Pipeline-Batch entfernt, dann neu gebunden (idempotent; auch
bei Konto-Wechsel auf demselben Gerät). Logout meldet den Token serverseitig
ab. Push-Texte enthalten keine vertraulichen Inhalte (keine Vertrags-,
Gesundheits- oder Zahlungsdetails, keine Betreffzeilen privater Vorgänge)
– auf dem Sperrbildschirm steht nur ein generischer Hinweis.

---

## 6. Browser-/API-Härtung

`vercel.json` (siehe `tests/headers.test.js`):

- global: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`
- `/api/*`: `Cache-Control: private, no-store` (zusätzlich setzen es die
  Member-/Team-Handler selbst)
- App-Seiten: `Permissions-Policy` (Kamera/Mikro/Standort nur self), Frame-Schutz
  über CSP `frame-ancestors 'self'` (Widget/Auslastung ausgenommen – einbettbar)
- CSP läuft als **Content-Security-Policy-Report-Only**: Die App besteht aus
  großen Inline-Skripten; eine scharfe CSP würde sie sofort brechen. Weg zur
  scharfen CSP: Report-Only-Verstöße sammeln → Inline-Code in Module
  auslagern (siehe docs/PERFORMANCE.md) → Nonce-basierte `script-src` →
  Report-Only durch Enforcement ersetzen. Berücksichtigt: reCAPTCHA,
  Google Fonts.

## 7. Weitere Bausteine

- **Rate-Limits** (`M.rateLimit`, Redis INCR+EXPIRE): Logins (IP + Nummer),
  Widerruf/Kündigung (3 / 5 min je Sitzung), Check-in, KI-Chats u. a. –
  Ergebnisse werden immer ausgewertet (kein „fire and forget").
- **Keine Debug-Daten in Antworten** (`_debug` entfernt); Fehler-Logs ohne
  personenbezogene Kennungen; Sitzungstokens werden nie geloggt.
- **Generische Fehlermeldungen** bei Logins (keine Konto-Enumeration).
- **Secrets**: nur über Env-Variablen (`.env` ist gitignored,
  `.env.example` enthält keine echten Werte); CI führt einen Secret-Scan
  über alle versionierten Dateien aus (`npm run scan`).
- **Feature-/Demo-Flags** serverseitig (`/api/app-info`, FEATURE_*): Demo-
  Daten und Testmodi sind in Produktion standardmäßig deaktiviert.
- **Fehlermeldungen vom Gerät** (`POST /api/member/client-error`,
  `POST /api/team/client-error`): JavaScript-Fehler aus App und Team-Backend
  landen in den Vercel-Laufzeitlogs, statt unbemerkt zu bleiben. Beide
  Endpunkte verlangen eine gültige Sitzung, sind auf 20/h je Sitzung begrenzt
  und **speichern nichts**. `lib/clientErrors.js` maskiert vor dem Loggen
  Tokens, AWS-/Stripe-Schlüssel, E-Mail-Adressen, IBAN, Telefon- und
  Mitgliedsnummern, eingebettete Bilder sowie Adress-Parameter; die
  Mitglieds- bzw. Mitarbeiter-Kennung wird nicht mitgeschrieben. Der Client
  meldet höchstens 5 Fehler je Sitzung, damit eine Fehlerschleife die Logs
  nicht flutet. Der Team-Endpunkt trägt bewusst keine Capability (wie
  `login`/`logout`/`me`/`push`): ein Rechte-Gate würde ausgerechnet die
  Fehler verschlucken, die es zu sehen gilt.

## 8. Tests

`npm run check` = Syntax-Lint aller JS/JSON **einschließlich des Inline-JS
der beiden Oberflächen-Dateien** und der `data-act`-Klickziele
(`scripts/uilint.js`) + Secret-Scan + `tests/*.test.js` (ohne Netz/echte
Secrets): Widerruf, Nummern-Login, Logout/Revoke, Push-Token-Rebinding,
Check-in, Team-Capabilities (verbotene Zugriffe je Rolle), Cron-Auth
(fehlend/falsch/gültig), Security-Header, Feature-Flags, Maskierung der
Gerätefehler (`client-errors`) sowie ein Browser-Smoke über alle Screens
(`ui-smoke`, überspringt sich ohne Playwright).
