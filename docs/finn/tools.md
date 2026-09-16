# FINN · Werkzeuge (Tool-Layer)

Registry: `lib/finn/tools.js`. Alle Werkzeuge rufen `lib/finn/magicline.js`; das
ruft die bestehenden Wrapper (`lib/members.js`, `lib/ml*.js`, `lib/bookable.js`).
Kein Werkzeug baut eine eigene URL. Ergebnisformat überall:

```
{ ok, forbidden, status, data, error, via:'magicline'|'mock', scope }
```

## Risiko-Stufen

| Stufe | Bedeutung | Ablauf |
|---|---|---|
| LOW | lesen | läuft sofort |
| MEDIUM | schreibt, gut umkehrbar | Vorschlag → Bestätigung → Ausführung (+ Prüfung, wo möglich) |
| HIGH | rechtlich/finanziell relevant | Vorschlag mit Warnhinweis → ausdrückliche Bestätigung → Ausführung → Ergebnisprüfung → Audit + Timeline |

## Übersicht

| Werkzeug | Stufe | Scope | Bestand dahinter |
|---|---|---|---|
| get_profile | LOW | CUSTOMER_READ | `members.getMember` + `publicProfile` |
| get_contract | LOW | CUSTOMER_READ | `members.getContract` |
| get_account | LOW | CUSTOMER_ACCOUNT_READ | `mlAccount.accountSummary` |
| list_appointments | LOW | APPOINTMENTS_READ | `ml('GET','/appointments/booking?customerId=')` |
| list_appointment_types | LOW | BOOKABLE_APPOINTMENTS_READ | `bookable.listTypes` |
| find_appointment_slots | LOW | BOOKABLE_APPOINTMENTS_READ | `bookable.freeSlots` |
| list_checkins | LOW | CHECKIN_READ | `members.recentCheckins` |
| get_pause_options | LOW | MEMBERSHIP_SELF_SERVICE_READ | `mlMembership.idleConfig` + `idleList` |
| get_cancel_reasons | LOW | MEMBERSHIP_SELF_SERVICE_READ | `mlCancel.cancelReasons` |
| list_modules | LOW | …ADDITIONAL_MODULE_READ | `mlModules.listModules` |
| list_documents | LOW | CUSTOMER_DOCUMENT_READ | `mlDocuments.listDocuments` |
| list_access_media | LOW | CUSTOMER_ACCESS_MEDIUM_READ | `mlAccessMedium.listAccessMedia` |
| get_comm_prefs | LOW | COMMUNICATION_PREFERENCES_READ | `mlComm.getCommPrefs` |
| get_studio_hours | LOW | STUDIO_READ | `studioHours.fetchHours` |
| get_utilization | LOW | STUDIO_READ | `utilization.fetchUtilization` |
| search_knowledge | LOW | – | `lib/finn/knowledge.js` |
| handoff_to_team | LOW | – | `lib/finn/handoff.js` → `inbox.addVorgang`, `studioReply.notifyStudio` |
| book_appointment | MEDIUM | APPOINTMENTS_WRITE | `bookable.book`; Prüfung: Termin in Liste |
| cancel_appointment | MEDIUM | APPOINTMENTS_WRITE | Eigentumsprüfung + `DELETE /appointments/booking/{id}` |
| update_contact | MEDIUM | CUSTOMER_SELF_SERVICE_WRITE | `members.writeContact` |
| update_address | MEDIUM | CUSTOMER_SELF_SERVICE_WRITE | `members.writeAddress` |
| set_comm_prefs | MEDIUM | COMMUNICATION_PREFERENCES_WRITE | `mlComm.setCommPrefs` |
| checkin_now | MEDIUM | CHECKIN_WRITE | `members.checkinCustomer` |
| create_lead | MEDIUM | LEAD_WRITE | `members.createLead` |
| cancel_contract | HIGH | MEMBERSHIP_SELF_SERVICE_WRITE | Datum/Vertrag gegen `getContract` geprüft, dann `mlCancel.ordinaryCancel`; Prüfung: `cancelled` |
| withdraw_cancellation | HIGH | MEMBERSHIP_SELF_SERVICE_WRITE | `mlCancel.withdrawCancel`; Prüfung |
| withdraw_contract | HIGH | MEMBERSHIP_SELF_SERVICE_WRITE | nur bei `withdrawalEligible`; `mlCancel.contractWithdrawal`; Prüfung |
| create_pause | HIGH | MEMBERSHIP_SELF_SERVICE_WRITE | `idleConfig` → `idleValidate` → `idleCreate`; Prüfung |
| withdraw_pause | HIGH | MEMBERSHIP_SELF_SERVICE_WRITE | `mlMembership.idleWithdraw` |
| book_module | HIGH | …ADDITIONAL_MODULE_WRITE | `mlModules.bookModule` |
| cancel_module | HIGH | …ADDITIONAL_MODULE_WRITE | `mlModules.cancelModule` |
| update_payment | HIGH | CUSTOMER_SELF_SERVICE_WRITE | IBAN-Format geprüft, `members.writePayment`; IBAN in Vorschau maskiert |
| block_access_medium | HIGH | CUSTOMER_ACCESS_MEDIUM_WRITE | `mlAccessMedium.blockAccessMedium` |
| unblock_access_medium | HIGH (Team) | CUSTOMER_ACCESS_MEDIUM_WRITE | `mlAccessMedium.unblockAccessMedium` |

## Durchsetzung in `execute`

Reihenfolge: Werkzeug bekannt → Aktor und Agent erlaubt (`readOnly` erlaubt nur LOW)
→ Capability (`can(scope)` für alle Scopes) → Schema (unbekannte Felder verworfen,
Typen erzwungen) → im Mitglieder-Kanal `customerId` verworfen → Risiko (MEDIUM/HIGH
ohne `confirmed` → `needsConfirm`) → Rate-Limit je Aktor (80/h) → Ausführung →
Prüfung (nur bestätigt) → Audit + Metrik.

## Ziel-Kunde

Mitglied: immer die Session-Id, nie ein Argument. Team: `customerId` als Argument
oder aus dem Kontext, nur Ziffern. Website-Besucher: kein Kunde.

## Mock

`MAGICLINE_MODE=mock` (nur außerhalb der Produktion) schaltet `lib/finn/magicline.js`
auf `lib/finn/mock.js`: ein Testkunde (1001), Vertrag 5001, Termin 9001, Terminarten
301/302, Pausen-Regeln, Module, Dokumente, Zugangsmedien. Schreibende Aktionen
verändern den Mock-Zustand, damit die Ergebnisprüfung testbar ist. `mock.reset()`.
