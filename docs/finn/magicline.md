# FINN · Bestehende Magicline-Integration (Bestandsaufnahme)

Stand: September 2026. Dieses Dokument beschreibt, **was heute schon geht** –
es ist die Grundlage für den FINN-Tool-Layer (`lib/finn/`). Regel Nr. 1 der
FINN-Architektur: **Nichts hiervon wird ersetzt.** FINN kapselt die
bestehenden Funktionen, ruft sie auf und normalisiert ihre Ergebnisse.

## 1. Clients

| Client | Datei | Basis | Auth | Verwendung |
|---|---|---|---|---|
| Open API | `lib/members.js` → `ml(method, path, body)` / `mlForm(...)` | `https://<ML_TENANT>.open-api.magicline.com/v1` | Header `x-api-key: ML_API_KEY` | alle Kundendaten, Self-Service, Termine, Check-ins, Leads |
| Connect API | `lib/connect.js` | `https://<tenant>.api.magicline.com/connect/v1` (`ML_CONNECT_BASE`, `ML_STUDIO_ID`) | ohne Key, reCAPTCHA für Kündigung/Widerruf | Probetraining, Tarife, Online-Vertragsabschluss, Kündigung/Widerruf als Fallback |
| Studio-Info | `lib/studioHours.js`, `lib/utilization.js` | Open API `/studios/information`, Auslastung | `x-api-key` | Öffnungszeiten, Auslastung |

`ml()` liefert immer `{ status, json, text }` und wirft nie (Netzfehler →
`status: 0`). Timeout 10 s. Die Fach-Wrapper (`lib/ml*.js`) übersetzen das in
`{ ok, forbidden, status, … }` bzw. `{ available:false, forbidden }`.

## 2. Fachmodule (die FINN wiederverwendet)

| Bereich | Modul | Funktionen | Scope(s) |
|---|---|---|---|
| Kunde | `lib/members.js` | `getMember`, `publicProfile`, `searchByEmail`, `findByPhone`, `findByNumberDob`, `writeAddress`, `writeContact`, `writePayment`, `checkinCustomer`, `checkoutCustomer`, `recentCheckins`, `checkinHistory`, `daysSinceLastCheckin` | CUSTOMER_READ, CUSTOMER_SELF_SERVICE_WRITE, CHECKIN_READ/WRITE |
| Vertrag | `lib/members.js` `getContract` | normalisierter Hauptvertrag (`contractId`, `rateName`, `active`, `cancelled`, `endDate`, `nextCancellationDate`, `withdrawalEligible`, …) | CUSTOMER_READ |
| Kündigung/Widerruf | `lib/mlCancel.js` | `cancelReasons`, `ordinaryCancel`, `withdrawCancel`, `contractWithdrawal` | MEMBERSHIP_SELF_SERVICE_READ/WRITE |
| Pause | `lib/mlMembership.js` | `idleConfig`, `idleRemaining`, `idleList`, `idleValidate`, `idleCreate`, `idleWithdraw` | MEMBERSHIP_SELF_SERVICE_READ/WRITE |
| Zusatzmodule | `lib/mlModules.js`, `lib/mlPremium.js` | `listModules`, `bookModule`, `cancelModule`, `getModuleContract`, `getCancelationReasons` | MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_READ/WRITE, …_CONTRACT_READ |
| Beitragskonto | `lib/mlAccount.js` | `accountSummary` (Saldo, offene Posten, Mahnstufe, Inkasso) | CUSTOMER_ACCOUNT_READ |
| Zahlung | `lib/payments.js` | `createUserSession`, `assignInstrument` (Finion Pay) | PAYMENT_WRITE |
| Termine | `lib/bookable.js` | `listTypes`, `matchType`, `freeSlots`, `book`; Buchungen: `ml('GET','/appointments/booking?customerId=')`, Storno `ml('DELETE','/appointments/booking/{id}')` | BOOKABLE_APPOINTMENTS_READ, APPOINTMENTS_READ/WRITE |
| Dokumente | `lib/mlDocuments.js` | `listDocuments`, `getDocument`, `uploadDocument` (Endpunkte **nicht sicher verifiziert**) | CUSTOMER_DOCUMENT_READ/WRITE |
| Zugangsmedien | `lib/mlAccessMedium.js` | `listAccessMedia`, `blockAccessMedium`, `unblockAccessMedium`, `issueAccessMedium` (Endpunkte **nicht sicher verifiziert**) | CUSTOMER_ACCESS_MEDIUM_READ/WRITE |
| Kommunikation | `lib/mlComm.js` | `getCommPrefs`, `setCommPrefs` | COMMUNICATION_PREFERENCES_READ/WRITE |
| Leads | `lib/members.js` `getLeadConfig`, `createLead`; `lib/leadflow.js` | Lead anlegen, Pipeline im KV | LEAD_READ/WRITE |
| Mitarbeiter | `lib/teamStaff.js` | `findEmployeeByEmail` (paginiert `/employees`) | EMPLOYEE_READ |
| Studio | `lib/studioHours.js`, `lib/utilization.js` | Öffnungszeiten, Auslastung | STUDIO_READ |

