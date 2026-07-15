# Premium-Abo fürs Ernährungsmodul (Stripe) — Einrichtung

Das Ernährungsmodul ist **Freemium**: Basis-Funktionen sind gratis, die teuren
KI-Funktionen kosten **4,99 €/Monat** mit **7 Tagen Gratis-Test**. Abgerechnet
wird über **Stripe** — Kauf und Verwaltung laufen **in der App eingebettet**
(Stripe Embedded Checkout / Payment Element in einem Sheet), die App sieht dabei
**nie** Kartendaten. Angebotene Zahlungsarten steuerst du im **Stripe-Dashboard**.
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

### 4. Zahlungsarten aktivieren (alle gewünschten Methoden)
- **Einstellungen → Zahlungen → Zahlungsmethoden**: hier alle Methoden
  einschalten, die du anbieten willst (Karte ist Standard; zusätzlich z. B.
  **SEPA-Lastschrift**, **Apple Pay**, **Google Pay**, ggf. weitere).
- Der Code gibt **keine** feste Methodenliste vor: sowohl der **Kauf**
  (Embedded Checkout) als auch das **Karte-ändern**-Feld (Payment Element,
  `automatic_payment_methods`) zeigen **automatisch** genau die Methoden, die im
  Dashboard aktiv **und** für ein wiederkehrendes Abo geeignet sind. Du steuerst
  das Angebot also komplett über das Dashboard – ohne Redeploy.
- Hinweis: Für ein **Abo** erscheinen nur recurring-fähige Methoden. Apple/Google
  Pay laufen über Karte und tauchen automatisch auf passenden Geräten auf.

### 5. Billing-Portal aktivieren (nur noch Fallback)
- **Einstellungen → Billing → Kundenportal**: aktivieren und erlauben, dass
  Kunden das Abo **kündigen** und Zahlungsdaten ändern können.
- **Neu:** Kaufen, Kündigen/Reaktivieren, **Karte/Zahlungsart ändern** und
  **Rechnungen** laufen jetzt **direkt in der App** (Stripe Embedded Checkout +
  Payment Element). Das Hosted-Portal ist nur noch ein dezenter **Fallback-Link**
  – trotzdem aktiviert lassen.

### 6. Environment-Variablen setzen (Vercel)
In Vercel → Project → **Settings → Environment Variables** (siehe auch
`.env.example`):

| Variable | Wert | Pflicht |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` (bzw. `sk_test_…`) | ✅ |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_…` (bzw. `pk_test_…`) – öffentlich | ✅ (für In-App-Kauf) |
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
- [ ] **Veröffentlichbarer Live-Key** geholt (`pk_live_…`) → `STRIPE_PUBLISHABLE_KEY`
      (öffentlich, kein Geheimnis; nötig für den In-App-Kauf per Stripe.js).
- [ ] **Webhook-Endpoint** `https://mitglieder.fit-inn-trier.de/api/webhooks/stripe`
      registriert mit **6 Events** (checkout.session.completed,
      customer.subscription.created/updated/deleted, **invoice.paid**,
      invoice.payment_failed) → `STRIPE_WEBHOOK_SECRET` (`whsec_…`) notiert.
- [ ] **Zahlungsmethoden** in Stripe aktiviert (Einstellungen → Zahlungen →
      Zahlungsmethoden): Karte + gewünschte Extras (SEPA, Apple/Google Pay …).
      Erscheinen ohne Redeploy automatisch in Kauf **und** Karte-ändern.
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
- [ ] **In-App-Verwaltung:** der Abo-Bereich „Mein Ernährungs-Abo" ist aus dem
      **Profil-Hub**, aus **„Meine Daten"** und aus dem **Beitragskonto** je über
      eine Karte erreichbar (erscheint nur, wenn Premium aktiv). Er zeigt Status,
      nächste Abbuchung, **Karte/Zahlungsart** (Marke + letzte 4) und die
      **Rechnungen**. **Kündigen** (zum Periodenende) → `cancel_at_period_end=true`;
      **Reaktivieren** hebt es auf; **Zahlungsart ändern** (Payment Element)
      speichert eine neue Standard-Zahlungsmethode (alle im Dashboard aktiven).
- [ ] **Kündigen/Ablauf:** nach Kündigung läuft es zum Periodenende aus →
      `customer.subscription.deleted` → Entzug. Der Hosted-Portal-Link bleibt als Fallback.
- [ ] **Webhook-Log grün:** **Entwickler → Webhooks → Endpunkt → „Letzte
      Ereignisse"** zeigt `200` (bzw. `dedup:true` bei Wiederholung). Ein Event
      kann man dort auch **erneut senden** — der Status bleibt idempotent gleich.

