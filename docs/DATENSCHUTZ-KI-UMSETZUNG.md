# Datenschutz- und KI-Umsetzung

Stand: 21. Juli 2026 · Arbeitsversion 2026-07-21.1

Dieses Verzeichnis dokumentiert die technischen und organisatorischen Maßnahmen der Fit-Inn-Trier-Mitglieder-App. Es ersetzt keine Freigabe durch die verantwortliche Stelle oder deren Datenschutzberatung.

## Technisch umgesetzt

- Produktions-KI ausschließlich über Amazon Bedrock und kurzlebige Vercel-OIDC-Zugangsdaten; direkte Anthropic-Schlüssel sind in Produktion gesperrt.
- Keine Speicherung von Bedrock-Eingaben und -Ausgaben im Bedrock-Mantle-Konto; zusätzlich ist eine AWS-Guardrail vorbereitet.
- Explizite, versionierte Einwilligungen für Gesundheitsprofil, Ernährung, Vitalwerte, Körperanalyse, Lebensstil, FINN-Gedächtnis, Teamfreigabe und Community.
- Nachweis je Einwilligungsereignis mit Zeitpunkt, Zweck, Datenkategorien, Empfängern, Policy-Version und SHA-256-Hash des Einwilligungstextes.
- Widerruf ohne Auswirkung auf die Rechtmäßigkeit der vorherigen Verarbeitung.
- Selbstbedienungs-Export als JSON und Löschung freiwilliger App-Daten; Vertrags- und Abrechnungsdaten in Magicline bleiben dem gesetzlichen Löschkonzept unterworfen.
- Serverseitige Zugriffskontrolle, Rate Limits, `no-store`, restriktive AWS-IAM-Rolle und keine dauerhaften AWS-Schlüssel in Vercel.
- FINN ist Wellness-/Trainingsunterstützung: keine Diagnose, keine Therapie, keine vollautomatische Entscheidung mit rechtlicher oder ähnlich erheblicher Wirkung.

## Vor Produktionsfreigabe organisatorisch abzuschließen

1. AVV/DPA mit AWS, Vercel, dem eingesetzten KV-Anbieter und Magicline/Sport Alliance in der Vertragsakte ablegen und Unterauftragnehmer prüfen.
2. DSFA durch Verantwortlichen und Datenschutzberatung prüfen, Restrisiko entscheiden und unterschreiben.
3. VVT und TOM mit realen Ansprechpartnern, Hosting-/Backup-Fristen und Vertragsnummern vervollständigen.
4. AWS-Nullspeicherung mit `get-account-data-retention` nachweisen; Guardrail je nach Kontostruktur als SCP oder Organisationsrichtlinie aktivieren.
5. Lösch- und Auskunftstest mit einem Testkonto durchführen und Ergebnis protokollieren.
6. Beschäftigte/Trainer zu KI-Grenzen, Gesundheitsdaten, Datenpannen und menschlicher Kontrolle schulen; Teilnahme dokumentieren.
7. Datenschutzerklärung, Impressum und Einwilligungstexte durch die verantwortliche Stelle veröffentlichen/freigeben.

## Dokumente

- [VVT und TOM](./VVT-TOM.md)
- [DSFA-Entwurf](./DSFA-KI-GESUNDHEITSDATEN.md)
- [Dienstleister- und AVV-Register](./DIENSTLEISTER-AVV.md)
- [KI-Governance](./KI-GOVERNANCE.md)
- [AWS Bedrock Guardrails](./aws/README.md)

## Rechtsrahmen

Maßgeblich sind insbesondere DSGVO Art. 5, 6, 7, 9, 12–22, 25, 28, 30, 32–36 und 44 ff., § 22 BDSG sowie – soweit einschlägig – die Pflichten der EU-KI-Verordnung. Die Rechtsgrundlage jeder Verarbeitung muss im VVT final durch die verantwortliche Stelle festgelegt werden.

