# Verzeichnis von Verarbeitungstätigkeiten und TOM

Stand: 21. Juli 2026 · Freigabe durch Verantwortlichen ausstehend

Verantwortlicher: **Fit-Inn Trier – vollständige Firma, Anschrift und Kontakt ergänzen**  
Datenschutzkontakt: **ergänzen**

## VVT-Kern

| Verarbeitung | Betroffene/Daten | Zweck | Rechtsgrundlage (Entwurf) | Empfänger/Auftragsverarbeiter | Löschung |
|---|---|---|---|---|---|
| Mitgliedskonto/Vertrag | Stamm-, Kontakt-, Vertrags-, Zahlungsdaten | Vertrag, Zugang, Abrechnung | Art. 6 Abs. 1 b/c DSGVO | Magicline/Sport Alliance, Vercel | Vertragsende plus gesetzliche Fristen |
| Training/Fortschritt | Trainingspläne, Check-ins, Übungen, freiwillige Ziele | Vertragliche Trainingsleistung | Art. 6 Abs. 1 b DSGVO; bei Gesundheitsbezug zusätzlich Art. 9 Abs. 2 a | Vercel, KV-Anbieter | grundsätzlich 13 Monate Inaktivität bzw. Selbstlöschung; Frist final freigeben |
| Ernährung/Körperanalyse | Ernährung, Allergien, Gewicht, Umfänge, InBody-Werte | Persönlicher Verlauf und Pläne | Art. 6 Abs. 1 a und Art. 9 Abs. 2 a DSGVO | Vercel, KV-Anbieter, AWS nur bei KI-Funktion | bis Widerruf/Selbstlöschung; technisch je Modul begrenzt |
| Vital-/Wearable-Daten | Puls, HRV, Schlaf, Bereitschaft | Wellness- und Trainingsempfehlung | Art. 6 Abs. 1 a und Art. 9 Abs. 2 a DSGVO | Vercel, KV-Anbieter, AWS nur bei KI-Auswertung | bis Widerruf/Selbstlöschung; Rohdaten minimieren |
| FINN über Bedrock | aktuelle Anfrage plus erforderlicher Kontext | Persönliche Trainings-/Ernährungshilfe | Art. 6 Abs. 1 a/b; Art. 9 Abs. 2 a bei Gesundheitsdaten | Vercel, AWS Bedrock | Bedrock: keine Kontodatenaufbewahrung; App nur soweit funktional nötig |
| Einwilligungsnachweis | Zweck, Text-Hash, Version, Zeitpunkt, Status | Rechenschafts- und Nachweispflicht | Art. 6 Abs. 1 c, Art. 7 Abs. 1 DSGVO | Vercel, KV-Anbieter | 6 Jahre nach Ereignis; Frist rechtlich bestätigen |
| Community/Support | Anzeigename, Verbindungen, Chats, Supportnachrichten | Freiwillige Vernetzung/Support | Art. 6 Abs. 1 a/b/f je Vorgang | Vercel, KV-Anbieter, Fit-Inn-Team | Community bei Deaktivierung; Support nach Vorgangs-/Nachweisfrist |
| WhatsApp-Journeys: Terminerinnerungen (ab 29.09.2026, `lib/journeys`) | Rufnummer, Vorname, gebuchte Termine (Probetraining, Einführung) | Erinnerung an gebuchte Termine, Hinweise zur Mitgliedschaft | Art. 6 Abs. 1 a (Einwilligung `wa_service`) bzw. b | Twilio (BSP), WhatsApp Ireland/Meta, Vercel, KV-Anbieter | Zustand 400 Tage nach letzter Änderung; Einwilligungsnachweis 3 Jahre; Selbstlöschung in der App |
| WhatsApp-Journeys: Motivation, Tipps, Angebote | Rufnummer, Vorname, Anzahl/Häufigkeit der Check-ins (Tage, Wochen), Wochenziel, Einstufung (z. B. „rutscht ab") | Mitgliederbindung, Werbung per Messenger (UWG § 7) | Art. 6 Abs. 1 a (Einwilligung `wa_marketing`, Double-Opt-in per START-Code bzw. „Ja, gern") | wie oben | Besuchstage 70 Tage, Wochenwerte 30 Wochen; Rest wie oben |
| WhatsApp-Lead-Agent (Probetraining) | Rufnummer, Name, Geburtsdatum (Magicline-Pflicht), Ziel/Erfahrung/Tageszeit (feste Werte), Nachrichten | Anfrage beantworten, Probetraining buchen | Art. 6 Abs. 1 b (vorvertraglich); Erinnerungen/Tipps nach Einwilligung | Twilio, Meta, AWS Bedrock (EU, keine Aufbewahrung), Magicline, Vercel | Lead 1 Jahr; Gesprächsverlauf 12 h im KI-Gedächtnis; Vorgang nach Postfach-Frist |
| STOP-Sperrliste | HMAC der Rufnummer, Zeitpunkt | Nachweis des Widerspruchs, Sperre künftiger Nachrichten | Art. 6 Abs. 1 c/f | Vercel, KV-Anbieter | 3 Jahre |
| WhatsApp-Journeys: Versandprotokoll | Zeitpunkt, interne Personen-Id bzw. Lead-Id, Vorname (bei Anzeige), Ablauf/Schritt, Vorlage, Zustellstand, Rufnummer nur maskiert (letzte 2 Ziffern); **kein Nachrichtentext** | Kontrolle durch die Leitung, was versendet wurde und ob es ankam | Art. 6 Abs. 1 f | Vercel, KV-Anbieter | 90 Tage, höchstens 500 Einträge; entfällt bei Löschung der App-Daten |

