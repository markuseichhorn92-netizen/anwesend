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

## Technische und organisatorische Maßnahmen (Art. 32)

- **Zugriff:** Mitgliedersitzungen, Rollen-/Rechtekonzept, minimale AWS-IAM-Rechte, Vercel-OIDC mit kurzlebigen Tokens, kein dauerhafter AWS-Schlüssel.
- **Übertragung:** TLS/HSTS, sichere Cookies, `no-store`, restriktive Referrer- und Content-Type-Header.
- **Speicherung:** getrennte Mitgliederschlüssel, serverseitige Autorisierung, Ablaufzeiten und Löschfunktionen; Bedrock-Kontodatenaufbewahrung `none`.
- **Vertraulichkeit:** sensible Variablen nur serverseitig, Secret-Scan, keine Prompt-/Gesundheitsdaten in regulären Logs, keine Weitergabe für Werbung oder Modelltraining.
- **Integrität:** validierte Eingaben, serverseitige Einwilligungsprüfung, versionierte Ereignisse, reproduzierbarer Einwilligungstext-Hash.
- **Verfügbarkeit:** Anbieter-Backups/Notfallverfahren vertraglich prüfen; Ausfall führt zu sicherer Fehlermeldung statt unkontrolliertem Anbieterwechsel.
- **Kontrolle:** Test-, Lint- und Secret-Scan; CloudTrail für AWS-Aufrufe; regelmäßige Rechte-, Dienstleister- und Löschprüfung.
- **Datenschutz durch Technikgestaltung:** Datenminimierung, modulbezogene Einwilligungen, Opt-in statt vorausgewählter Zustimmung, Export und Löschung in der App.

## Incident-Ablauf

1. Vorfall isolieren, Beweise sichern, keine Gesundheitsdaten in Tickets kopieren.
2. Datenschutzkontakt und Geschäftsführung unverzüglich informieren.
3. Risiko, Umfang, Kategorien, Betroffene und Gegenmaßnahmen dokumentieren.
4. Bei meldepflichtigem Risiko Aufsichtsbehörde grundsätzlich binnen 72 Stunden nach Bekanntwerden informieren; bei hohem Risiko Betroffene ohne unangemessene Verzögerung informieren.
5. Ursache beheben, Tokens/Sitzungen widerrufen, Abschluss- und Verbesserungsbericht ablegen.