Bewusst **nicht** angefragt: `MEMBER_LIST_READ`. Es gibt kein
Mitgliederverzeichnis aus Magicline; das Team-Backend kennt nur Mitglieder mit
Vorgängen plus gezielte Suche (`api/team/members.js?q=`). FINN übernimmt diese
Grenze (`lib/finn/directory.js`).

## 3. Bekannte API-Grenzen (aus dem Code, nicht vermutet)

- Keine Liste gebuchter Zusatzmodule – nur buchen / per ID lesen / per ID kündigen.
- Keine studioweite Termin- oder Check-in-Abfrage – dafür der Webhook-Feed (`lib/mlEvents.js`).
- Kein Umbuchen-Endpunkt (Storno + Neubuchung).
- `daysAhead` für Slots ist auf 6 begrenzt (`lib/bookable.js` holt Fenster parallel).
- Ohne `fromDate/toDate` liefert der Check-in-Verlauf nur einen Monat.
- Connect-Kündigung braucht reCAPTCHA und eine whitegelistete Domain.
- Dokumente und Zugangsmedien: Endpunkte sind Annahmen; die Wrapper degradieren auf `available:false`.

## 4. 403-/Fehler-Verhalten und Fallbacks (bestehend)

Muster in den Endpunkten: **Open API → (Connect) → Inbox-Vorgang + Studio-Mail.**

| Endpunkt | Direktweg | Fallback | Antwort |
|---|---|---|---|
| `api/member/update.js` | `writeAddress/Contact/Payment` | Vorgang + `notifyStudio` | `via:'magicline'` / `via:'studio'` |
| `api/member/pause.js` | `idleValidate` → `idleCreate` | Vorgang „Beitragspause" + Mail | `via:'magicline'` / `via:'studio'` |
| `api/member/cancel.js` | `ordinaryCancel` → `Connect.submitCancellation` → Mail | Vorgang „kuendigung" | `via:'magicline', direct:true` |
| `api/member/cancel-withdraw.js` | `withdrawCancel` | Vorgang (hoch) + Mail | `forbidden:true` ehrlich |
| `api/member/modules.js` | `bookModule` / `cancelModule` | Vorgang + Mail mit Diagnose | `via:'magicline'` / `via:'fallback'` |
| `api/team/access-medium.js` | `block/unblock/issue` | Vorgang + Mail | `via:'fallback'` |
| `api/team/pause.js`, `api/team/cancel.js` | Self-Service | **kein** Mail-Fallback, ehrliche Meldung | `forbidden:true` |

FINN nutzt diese Endpunkt-Logik nicht doppelt, sondern ruft dieselben
Wrapper und meldet 403 an die Capability-Erkennung (`lib/finn/capabilities.js`).
Fehlt ein Scope, sagt FINN das dem Kunden verständlich und bietet die Übergabe
ans Team an – genau wie die Endpunkte heute.

## 5. Bestehende KI-Bausteine

- `lib/ai.js`: `messagesRaw` (Tool Use), `complete`, `coachSystemParts`,
  `coachReply`, Guardrail-Auswahl über `securityScope` (`member` | `team`),
  fail-closed in Produktion. Kein Streaming, keine Provider-Registry.
- `lib/aiSecurity.js`: Eingangs-Regeln (Prompt Override, Leak, Rollenübernahme,
  Geheimnisse, Fremddaten), Ausgangsfilter, `hardenPayload`.
- `lib/waAgent.js`: Tool-Calling-Agent für WhatsApp (Termine, Tracking); ruft die
  eigenen HTTP-Endpunkte auf – **FINN ersetzt das nicht**, sondern kann darüber liegen.
- `api/team/assistant.js`: Team-Assistent mit Read-/Write-Tools und
  Vorschau-Bestätigung (einziger Ort mit Bestätigungslogik).
- `api/member/coach.js`: FINN-Chat des Mitglieds; `memberDetails(id)` als
  kanonischer Live-Block.
- `lib/finnMemory.js`: Opt-in-Langzeitgedächtnis. `lib/help.js`: statische
  Wissensbasis; `lib/articles.js`: gepflegte Artikel (bisher nicht an die KI angebunden).

## 6. Auth und Identität

- Mitglied: Bearer-Token → `msess:<token>` → `{ id: customerId }` (`lib/members.js`).
- WhatsApp: `lib/waAuth.js` (Nummer ↔ Mitglied, 2-Faktor-Bestätigungslink, 60 Tage gleitend).
- Telefon: `lib/phoneAuth.js` (Rufnummer + Code / Nachname + Geburtsdatum).
- Team: `lib/teamAuth.js` (`tsess:<token>`), Rollen `admin` / `trainer`, Capabilities in `lib/capabilities.js`.

FINN identifiziert Personen **nur** über diese Sessions – niemals über einen Namen im Chat.