## Technische und organisatorische Maßnahmen (Art. 32)

- **Zugriff:** Mitgliedersitzungen, Rollen-/Rechtekonzept, minimale AWS-IAM-Rechte, Vercel-OIDC mit kurzlebigen Tokens, kein dauerhafter AWS-Schlüssel.
- **Übertragung:** TLS/HSTS, sichere Cookies, `no-store`, restriktive Referrer- und Content-Type-Header.
- **Speicherung:** getrennte Mitgliederschlüssel, serverseitige Autorisierung, Ablaufzeiten und Löschfunktionen; Bedrock-Kontodatenaufbewahrung `none`.
- **Vertraulichkeit:** sensible Variablen nur serverseitig, Secret-Scan, keine Prompt-/Gesundheitsdaten in regulären Logs, keine Weitergabe für Werbung oder Modelltraining.
- **Integrität:** validierte Eingaben, serverseitige Einwilligungsprüfung, versionierte Ereignisse, reproduzierbarer Einwilligungstext-Hash.
- **Verfügbarkeit:** Anbieter-Backups/Notfallverfahren vertraglich prüfen; Ausfall führt zu sicherer Fehlermeldung statt unkontrolliertem Anbieterwechsel.
- **Kontrolle:** Test-, Lint- und Secret-Scan; CloudTrail für AWS-Aufrufe; regelmäßige Rechte-, Dienstleister- und Löschprüfung.
- **Datenschutz durch Technikgestaltung:** Datenminimierung, modulbezogene Einwilligungen, Opt-in statt vorausgewählter Zustimmung, Export und Löschung in der App.
- **WhatsApp-Journeys:** getrennte Einwilligungen je Nummer (Service/Motivation) mit Text-Hash und Version; STOP vor jeder KI; Ruhezeiten, Kappen (höchstens 2 Motivationsnachrichten pro Woche), Sperren bei Kündigung/offenem Vorgang; Probelauf als Standard; Kennzahlen ohne Kennungen; keine Nachrichteninhalte in Logs; keine Gesundheitsdaten in Vorlagen oder Prompts.

## Incident-Ablauf

1. Vorfall isolieren, Beweise sichern, keine Gesundheitsdaten in Tickets kopieren.
2. Datenschutzkontakt und Geschäftsführung unverzüglich informieren.
3. Risiko, Umfang, Kategorien, Betroffene und Gegenmaßnahmen dokumentieren.
4. Bei meldepflichtigem Risiko Aufsichtsbehörde grundsätzlich binnen 72 Stunden nach Bekanntwerden informieren; bei hohem Risiko Betroffene ohne unangemessene Verzögerung informieren.
5. Ursache beheben, Tokens/Sitzungen widerrufen, Abschluss- und Verbesserungsbericht ablegen.

