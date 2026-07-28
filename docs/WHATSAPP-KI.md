# WhatsApp-KI: verifizierte Mitglieder-Auskunft

FINN beantwortet Fragen eines Mitglieds zu **seinen eigenen** Daten (Vertrag,
Termine, Besuche, Beitragskonto, Training, Ernährung) direkt über WhatsApp –
**erst nach einer 2-Faktor-Verifizierung**. Standardmäßig ist das Feature **aus**
(fail-closed) und wird nur mit `WA_ASSISTANT=1` aktiv.

## Ablauf

1. **1. Faktor – Besitz:** Der Webhook ordnet die eingehende WhatsApp-Nummer über
   `M.findByPhone` einem Magicline-Mitglied zu. Kein Treffer → kein KI-Zugriff, es
   bleibt beim bisherigen Lead-/Team-Weg.
2. **2. Faktor – Wissen:** Bei Erstkontakt oder nach längerer Pause schickt FINN
   einen **Bestätigungs-Link** (`/wa-verify.html?token=…`). Dort gibt das Mitglied
   **Geburtsdatum + E-Mail** ein. Der Server prüft beides gegen Magicline
   (`M.findByEmailDob`) **und** dass die Trefferperson genau das der Nummer
   zugeordnete Mitglied ist (Token-Bindung). Zusätzlich ist eine **Einwilligung**
   Pflicht (KI-Antworten inkl. Trainings-/Ernährungsdaten über WhatsApp).
3. **Danach** antwortet FINN automatisch – über denselben Coach wie in der App
   (`/api/member/coach`, mit einer nur intern genutzten, 120-Sekunden-Session).
4. **Re-Verifizierung:** Die Freischaltung ist ein gleitendes Fenster
   (`WA_VERIFY_TTL_DAYS`, Default 60). Bei Aktivität verlängert sie sich; nach
   Ablauf (längere Pause) ist eine erneute Bestätigung nötig.

## App-Aktionen (nicht nur Antworten)

Verifizierte Mitglieder können über WhatsApp echte App-Aktionen auslösen – FINN
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

Ablauf: ein bounded Tool-Use-Loop (max. 5 Schritte) – die KI orchestriert
mehrstufige Abläufe (z. B. Terminbuchung) und formuliert die Abschluss-Antwort.
Ist die Nachricht keine Aktion, übernimmt der normale FINN-Coach. Freemium/Quota
und Guardrails der Endpunkte gelten unverändert – es wird nichts umgangen.

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
- Widerruf: „STOP" ist im Einwilligungstext genannt – einen Opt-out-Pfad (Nummer
  entsperren/`clearVerified`) bei Bedarf im Team-Backend ergänzen.
