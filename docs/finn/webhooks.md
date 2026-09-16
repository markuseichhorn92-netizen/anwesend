# FINN · Webhooks und Event Bus

## 1. Bestehender Empfänger (bleibt unverändert im Kern)

- Datei: `api/webhooks/magicline.js`, Export `handleWebhook(req, res, { key })`.
- Routen (`vercel.json`): `/mlhook/:key` und `/api/webhooks/ml/:key` →
  `/api/webhooks/magicline?key=:key`.
- Auth: Shared Secret `MAGICLINE_WEBHOOK_KEY` (kommagetrennt mehrere erlaubt),
  Reihenfolge Pfad → Header (`x-api-key`, `x-webhook-secret`, `x-magicline-secret`) → `?key=`.
  Zeitkonstanter Vergleich. Kein Secret → 503, falscher Key → 401 + Zähler `_AUTH_REJECTED`.
- Body-Formate: Einzel-Event, `{events:[]}`, `{notifications:[]}`, Array; max. 50 Events.
- Diagnose: `GET …?health=1` → `{ stats, feedReady, feed }`. **Muss erhalten bleiben** – FINN
  ergänzt nur einen Block `finn` (siehe unten).
- Antwort immer `200 { ok, handled, summary:[{type, action}] }`.

### Behandelte Events (bestehend)

| Event | Bestehende Aktion | Idempotent? |
|---|---|---|
| `CONTRACT_CREATED` | `welcome.sendAccessInfoOnce` (SET NX `welcomed:<id>`), `newMembers.recordJoin` | Mail ja, Liste erst beim Lesen dedupliziert |
| `APPOINTMENT_BOOKING_CREATED/UPDATED` | `mlEvents.upsertAppointment` | ja (SET auf bookingId) |
| `APPOINTMENT_BOOKING_CANCELLED` | `mlEvents.removeAppointment` | ja |
| `CUSTOMER_CHECKIN` | `mlEvents.recordCheckin` (LPUSH + SADD present) | **nein** (LPUSH dupliziert) |
| `CUSTOMER_CREATED` | `leadflow.recordLead` | ja (phone/customerId) |
| `CUSTOMER_PAYMENT_REJECTED` | Studio-Mail | **nein** (Mail je Zustellung) |
| `CONTRACT_CANCELLED` / `CONTRACT_REVERSED` | Studio-Mail | **nein** |
| `STUDIO_OPENING_HOURS_UPDATED`, `EMPLOYEE_*` | quittiert | – |

Befund: **Es gab keinen Replay-Schutz je Event** und keine Signaturprüfung
(Magicline liefert keine HMAC-Signatur; das Secret im Pfad ist der Schutz).

## 2. FINN Event Bus (`lib/finn/events.js`)

Der Bus liegt **vor** der bestehenden Verarbeitung und wrappt sie:

1. `ingest(event)` bildet eine Event-Kennung: `event.id` / `eventId` / `uuid`,
   sonst `sha1(type + entityId + timestamp)`. Fehlt jedes zeitliche Merkmal
   (kein Timestamp, keine Id), wird **nicht** dedupliziert (`dedup:'none'`),
   damit zwei echte Check-ins derselben Person nicht verschluckt werden.
2. `SET finnev:seen:<id> NX EX 7d` – existiert der Key, gilt das Event als
   **Duplikat**: bestehende Handler laufen dann nicht erneut (schützt vor
   doppelten Mails und doppelten Check-in-Einträgen), Antwort `action:'duplicate'`.
3. Unbekannte Typen werden als `unknown` protokolliert, korrupte Events
   (kein Typ, kein Objekt) als `corrupt` – immer mit 200 beantwortet.
4. Nach der bestehenden Verarbeitung ruft der Bus die **Automationen**
   (`lib/finn/automations.js`) auf. Ein Fehler dort ändert nichts am Ergebnis
   der Bestandsverarbeitung.
5. Protokoll: `finnev:log` (LIST, 500 Einträge) mit `{ id, type, cid, at, action, dup }`,
   Zähler `finnev:stat:*`. Ohne KV: kein Dedup, aber die Verarbeitung läuft wie bisher.

`?health=1` liefert zusätzlich `finn: { events:{ seen, duplicates, unknown, errors, last:[…] }, capabilities }`.

## 3. Automationen (`lib/finn/automations.js`)

Alle Automationen sind **zusätzlich** zu den Bestandsaktionen, schreiben nur in
den eigenen KV (Timeline/CRM), nie in Magicline, und verschicken keine
zweite Mail. Über `FINN_AUTOMATIONS` (kommagetrennt, Standard: alle Timeline-
Einträge; Vorgänge nur mit `vorgang`) steuerbar.

| Event | Automation |
|---|---|
| `CONTRACT_CREATED` | Timeline „Vertrag abgeschlossen", CRM-Merker `finn:onboarding:<cid>` |
| `CUSTOMER_PAYMENT_REJECTED` | Timeline + Retention-Signal `payment`; mit `vorgang`: Vorgang „Zahlungsproblem" (Priorität hoch) |
| `CONTRACT_CANCELLED` | Timeline + Retention-Signal `cancel`; mit `vorgang`: Vorgang „Rückholung" |
| `CONTRACT_REVERSED` | Timeline |
| `APPOINTMENT_BOOKING_*` | Timeline „Termin gebucht/geändert/storniert" |
| `CUSTOMER_CHECKIN` | Timeline „Check-in" (nur Zähler, kein Name) |
| `CUSTOMER_CREATED` | Timeline „Lead angelegt" |

## 4. Tests

`tests/finn-webhooks.test.js` prüft: gültiges Event → Bestandsaktion + Timeline,
Duplikat → keine zweite Aktion, unbekannter Typ → `unknown`, korrupter Body →
200 ohne Absturz, `health=1` enthält weiterhin `stats`/`feed` **und** `finn`.
