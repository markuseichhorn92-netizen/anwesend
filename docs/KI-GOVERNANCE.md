# KI-Governance für FINN

## Systeminventar

| System | Modellzugang | Zweck | Menschliche Kontrolle | Verbotene Nutzung |
|---|---|---|---|---|
| FINN Coach/Pläne/Analysen | Amazon Bedrock, Anthropic-Modell über EU-Inferenzprofil | Wellness, Training, Ernährung | Mitglied entscheidet; Fit-Inn-Team als Eskalation | Diagnose, Therapie, Notfallberatung, Vertrags-/Preisentscheidung, Mitarbeiterbewertung |

## Betriebsregeln

- Produktionsverkehr darf nicht auf direkte Anthropic-API-Schlüssel zurückfallen.
- Nur freigegebene AWS-Regionen/Geo-Inferenzprofile; Modell-/Profilwechsel erfordern Datenschutz- und Sicherheitstest.
- Keine vollständigen Namen, Kontaktdaten, Vertragsnummern oder Freitextakten in Prompts, sofern nicht für die konkrete Anfrage zwingend.
- Gesundheitsdaten nur nach gültiger modulspezifischer Einwilligung; Widerruf beendet weitere optionale Verarbeitung.
- Antworten müssen Unsicherheit und Grenzen respektieren; bei Beschwerden, Verletzung, Essstörung, akuter Gefahr oder medizinischen Fragen an qualifizierte Stellen verweisen.
- Keine KI-Ausgabe löst automatisch Vertrags-, Zugangs-, Preis- oder sonstige erhebliche Entscheidungen aus.
- Fehlantworten und Sicherheitsvorfälle werden ohne unnötige Gesundheitsdetails erfasst, bewertet und zur Verbesserung von Prompts/Tests genutzt.

## Freigabecheck für Änderungen

1. Datenkategorien und Rechtsgrundlage unverändert?
2. Empfänger, Region, Retention und Unterauftragnehmer unverändert?
3. Einwilligungstext und Datenschutzerklärung noch korrekt?
4. Prompt-Injection, Datenabfluss, medizinische Grenzfälle und Halluzination getestet?
5. Fallback sicher und ohne verdeckten Anbieterwechsel?
6. Modell-/Profil-ID, IAM-Ressourcen und Kostenlimit geprüft?
7. Mitarbeitende informiert/geschult und Änderung dokumentiert?

## KI-Kompetenz

Trainer und Support erhalten vor Nutzung sowie jährlich eine dokumentierte Schulung zu: KI-Grenzen, Gesundheitsdaten, Einwilligung/Widerruf, Erkennen gefährlicher Antworten, menschlicher Eskalation, Datenpannen und sicherer Prompt-Nutzung.

