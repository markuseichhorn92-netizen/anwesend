# WhatsApp-KI: Mitglieder-Auskunft (Erkennung an der Nummer)

FINN beantwortet Fragen eines Mitglieds zu **seinen eigenen** Daten (Vertrag,
Termine, Besuche, Beitragskonto) direkt über WhatsApp. Standardmäßig ist das Feature
**aus** (fail-closed) und wird nur mit `WA_ASSISTANT=1` aktiv.

## Ablauf (seit 29. September 2026)

Entscheidung des Betreibers: Die Mitglieder sollen sich nicht per Link bestätigen
müssen. Die WhatsApp-Absendernummer ist geprüft (WhatsApp bestätigt sie bei der
Anmeldung; Twilio/Meta signieren den Webhook) und reicht als Nachweis – **wenn sie
eindeutig ist** (`lib/waIdentity.js`):

1. **Gemerkte Verknüpfung** (START-Code aus der App, Team) hat Vorrang.
2. **Magicline-Nummernsuche** (`M.findAllByPhone`, alle exakten Treffer):
   genau **ein** Kunde mit **laufendem Vertrag** → erkannt, FINN antwortet sofort.
3. **Mehrere Kunden** mit der Nummer (Familie) oder **kein laufender Vertrag** → FINN
   fragt einmal nach dem **Geburtsdatum** (fester Text, kein Modell). Der Server prüft es
   gegen die Kandidaten; genau ein Treffer → Wahl 60 Tage gemerkt (`wa:pick:<nummer>`),
   solange die Nummer in Magicline noch an diesem Kunden hängt. Danach wird die
   ursprüngliche Frage beantwortet. 3 Fehlversuche/Tag → Übergabe ans Team. Das
   Geburtsdatum geht nie ans Modell und nicht in Logs; im Posteingang steht
   „(Geburtsdatum angegeben)".
4. **Kein Treffer** → Interessent (Lead-Weg).

Der KI-Hinweis beim ersten Kontakt sagt: „Ich erkenne dich an deiner Handynummer aus
deinem Mitgliedskonto."

**Gesundheitsdaten** (Körperwerte/InBody, Lebensstil, Vital, FINN-Gedächtnis) nur nach
einem ausdrücklichen **„Ja"** im Chat (`lib/waHealth.js`): Fragt jemand erkennbar nach
eigenen Körper-/Gesundheitswerten, stellt FINN die feste Rückfrage (Text =
`lib/privacy` `wa_ai_health`). „Ja" → Einwilligung (`wa:hc:<nummer>` + Nachweis im
Datenschutz-Protokoll), dann Antwort mit Gesundheitskontext; „Nein" → Antwort ohne;
„Gesundheitsdaten aus" → Widerruf. Ohne Einwilligung ruft der Assistent den Coach mit
`noHealth:true` (lässt Profil-, InBody-, Morgen-, Vital-, Akku- und Gedächtnis-Kontext weg).

**Grenzen:**
- Nur WhatsApp. Die Telefon-Hotline (`lib/phoneAuth.js`) zählt eine Anruferkennung nicht
  als Nachweis (fälschbar) und akzeptiert nur `wa:verify:` (früherer Link) oder den Code.
  Die Nummern-Erkennung schreibt deshalb **nie** `wa:verify:`.
- Heikle Themen (Kündigung, Geld, Beschwerde, …) gehen weiter ans Team; Aktionen mit
  Risiko brauchen weiter die Bestätigung im Chat.
- Restrisiko: neu vergebene Nummern, die in Magicline noch am alten Mitglied hängen –
  begrenzt durch „laufender Vertrag" und durch Auskunft nur auf Nachfrage (DSFA-Nachtrag).

**Früherer Weg (Link):** Wer seine Nummer schon über `/wa-verify.html` (Geburtsdatum +
E-Mail) bestätigt hat, gilt weiter als verifiziert (`WA_VERIFY_TTL_DAYS`, Standard 60) –
inklusive der dort erteilten Einwilligung für Trainings-/Ernährungsdaten. Neue Links
verschickt die WhatsApp-KI nicht mehr; Seite und Endpunkt bleiben für bestehende
Bestätigungen und die Hotline.

## App-Aktionen (nicht nur Antworten)

Erkannte Mitglieder können über WhatsApp echte App-Aktionen auslösen – FINN
nutzt dieselben Endpunkte wie die App (`/api/member/nutrition`) mit einer intern
gemünzten, kurzlebigen Mitglieds-Session (`lib/waAgent.js`). Phase 1:

- **Essen tracken:** „Ich hatte mittags 200 g Hähnchen mit Reis" → FINN schätzt
  Kalorien/Makros und trägt es ins Tagebuch ein (`estimate` + `confirm-log`).
- **Wasser:** „2 Gläser Wasser" / „0,5 l getrunken" → `water`.
- **Tagesstand:** „Wie viele Kalorien habe ich heute noch?" → `state`.

Weitere Aktionen (`lib/waAgent.js`, Tool-Use-Loop):

- **Foto-Tracking:** Mahlzeit fotografieren → FINN erkennt & trägt ein
  (`estimate-photo` + `confirm-log`). Bild-Download: Twilio `MediaUrl` (Basic-Auth),
  Meta media-id via Graph + Token (`lib/whatsapp.fetchMedia`).
- **Termine:** anzeigen, absagen, buchen (`list_bookable_types` →
  `find_appointment_slots` → `book_appointment`; FINN bucht nur einen bestätigten
  Slot, sonst schlägt es Slots vor).
- **Gewicht/Erfolgskontrolle:** `log_weight_checkin` (nur für Coaching-Teilnehmer;
  sonst erklärt FINN das).
