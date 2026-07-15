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
   - `invoice.payment_failed`
4. Endpunkt anlegen, dann **Signing secret** kopieren → `whsec_…`
   → das ist `STRIPE_WEBHOOK_SECRET`.

> Der Webhook ist die **einzige** Stelle, die Premium freischaltet/entzieht.
> Der Client kann den Status nicht selbst setzen. Ohne gültige Signatur
> antwortet der Endpunkt mit `400`.

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
| `APP_BASE_URL` | `https://mitglieder.fit-inn-trier.de` | empfohlen |

`APP_BASE_URL` bestimmt, wohin Stripe nach Checkout/Portal zurückleitet
(`…/mitglieder?ern_premium=success|cancel|portal`). Fehlt sie, wird sie aus dem
Request-Host abgeleitet — bei Custom-Domain lieber explizit setzen.

Nach dem Setzen: **neu deployen**, damit die Variablen greifen.

---

## End-to-End testen (Stripe-Testmodus)

1. Testmodus in Stripe an, Test-Keys in Vercel (Preview) hinterlegen.
2. Im Member-Portal Premium starten → Stripe-Checkout öffnet sich.
3. Testkarte: **`4242 4242 4242 4242`**, beliebiges künftiges Datum, beliebige
   CVC/PLZ. (Weitere Testkarten: [stripe.com/docs/testing](https://stripe.com/docs/testing).)
4. Nach „Bezahlen" leitet Stripe zurück (`?ern_premium=success`). Der Webhook
   feuert `checkout.session.completed` + `customer.subscription.created` →
   Entitlement `nutri:prem:<memberId>` wird auf `trialing`/`active` gesetzt →
   KI-Funktionen sind frei.
5. Im Stripe-Kundenportal kündigen → `customer.subscription.deleted` → Entzug
   nach Periodenende.
- Webhook-Zustellung prüfen: **Entwickler → Webhooks → Endpunkt →** „Letzte
  Ereignisse". Ein Event kann man dort auch **erneut senden**.

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
  Entitlement. Antwortet immer `200`, damit Stripe nicht retry-stürmt.
- `api/member/nutrition.js` — serverseitiges Gate + `buildState` liefert dem
  Frontend `premium`, `tier`, `trialing`, `premiumUntil`.

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
