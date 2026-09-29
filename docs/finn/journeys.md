# FINN Journeys – WhatsApp für Leads, Onboarding und Bindung

Stand: 29. September 2026. Code unter `lib/journeys/`, Cron `api/journeys-tick.js`,
Team-Backend „WhatsApp-Journeys", App-Einstellungen „WhatsApp von Fit-Inn".

Vorbild waren athleo, 360°CHAT und StudioPartner: **feste Abläufe mit Magicline-Auslösern,
KI nur für das Gespräch, Übergabe ans Team**. Alles hängt an `JOURNEYS=1`; ohne diesen
Schalter bleibt das Verhalten der App wie vorher (Ausnahmen: siehe „Immer aktiv").

## Schalter (Vercel, ohne Deployment)

| Variable | Wirkung |
|---|---|
| `JOURNEYS=1` | Hauptschalter. Ohne ihn: nichts aufnehmen, nichts senden, Lead-KI aus. |
| `JOURNEYS_MODE=auto` | Echt senden. **Standard ist der Probelauf**: Abläufe laufen durch, Nachrichten landen nur in `jr:dry` (Team-Backend „Probelauf"). |
| `JOURNEYS_TEST_NUMBERS` | Kommagetrennt. Gesetzt = nur diese Nummern bekommen echte Nachrichten (Pilot). Testversand aus dem Team-Backend nur an diese. |
| `JOURNEYS_TRACK=1` | Check-ins zählen und Index füllen, ohne `JOURNEYS=1` (Daten wachsen vor dem Start). |
| `JOURNEY_<KEY>=0` | Journey hart aus: `LEAD`, `ONBOARDING`, `HABIT`, `COMEBACK`, `INVITE`. |
| `JOURNEYS_LEAD_AI=0` | Lead-Agent aus (Leads laufen wieder über die feste Begrüßung + Team). |
| `JOURNEYS_INVITE_PER_DAY` | Einladungen pro Tag (Standard 40). |
| `WA_PUBLIC_NUMBER` | Nummer für wa.me-Links (sonst `TWILIO_WHATSAPP_FROM`). |
| `JOURNEYS_HASH_KEY` | Schlüssel für die gehashte STOP-Sperrliste (Fallback: Webhook-/Cron-Secret). |
| `JOURNEYS_JOIN_URL` | Link „Tarife/online starten" (Standard `…/mitglied-werden`). |

Im Team-Backend: Journeys einzeln an/aus (Einladung standardmäßig **aus**), Content-SID je Vorlage.

## Immer aktiv (unabhängig von `JOURNEYS`)

- **24-h-Fenster** je Nummer (`jr:win:<nummer>`, gesetzt bei jeder eingehenden Nachricht).
  Team-Antworten (`lib/studioReply`) nehmen bei geschlossenem Fenster die Vorlage bzw. die Mail.
- **STOP / STOPP / ABMELDEN / START** in beiden Webhooks vor jeder KI (`lib/journeys/inbound.js`).
  STOP widerruft beide Einwilligungen, setzt die gehashte Sperrliste und verwirft eine offene
  FINN-Bestätigung. START meldet wieder an.
- **Doppelzustellung** desselben Webhooks wird erkannt (`wa:wh:<id>`).
- **Lead-Pipeline**: eine Nummernform (`lib/phone.js`), Quelle, Termin, neue Stufen,
  `CONTRACT_CREATED` setzt den Lead auf „gewonnen".
- **Einwilligungen aus dem Probetraining-Formular** werden gespeichert (auch ohne Journeys).

## Datenmodell (KV)

| Schlüssel | Inhalt |
|---|---|
| `jr:st:<subj>` | Zustand je Person (Mitglied = Kunden-Id, Lead = `L<n>`): Nummer, Vorname, Fakten, Läufe, letzte Sendungen |
| `jr:eng:<kundenId>` | Hash: Besuchstage (70 Tage), Wochen (30), gesamt, erster/letzter Besuch, Meilensteine |
| `jr:con:<nummer>` | Einwilligungen `service`/`marketing` mit Quelle, Version, Text-Hash, Verlauf |
| `jr:sup:<hmac>` | STOP-Sperre (gehasht, 3 Jahre, bleibt nach Löschung als Widerspruchsnachweis) |
| `jr:ph:<nummer>` | Nummer → Person (Mitglied schlägt Lead) |
| `jr:due`, `jr:idx`, `jr:mem` | fällige Personen, eigener Kandidaten-Index (aus Webhooks, **kein** Mitgliederverzeichnis), Mitglieder mit Nummer |
| `jr:win:<nummer>`, `jr:ask:<nummer>`, `jr:code:<CODE>` | 24-h-Fenster, offene Ja/Nein-Frage, Opt-in-Code |
| `jr:out:<sid>`, `jr:last:<nummer>` | Zustellstatus/Fehlercode, Antwort-Zuordnung |
| `jr:kpi:<yyyymm>:<journey>:<metrik>` | Kennzahlen ohne Personenbezug |
| `jr:cfg`, `jr:dry`, `jr:run*`, `jr:lock:*` | Einstellungen, Probelauf-Liste (Vorname als Platzhalter), Durchlauf-Cursor |

Export/Löschung: `jr:st:` und `jr:eng:` stehen in `privacy.APP_PREFIXES`; `deleteAppData`
ruft zusätzlich `journeys/store.erase()` (Nummer-Zuordnung, Einwilligung der Nummer, Fenster).

## Die Abläufe (`lib/journeys/defs.js`)

**Leads & Probetraining** – Lead-Agent auf WhatsApp (`lib/journeys/leadchat.js`, FINN-Agent
`lead`, Kanal `channels.whatsappLead`, Mitglieder-Guardrail): Ziel, Erfahrung, Tageszeit
(`save_lead_profile`), freie Termine (`get_trial_slots`), Buchung (`book_trial`, MEDIUM,
nur nach „Ja"). Die Rufnummer kommt aus dem Webhook. Nach der Buchung: Einwilligung
`service` (stand in der Bestätigung), einmal die Frage nach Tipps (`marketing`, Ja/Nein
wertet `inbound.js` aus). Danach: Tag 1 / Tag 4 Nachfassen ohne Termin; 24 h und 2 h vor dem
Termin Erinnerung; +3 h „Wie war's?"; +2 Tage Angebot; +6 Tage letzter Kontakt; +14 Tage
Pipeline „verloren". Vertrag → „gewonnen", Onboarding startet. Erschienen = Check-in der
Lead-Kunden-Id zwischen −60 und +90 min.

**Onboarding** (ab `CONTRACT_CREATED`): Willkommen + Einführungstraining anbieten, Tag 3
Erinnerung ohne Einführung, erster Besuch, Tag 7/14 (höchstens einer)/21 gegen das
Wochenziel (Tag 21 unter 4 Besuchen → Team-Aufgabe), Tag 30/60/90 Nachfrage.

**Motivation** (mit `marketing`): zwei Wochen unter Wochenziel (höchstens alle 14 Tage,
nicht in den ersten 90 Tagen, nicht direkt nach einem Comeback), 10/25/50/100/250/500
Besuche, 4/8/12/26/52 Wochen in Folge.

**Comeback** (mit `marketing`): 10 Tage weg sanft, 21 Tage Trainer-Termin, 28 Tage
Team-Aufgabe „anrufen" – danach keine Automatik. Check-in beendet sofort („reaktiviert").

**Einladung** (nur eingeschaltet): einmal je Nummer, nur aktive Verträge, gedrosselt.

## Schutzregeln beim Senden (`lib/journeys/sender.js`)

1. Hauptschalter, gültige Nummer
2. STOP-Sperre, Einwilligung passend zur Vorlage (`service`/`marketing`; Einladung: nur ohne Einwilligung, einmal)
3. Sperren: gekündigt, offener Kündigungs-/Widerrufs-Vorgang, Übergabe < 7 Tage, Zahlungsproblem < 30 Tage (nur Motivation), minderjährig (nur Motivation), Tag „kein Kontakt"
4. Ruhezeiten Berlin: Service 07:00–21:00 täglich; Motivation Mo–Sa 09:00–19:30, nicht an Feiertagen RLP → verschieben, nie verwerfen
5. Kappen: Motivation 1/Tag, 2/7 Tage, 4/28 Tage (Push-Anstoß zählt mit); Service 3/Tag
6. Fenster offen → kostenloser Freitext (mit Knöpfen, wenn möglich); zu → freigegebene Vorlage; keine Vorlage → überspringen
7. Probelauf / Testnummern
8. Versand, Eintrag im WhatsApp-Vorgang („FINN · Journey", ohne Team-Alarm), Zustellstatus, Kennzahlen

Höchstens **eine** Nachricht je Person und Durchlauf; nach einer Sendung frühestens 60 min später die nächste.
Zustellfehler: 63016/131047 (Fenster zu) → einmal als Vorlage; 63049/131049 (Meta-Deckel) → einmal +24 h; ungültige Nummer → gesperrt.

Der Push-Anstoß (`lib/nudge.js`) pausiert, wenn in 7 Tagen per WhatsApp motiviert wurde oder ein Comeback läuft.

## Vorlagen

Liste mit Text, Kategorie und Variablen: Team-Backend → WhatsApp-Journeys → „Vorlagen"
(Quelle: `lib/journeys/templates.js`). UTILITY: `fi_trial_24h`, `fi_trial_2h`, `fi_onb_welcome`,
`fi_onb_induction`. MARKETING: alle übrigen. Meta entscheidet die Kategorie endgültig.

## Inbetriebnahme (Reihenfolge)

1. Rechtsprüfung: Einwilligungstexte (`lib/journeys/consent.TEXTS`, Formular, Mail, App), Einladungstext, Datenschutzerklärung; DSFA-Nachtrag freigeben; AVV Twilio/Meta.
2. Twilio: Vorlagen anlegen und freigeben lassen, Content-SIDs im Team-Backend eintragen.
3. Vercel: `JOURNEYS=1`, `JOURNEYS_TEST_NUMBERS=<eigene Nummer>`, `WA_PUBLIC_NUMBER`; GitHub-Secret `RECORD_SECRET` ist für den Workflow schon da.
4. Probelauf beobachten (Team-Backend „Probelauf"), dann `JOURNEYS_MODE=auto` mit Testnummern.
5. Eigene Nummer als Lead durchspielen: Anfrage → Fragen → Termin → „Ja" → Erinnerungen → STOP.
6. Testnummern entfernen; Einladung erst nach Rechtsprüfung einschalten.
7. Magicline-Webhooks prüfen: `CUSTOMER_CHECKIN`, `APPOINTMENT_*`, `CUSTOMER_CREATED`, `CONTRACT_CREATED`, `CONTRACT_CANCELLED` an diese App.

## Tests

`journeys-core`, `journeys-inbound`, `journeys-engine`, `journeys-webhooks`,
`journeys-lead-agent`, `journeys-onboarding`, `journeys-team-api`, `journeys-studio-reply`.
Redis-Nachbau für Tests: `tests/_memredis.js`.