- **Trainingseinheit:** `log_workout` (nutzt den Workouts-Endpunkt; dessen Gates –
  Premium + Vital-Check-Einwilligung – gelten unverändert).

Ablauf: ein bounded Tool-Use-Loop (max. 6 Schritte) – die KI orchestriert
mehrstufige Abläufe (z. B. Terminbuchung) und formuliert die Abschluss-Antwort.
Ist die Nachricht keine Aktion, übernimmt der normale FINN-Coach. Freemium/Quota
und Guardrails der Endpunkte gelten unverändert – es wird nichts umgangen.

### Mehrstufige Abläufe über mehrere Nachrichten

Jede WhatsApp-Nachricht ist ein eigener Aufruf ohne gespeicherte Zwischenergebnisse.
Damit z. B. eine Terminbuchung über mehrere Nachrichten hinweg funktioniert, geht der
**bisherige Thread-Verlauf** (`buildHistory`) als unvertrauenswürdiger Kontext-Vorspann
in die erste User-Nachricht des Agenten ein (`lib/waAgent.js` `openingMessage`). So
erkennt FINN eine kurze Folgeantwort wie „2" oder einen angetippten Button als Auswahl
aus seiner letzten Frage und holt sich Terminarten/Slots bei Bedarf erneut, bevor er bucht.

### Anklickbare Buttons

Statt Optionen nur als Text aufzuzählen, bietet FINN sie als **anklickbare WhatsApp-
Buttons** an (Werkzeug `present_options` → `lib/whatsapp.sendButtons`):

- **Meta Cloud API:** native interaktive Nachricht IM 24h-Fenster ohne Vorlage – bis 3
  Optionen als Buttons, mehr als Liste (bis 10). Sofort aktiv.
- **Twilio:** braucht eine genehmigte Quick-Reply-Content-Vorlage
  (`TWILIO_QUICK_REPLY_CONTENT_SID`, `{{1}}`=Text, `{{2}}`..`{{4}}`=Button-Titel).
  Ohne diese SID fällt FINN automatisch auf einen **nummerierten Text** zurück; das
  Mitglied tippt dann die Zahl – dank Verlaufs-Kontext läuft der Ablauf identisch weiter.

Ein Tipp auf einen Button kommt als normale Textnachricht (der Button-Titel) zurück und
wird wie eine getippte Antwort verarbeitet (`parseInbound` / `parseTwilioInbound`).

## Team-Benachrichtigung nur bei Eskalation

Nachrichten, die FINN selbst erledigt (Antwort, Tracking, Foto, Termin), werden
STILL ins Postfach protokolliert – ohne Team-Push, nicht als „neu"/ungelesen. Das
Team bekommt eine **E-Mail + Push nur bei Eskalation**: heikle Themen oder wenn
FINN nicht sicher antworten kann (`Inbox.alertTeam` + `SR.notifyStudio`).

## Automatisch + Eskalation

FINN antwortet selbst auf Auskunfts- und Coach-Fragen. **Heikle bzw. nach außen
wirkende Themen** übergibt er an einen Menschen statt sie zu beantworten:
Kündigung/Widerruf, Beschwerde, Geld/Erstattung/Mahnung/Inkasso, Bankdaten ändern
(IBAN/SEPA), Notfälle, sowie der ausdrückliche Wunsch, einen Mitarbeiter zu
sprechen. Die Liste steht in `lib/waAssistant.js` (`SENSITIVE`).

## Sicherheit

- Server-seitige Autorisierung, **fail-closed**; ohne Store/AI/WhatsApp passiert nichts.
- Prompt-Injection-Schutz und Guardrails wie beim App-Coach (Mitglieder-Scope).
- **Keine** IBAN/Bankdaten in Antworten; nur die Daten des angemeldeten Mitglieds.
- Nur die Zuordnung Nummer↔Mitglied, Zeitstempel und Einwilligungsversion werden
  gespeichert – **keine** Klartext-Geheimnisse, Prompts oder Gesundheitsdaten.
- Meta-Webhook-Retries werden dedupliziert (`firstSeen`), Link-Versand und
  KI-Antworten sind ratenbegrenzt; der Bestätigungs-Endpunkt ist gedrosselt.

## Konfiguration (Vercel)

```text
WA_ASSISTANT=1                 # schaltet die WhatsApp-KI frei (Default aus)
WA_VERIFY_TTL_DAYS=60          # optional: Re-Check nach so vielen Tagen Inaktivität
WA_CONSENT_VERSION=wa-finn-2026-07   # optional: bei Textänderung der Einwilligung erhöhen
```

Voraussetzung: AI (Bedrock) **und** WhatsApp-Versand sind konfiguriert
(`hasAI`, `WA.hasWhatsApp`). Der freie Versand nutzt das 24-Stunden-Servicefenster
(das Mitglied hat gerade geschrieben); außerhalb greift die genehmigte Freitext-Vorlage.

## Noch organisatorisch (vor scharfem Betrieb)

- **Datenschutz:** Antworten inkl. Trainings-/Ernährungs-(Gesundheits-)daten laufen
  über Meta/WhatsApp (USA). AVV mit Meta prüfen, Verarbeitung in DSFA/VVT ergänzen,
  Einwilligungstext rechtlich freigeben. Der Umfang ist bewusst per Flag steuerbar.
- Widerruf: „STOP" ist umgesetzt (29.09.2026, `lib/journeys/inbound.js`, in beiden
  Webhooks vor jeder KI): beide WhatsApp-Einwilligungen widerrufen, gehashte Sperrliste,
  Bestätigung mit Hinweis auf „START". Die Verifizierung der Nummer für die WhatsApp-KI
  (`wa:verify`) bleibt davon unberührt – Auskunft auf eigene Fragen gibt es weiterhin.
