# FINN · Sicherheit

## Identität

- Mitglied: nur aus der Bearer-Session (`lib/members.getSession`). Der Client kann
  keine `memberId` setzen; `customerId`-Argumente des Modells werden im
  Mitglieder-Kanal verworfen (`lib/finn/tools.js`).
- WhatsApp: nur verifizierte Nummer (`lib/waAuth.js`, bestehend). Der Orchestrator
  wird erst nach der Identitätsprüfung aufgerufen.
- Team: Team-Session + Capabilities. `api/team/finn.js`: Status/Audit/Events/Agenten
  und der Team-Kanal nur mit `admin.manage` **und** Admin-Rolle; Timeline mit `member.read`.
- Website: Aktor `lead`, kein Zugriff auf Mitgliedsdaten, nur mit `FINN_PUBLIC=1`.
- Kein Name im Chat identifiziert jemanden. Die Directory (`lib/finn/directory.js`)
  ist nur für den Team-Kanal gedacht; `MEMBER_LIST_READ` wird nie angenommen.

## Prompt-Injection

- Lokale Erkennung vor jedem Modellaufruf (`lib/aiSecurity.assessText`): Override,
  Leak, Rollenübernahme, Geheimnisse, Fremddaten, codierte Befehle. Treffer →
  sichere Ablehnung, Audit, Metrik `finn.blocked`, **kein** Modellaufruf.
- Bedrock-Guardrails (Mitglied/Team getrennt) bleiben aktiv; `securityScope` wird je
  Kanal gesetzt (Team-Kanal → Team-Guardrail). Kein guardrail-freier Pfad.
- Tool-Ergebnisse und Nutzertexte gehen als unvertrauenswürdig gekapselt an das
  Modell (`hardenPayload`, bestehend). Ausgabefilter für Schlüssel/Tokens bestehend.

## Aktionen

- Modell schlägt vor, System bestätigt: MEDIUM/HIGH nie ohne `confirmed:true` aus der
  Confirmation Engine; der Vorschlag ist an Aktor, Kanal, Werkzeug und Argument-Hash
  gebunden, 10 Minuten gültig, einmal einlösbar (`finnact:<id>`).
- Argumente werden serverseitig gegen den echten Zustand geprüft (Vertrags-Id,
  Kündigungsdatum ≥ nächstmögliche Kündigung, Widerruf nur bei Berechtigung,
  Slot-Format, IBAN-Format, Eigentum der Buchung).
- Ergebnisprüfung nach HIGH-Aktionen (Zustand nachlesen), Ergebnis im Audit und in
  der Timeline.
- Per-Agent-Permissions: Werkzeuge außerhalb des Agenten → `not_allowed` (kein 403,
  damit es nicht als fehlender Scope gewertet wird).
- Rate-Limits: Gespräche je Aktor und Kanal (`web` 40/h, `whatsapp` 30/h, `email` 20/h,
  `team` 120/h, `public` 15/h + 40/h je IP), Werkzeuge 80/h je Aktor.

## Fehler und Fallbacks

- 403 von Magicline → Capability gemerkt (6 h), Werkzeug nicht mehr angeboten,
  kundentauglicher Text, Übergabe angeboten. Nie ein roher API-Text an Kunden.
- Kein KI-Anbieter/Guardrail: `no_ai`, ehrliche Antwort; WhatsApp fällt auf den
  bisherigen Weg zurück; kein Retry bei Konfigurationsfehlern.
- Kein Speicher in Produktion: keine Bestätigungen (fail-closed), kein Event-Dedup –
  die Bestandsverarbeitung läuft unverändert.
- Mock in Produktion wirkungslos; Health und Statusseite zeigen es als Warnung.

## Daten und Logs

- Audit (`finnaud:*`) ohne Freitext: nur Kennungen, Status, Risiko, Fehlerklasse.
- Timeline (`finntl:*`) enthält Ereignisse, keine Chat-Inhalte, keine Gesundheitsdaten.
- Konversationsgedächtnis (`finnconv:*`, 12 h) enthält nur Steuerzustand.
- Keine `console.log`-Ausgaben mit Prompt-, Antwort- oder Gesundheitsinhalten in `lib/finn/`.
- Keine API-Keys im Frontend; der Chat kennt nur `confirm.id`, Vorschau und Risiko.

## Datenschutz

- Datenminimierung im Prompt wie bisher (Vorname, Tarif, aggregierte Live-Daten).
- Gesundheitsangaben: FINN greift sie nur auf, wenn die Person sie nennt; die Übergabe
  ans Team fordert eine Zusammenfassung **ohne** Gesundheitsdetails.
- Langzeitgedächtnis bleibt Opt-in (`lib/finnMemory.js`, unverändert).