Automatisierte Prüfungen liegen unter `scratchpad/` (Entwicklung):
`stripe-webhook.test.js` (echter Webhook: Signatur, Idempotenz, item-level
Periodenende, invoice.paid→active, Kündigung, past_due, Store-Fehler→500),
`stripe-billing.test.js` (lib/stripe-Helfer: Embedded-Checkout, Kündigen/Reaktivieren,
SetupIntent mit `automatic_payment_methods`, Standard-Zahlungsmethode, Rechnungen),
`team-preview.test.js` (Team-Endpoint: grant mit `days`/`permanent`, revoke, echtes
Abo geschützt, `sub-cancel`/`sub-reactivate` ruft Stripe, GET-Mapping),
`ern-embedded.pw.js` (In-App-Kauf-Sheet ohne Seitenwechsel, In-App-Verwaltung,
**Comp-Fall** „vom Studio freigeschaltet", Erreichbarkeit via `nav abo`),
`team-preview.pw.js` (Team-UI: Zeitraum-/Dauerhaft-Grant + Beenden) und
`ern-billing.pw.js` (dynamischer Preis).

Der Test-Zugang der App (Modul versteckt) funktioniert unabhängig: In der App
7× auf das Datum tippen (setzt `localStorage.fi_ern_test`). Das entsperrt nur
die **Sichtbarkeit** des Moduls, nicht Premium — Premium hängt allein am Abo.

---

## Wie es intern funktioniert (Kurzüberblick)

- `lib/stripe.js` — schlanker `fetch`-Client (kein npm-SDK): Checkout-Session
  (**Redirect ODER Embedded** via `ui_mode:embedded`), Portal, **Subscription
  kündigen/reaktivieren**, **SetupIntent** (Karte), **Rechnungen**, Preis-Info,
  Webhook-Signatur prüfen (`t=…,v1=…`, HMAC-SHA256, 5-Min-Toleranz).
- **Client:** `mitglieder.html` lädt **Stripe.js** bei Bedarf (`js.stripe.com`) und
  mountet **Embedded Checkout** (Kauf) bzw. das **Payment Element** (Karte ändern) in
  ein Sheet – kein Seitenwechsel. Der öffentliche `pk_…` kommt über `premiumInfo.pk`.
- `lib/entitlements.js` — liest/schreibt `nutri:prem:<memberId>` in Upstash;
  `isPremium()` = `tier=premium` UND Status `active`/`trialing` UND Periode nicht abgelaufen.
- `api/member/nutrition-billing.js` — `POST {action:…}` (Bearer-Auth):
  `checkout` (Redirect **oder** Embedded), `portal`, `status`, `sub-info`,
  `cancel`/`reactivate`, `setup-intent` + `set-default-pm` (Zahlungsart ändern),
  `invoices`. Betrifft **immer nur das eigene** Abo des eingeloggten Mitglieds.
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

## Gratis-/Test-Zugang & Abo-Verwaltung im Team-Backend

Ein **Admin** verwaltet das Ernährungs-Premium pro Mitglied direkt im Profil
(Karte „🔓 Ernährungs-Premium"). Endpunkt: `api/team/nutrition-preview.js`
(nur Admin). Drei Situationen:

**1. Kein Premium → Gratis-/Test-Zugang vergeben.** Buttons für **7 / 14 / 30 /
90 Tage** oder **„Dauerhaft gratis"**.
- `POST {id, action:'grant', days:<n>}` schreibt ein normales Entitlement
  `nutri:prem:<id>`, markiert mit **`source:'team_preview'`**, befristet auf `days`
  (Default 30, Cap 3650). `POST {id, action:'grant', permanent:true}` setzt
  `until:null` → **dauerhaft** gratis (läuft nie ab).
- Dadurch greifen **alle bestehenden Premium-Gates automatisch** – kein Sondercode.
- Im Mitglieder-Screen sieht das Mitglied **„Premium · gratis"** ohne jede Zahl-/
  Kündigen-UI (die App liefert dazu `premiumComp`/`premiumPermanent`).

**2. Aktiver Gratis-Zugang → beenden.** `POST {id, action:'revoke'}` löscht **nur**
`team_preview`-Einträge. Ein echtes Abo wird nie gelöscht (sonst `409 not_a_preview`).

**3. Echtes (zahlendes) Stripe-Abo → für das Mitglied verwalten.** Die Karte zeigt
„Echtes Premium-Abo aktiv (Stripe)" mit **„Abo kündigen (zum Periodenende)"** bzw.
**„Kündigung zurücknehmen"**.
- `POST {id, action:'sub-cancel'|'sub-reactivate'}` ruft
  `Stripe.cancelSubscription(subId, true/false)` und spiegelt `cancelAtPeriodEnd`
  ins Entitlement. Nur bei echtem Abo möglich (sonst `409 no_real_subscription`);
  scheitert Stripe, kommt `stripe_failed` und der Status bleibt unverändert.
- `grant` auf ein aktives echtes Abo wird abgelehnt (`409 has_real_subscription`) –
  ein Gratis-Zugang ist da überflüssig.

Beim echten Launch überschreibt der Stripe-Webhook einen `team_preview`-Eintrag
ohnehin mit den echten Abo-Daten; befristete Gratis-Zugänge laufen von selbst aus.

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

> **App-Store / In-App-Kauf (IAP):** Kauf und Verwaltung sind **in der App
> eingebettet** (Stripe.js) und laufen so auch in der nativen iOS/Android-App. Apple
> und Google verlangen für **digitale** Abos in nativen Apps grundsätzlich ihre
> **eigene IAP-Abrechnung** – eingebettetes Stripe kann bei der Store-Prüfung
> beanstandet werden. Für die **Web-/PWA-Nutzung** (`mitglieder.fit-inn-trier.de`) ist
> Stripe unkritisch. Die Store-Freigabe der nativen App ist separat zu klären
> (z. B. Kauf in der App-Variante ausblenden oder IAP nachrüsten).

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
