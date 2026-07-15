# Premium-Abo fürs Ernährungsmodul (Stripe) — Einrichtung

Das Ernährungsmodul ist **Freemium**: Basis-Funktionen sind gratis, die teuren
KI-Funktionen kosten **4,99 €/Monat** mit **7 Tagen Gratis-Test**. Abgerechnet
wird über **Stripe** (Stripe-hosted Checkout — die App sieht **nie** Kartendaten).
Verkauft wird nur an eingeloggte Fit-Inn-Mitglieder.

> **Solange Stripe nicht eingerichtet ist, passiert nichts:** ohne
> `STRIPE_SECRET_KEY` + `STRIPE_PRICE_ID` meldet die Abrechnung `not_configured`
> und das Modul läuft komplett gratis weiter. Du kannst also erst alles testen
> und Premium später scharf schalten.

---

## Was ist gratis, was ist Premium?

| Gratis (Basis) | Premium (KI) |
|---|---|
| Mahlzeiten manuell loggen | 📸 Foto-Analyse (Teller scannen) |
| Barcode-Scan + Produktsuche (Open Food Facts) | ✍️ Text-Schätzung („2 Brötchen mit Käse") |
| Wasser-Tracking, Tagesziel/Berechnung | 💬 FINN-Coach (Chat) |
| Verlauf, Favoriten | 🍳 KI-Rezepte / „aus dem Kühlschrank" |
| Kochbuch (feste Rezepte mit Fotos) | 🗓️ KI-Wochenplan + Einkaufsliste |
| Bearbeiten / Duplizieren / Nachtragen | 📈 Wochen-Auswertung mit Tipps |
| Fasten-Timer, Export, Löschen | |

Das **Gate sitzt serverseitig** (`api/member/nutrition.js`): auch wer die App
manipuliert, bekommt ohne gültiges Abo `premium_required` zurück. Die einzige
Ausnahme ist die **Sicherheits-/Krisen-Antwort** von FINN — die kommt immer,
auch für Gratis-Nutzer.

---

## Schritt für Schritt (einmalig)

### 1. Produkt + Preis in Stripe anlegen
1. In [dashboard.stripe.com](https://dashboard.stripe.com) einloggen (oben
   **Testmodus** an, solange du testest).
2. **Produktkatalog → + Produkt hinzufügen**
   - Name: `Fit-Inn Ernährung Premium`
   - Preismodell: **Wiederkehrend**, **monatlich**, **4,99 €** (Währung EUR).
   - MwSt: In Deutschland ist der Bruttopreis anzugeben. Optional **Stripe Tax**
     aktivieren, damit die USt automatisch berechnet/ausgewiesen wird.
3. Speichern. Beim erstellten **Preis** die ID kopieren → beginnt mit `price_…`
   → das ist `STRIPE_PRICE_ID`.

### 2. API-Key holen
- **Entwickler → API-Keys → Geheimer Schlüssel** → `sk_test_…` (Test) bzw.
  `sk_live_…` (Live) → das ist `STRIPE_SECRET_KEY`. **Niemals** ins Repo!

### 3. Webhook-Endpoint registrieren
1. **Entwickler → Webhooks → Endpunkt hinzufügen**
2. Endpunkt-URL: `https://DEINE-DOMAIN/api/webhooks/stripe`
   (z. B. `https://mitglieder.fit-inn-trier.de/api/webhooks/stripe`)
3. Diese Events auswählen:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid` (bzw. `invoice.payment_succeeded`) — Verlängerung/Recovery
   - `invoice.payment_failed`
4. Endpunkt anlegen, dann **Signing secret** kopieren → `whsec_…`
   → das ist `STRIPE_WEBHOOK_SECRET`.

> Der Webhook ist die **einzige** Stelle, die Premium freischaltet/entzieht.
> Der Client kann den Status nicht selbst setzen. Ohne gültige Signatur
> antwortet der Endpunkt mit `400`.
>
> **Robustheit (bereits im Code):** jede `event.id` wird nur **einmal**
> verarbeitet (Idempotenz, 72 h), doppelte/verspätete Zustellungen ändern nichts.
> Schlägt der Store-Schreibvorgang fehl, antwortet der Endpunkt mit `500` und
> Stripe stellt automatisch **erneut** zu (statt den Status stillschweigend zu
> verlieren). Die API-Version ist fest auf `2024-06-20` gepinnt
> (`STRIPE_API_VERSION`), damit das Feld-Schema vorhersehbar bleibt.

### 4. Billing-Portal aktivieren (Kündigen/Zahlungsdaten ändern)
- **Einstellungen → Billing → Kundenportal**: aktivieren und erlauben, dass
  Kunden das Abo **kündigen** und Zahlungsdaten ändern können. Über dieses
  Portal läuft „Abo verwalten / kündigen" in der App.

### 5. Environment-Variablen setzen (Vercel)
In Vercel → Project → **Settings → Environment Variables** (siehe auch
`.env.example`):

| Variable | Wert | Pflicht |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` (bzw. `sk_test_…`) | ✅ |
| `STRIPE_PRICE_ID` | `price_…` (4,99 €/Monat) | ✅ |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | ✅ (für Freischaltung) |
| `STRIPE_TRIAL_DAYS` | `7` | – (Default 7) |
| `STRIPE_API_VERSION` | `2024-06-20` | – (Default gepinnt) |
| `APP_BASE_URL` | `https://mitglieder.fit-inn-trier.de` | empfohlen |

`APP_BASE_URL` bestimmt, wohin Stripe nach Checkout/Portal zurückleitet
(`…/mitglieder?ern_premium=success|cancel|portal`). Fehlt sie, wird sie aus dem
Request-Host abgeleitet — bei Custom-Domain lieber explizit setzen.

> **Harte Zusatz-Abhängigkeit: Upstash/Redis.** Der Premium-Status (Entitlement)
> und die Idempotenz-Sperre liegen im KV-Store. Ohne ihn kann der Webhook nichts
> persistieren und die Abrechnung meldet `unavailable`. Die Variablen
> (`KV_REST_API_URL`/`KV_REST_API_TOKEN` bzw. `UPSTASH_REDIS_REST_URL`/`_TOKEN`)
> legt die Vercel/Upstash-Integration i. d. R. **automatisch** an — vor dem
> Livegang prüfen, dass sie in der Produktion gesetzt sind.

Nach dem Setzen: **neu deployen**, damit die Variablen greifen.

---

## Go-Live-Checkliste (abhaken)

Technik ist fertig — das hier ist die reine Konfig-/Betriebs-Abfolge:

- [ ] **Stripe-Produkt/Preis** live angelegt: `Fit-Inn Ernährung Premium`,
      wiederkehrend monatlich **4,99 € EUR** → `STRIPE_PRICE_ID` (`price_…`) notiert.
- [ ] **Live-Secret-Key** geholt (`sk_live_…`) → `STRIPE_SECRET_KEY`.
- [ ] **Webhook-Endpoint** `https://mitglieder.fit-inn-trier.de/api/webhooks/stripe`
      registriert mit **6 Events** (checkout.session.completed,
      customer.subscription.created/updated/deleted, **invoice.paid**,
      invoice.payment_failed) → `STRIPE_WEBHOOK_SECRET` (`whsec_…`) notiert.
- [ ] **Kundenportal** in Stripe aktiviert (Kündigen + Zahlungsdaten ändern).
- [ ] **Upstash/KV** in der Produktion vorhanden (Entitlement-Store) — geprüft.
- [ ] Die **5 Env-Vars** in Vercel (Production) gesetzt (Tabelle oben) und
      **neu deployed**.
- [ ] **Test-Modus zuerst:** mit Test-Keys + Testkarte den Flow durchgespielt
      (siehe „End-to-End testen") → Premium schaltet, Portal kündigt.
- [ ] **Auf Live umgestellt:** Live-Keys eingetragen, erneut deployed, **ein**
      echter Kauf (ggf. sofort im Portal gekündigt) als finaler Rauch-Test.
- [ ] **Rechtliches** erledigt (siehe unten): §312j-Button, Preis inkl. MwSt +
      Laufzeit + Kündigung, Widerruf, AGB/Datenschutz um „Premium/Stripe" ergänzt.

---

## End-to-End testen (Stripe-Testmodus) — abhaken

1. Testmodus in Stripe an, Test-Keys in Vercel (Preview) hinterlegen.
2. Testkarte: **`4242 4242 4242 4242`**, beliebiges künftiges Datum, beliebige
   CVC/PLZ. (Weitere Testkarten: [stripe.com/docs/testing](https://stripe.com/docs/testing).)

- [ ] **Checkout:** Im Member-Portal Premium starten → Stripe-Checkout öffnet sich
      → mit Testkarte bezahlen. Rückkehr `?ern_premium=success` → die App **pollt**
      kurz und zeigt „Premium aktiviert" **automatisch** (kein manueller Reload).
- [ ] **Freischaltung:** KI-Funktionen (Foto, FINN-Chat, Rezepte) sind frei;
      Entitlement `nutri:prem:<memberId>` steht auf `trialing`/`active`.
- [ ] **Verlängerung/Recovery (optional):** In Stripe eine Rechnung als bezahlt
      simulieren → `invoice.paid` → Status bleibt/`active`, `until` verlängert.
      Zahlung fehlschlagen lassen → `invoice.payment_failed` → `past_due`; danach
      erfolgreiche Zahlung → wieder `active`.
- [ ] **Kündigen:** Im Stripe-Kundenportal (App: „Abo verwalten / kündigen")
      kündigen → `customer.subscription.deleted` → Entzug nach Periodenende.
- [ ] **Webhook-Log grün:** **Entwickler → Webhooks → Endpunkt → „Letzte
      Ereignisse"** zeigt `200` (bzw. `dedup:true` bei Wiederholung). Ein Event
      kann man dort auch **erneut senden** — der Status bleibt idempotent gleich.

Automatisierte Prüfungen liegen unter `scratchpad/` (Entwicklung): der
Node-Harness `stripe-webhook.test.js` fährt den echten Webhook mit signierten
Events (Signatur, Idempotenz, item-level Periodenende, invoice.paid→active,
Kündigung, past_due, Store-Fehler→500) durch; `ern-billing.pw.js` prüft den
Frontend-Flow (dynamischer Preis, Checkout-Wiring, Erfolgs-Polling).

Der Test-Zugang der App (Modul versteckt) funktioniert unabhängig: In der App
7× auf das Datum tippen (setzt `localStorage.fi_ern_test`). Das entsperrt nur
die **Sichtbarkeit** des Moduls, nicht Premium — Premium hängt allein am Abo.

---

## Wie es intern funktioniert (Kurzüberblick)

- `lib/stripe.js` — schlanker `fetch`-Client (kein npm-SDK): Checkout-/Portal-
  Session anlegen, Webhook-Signatur prüfen (`t=…,v1=…`, HMAC-SHA256, 5-Min-Toleranz).
- `lib/entitlements.js` — liest/schreibt `nutri:prem:<memberId>` in Upstash;
  `isPremium()` = `tier=premium` UND Status `active`/`trialing` UND Periode nicht abgelaufen.
- `api/member/nutrition-billing.js` — `POST {action:'checkout'|'portal'|'status'}`
  (Bearer-Auth). Legt Checkout-/Portal-Sessions an, gibt eine `url` zurück.
- `api/webhooks/stripe.js` — empfängt die Stripe-Events und setzt/entzieht das
  Entitlement. **Idempotent** (jede `event.id` nur einmal, 72 h), robustes
  Periodenende (`until` auch aus item-level `current_period_end`, nie unbegrenzt),
  behandelt `invoice.paid` (Recovery/Verlängerung). Bei Store-Fehler `500` →
  Stripe-Retry; sonst `200`.
- `api/member/nutrition.js` — serverseitiges Gate + `buildState` liefert dem
  Frontend `premium`, `tier`, `trialing`, `premiumUntil` **und `premiumInfo`**
  (Preis/Trial aus Stripe, gecacht → dynamische UI-Copy statt hartcodiert).

**DSGVO:** Beim „alle Ernährungsdaten löschen" wird das **Abo NICHT** gekündigt
(das ist Abrechnungsstatus, kein Ernährungsdatum). Kündigung läuft ausschließlich
über das Stripe-Portal; Rechnungs-/Zahlungsdaten liegen bei Stripe.

---

## Premium-Vorschau ohne Stripe (Team-Backend)

Zum Prüfen der kostenpflichtigen Inhalte – oder um einem Mitglied kulanzweise
freizuschalten – kann ein **Admin** im Team-Backend (Mitglieds-Profil → Karte
„🔓 Ernährungs-Premium (Vorschau)") mit einem Klick Premium aktivieren, **ohne
echtes Abo**.

- Endpunkt `api/team/nutrition-preview.js` (`POST {id, action:'grant'|'revoke'}`,
  nur Admin) schreibt ein ganz normales Entitlement `nutri:prem:<id>`, nur markiert
  mit **`source:'team_preview'`** und auf **180 Tage** befristet (`until`). Dadurch
  greifen **alle bestehenden Gates automatisch** – kein Sondercode im Gate nötig.
- **Ein echtes Stripe-Abo wird nie angetastet:** `revoke` löscht nur `team_preview`-
  Einträge (sonst `409`); `grant` auf ein aktives echtes Abo lehnt ab (`409`).
- Beim echten Launch ist die Vorschau **bedeutungslos**: der Stripe-Webhook
  überschreibt den Eintrag mit den echten Abo-Daten, und die 180-Tage-Frist läuft
  ohnehin von selbst aus. Zum Beenden genügt „Vorschau beenden" im Team-Backend.

---

## Noch von dir/rechtlich zu erledigen (kein Code)

Für ein **B2C-Abo in Deutschland/EU** brauchst du zusätzlich zum Technischen:
- **Button-Lösung (§ 312j BGB):** die Bestell-Schaltfläche muss klar
  „zahlungspflichtig bestellen" o. Ä. sagen (Stripe-Checkout erfüllt das im
  Zahlschritt; die eigene Upgrade-Seite verweist bewusst neutral auf Stripe).
- **Preisangabe inkl. MwSt**, Laufzeit, Kündigungsfrist, automatische Verlängerung.
- **Widerrufsrecht** + bei digitalen Diensten die Einwilligung zum sofortigen
  Start und Hinweis auf das Erlöschen des Widerrufsrechts.
- **AGB + Datenschutzerklärung** um den Punkt „Premium/Zahlung über Stripe" ergänzen.
- **Umsatzsteuer** auf digitale Leistung korrekt behandeln (mit Steuerberater;
  optional Stripe Tax).

Stripe deckt **Zahlung, PCI-Konformität und Rechnung** ab — die **Vertragstexte**
(Widerruf/AGB/Datenschutz) musst du ergänzen und rechtlich prüfen lassen.

---

## Preis-Empfehlung (zur Erinnerung)

- **4,99 €/Monat, 7 Tage gratis** — unter MyFitnessPal Premium, auf Höhe von
  YAZIO/Lifesum. Positionierung: „Dein KI-Ernährungscoach — Foto scannen, FINN
  fragen, Wochenplan. 7 Tage gratis, dann 4,99 €/Monat."
- Ertrag je Abo grob: 4,99 € brutto − ~0,80 € MwSt − ~0,32 € Stripe-Gebühr
  ≈ **~3,87 €/Monat** (Richtwert; mit Steuerberater bestätigen).
- Später optional Jahresabo (~39,99 €/Jahr) — jetzt bewusst nur Monatsabo.
- Zum Ändern des Preises: neuen Preis in Stripe anlegen und `STRIPE_PRICE_ID`
  umsetzen (bestehende Abos behalten ihren alten Preis, bis migriert wird).
