# DSFA-Entwurf: FINN und Gesundheitsdaten

Stand: 21. Juli 2026 · **nicht freigegeben**

## Verarbeitung

Mitglieder können freiwillig Gesundheits-, Körper-, Ernährungs-, Vital- und Trainingsdaten eingeben. Von ihnen gestartete FINN-Funktionen senden nur den notwendigen Kontext serverseitig an Anthropic-Modelle über Amazon Bedrock. Ergebnisse dienen Wellness, Training und Ernährung; sie ersetzen keine medizinische Beratung und lösen keine rechtlich oder ähnlich erheblich wirkende automatische Entscheidung aus.

## Erforderlichkeit und Verhältnismäßigkeit

- Jede sensible Kategorie ist modular und ausdrücklich einwilligungsbasiert.
- Kernfunktionen bleiben soweit möglich ohne KI bzw. ohne Gesundheitsprofil nutzbar.
- Gesundheitsdaten werden nicht zu Werbung, Profilhandel oder Modelltraining genutzt.
- Einwilligungen sind nachweisbar, widerrufbar und mit Export/Löschung verbunden.
- Bedrock ist auf EU-Verarbeitung und keine Kontodatenaufbewahrung auszurichten; direkter Anthropic-Produktivzugriff ist technisch gesperrt.

## Risikobewertung

| Risiko | Ausgangsrisiko | Maßnahmen | Restrisiko |
|---|---:|---|---:|
| Unbefugter Zugriff auf Gesundheitsdaten | hoch | Sessionprüfung, OIDC, Least Privilege, TLS, keine Browser-Schlüssel, Löschung | mittel |
| Datenabfluss an KI-/Cloudanbieter | hoch | AWS als Vertragspartner, EU-Geo-Inferenzprofil, keine Bedrock-Aufbewahrung, Datenminimierung, keine Logs | mittel |
| Falsche oder gefährliche KI-Empfehlung | hoch | keine Diagnose, sichere Systemprompts, menschlicher Ansprechpartner, klare Hinweise, Tests | mittel |
| Fehlende/fingierte Einwilligung | hoch | serverseitige Prüfung, Opt-in, Text-Hash, Version, Zeit und Widerrufsereignis | niedrig–mittel |
| Überlange Speicherung | mittel–hoch | TTLs, modulspezifische Löschung, Selbstbedienung, jährlicher Löschtest | mittel |
| Drittlandzugriff/Unterauftragnehmer | hoch | AVV, Unterauftragnehmerprüfung, TIA/SCC falls erforderlich, EU-Verarbeitung | mittel; vertraglich zu bestätigen |
| Re-Identifikation in Logs/Support | mittel | keine Payload-Logs, pseudonyme technische IDs, Supportschulung | niedrig–mittel |

## Entscheidung und Freigabe

Vor Go-live sind AVV, Unterauftragnehmer, tatsächliche AWS-Inferenzroute, Aufbewahrungsnachweis und Löschtest zu belegen. Verbleibt ein hohes, nicht ausreichend gemindertes Risiko, ist vor der Verarbeitung die zuständige Aufsichtsbehörde nach Art. 36 DSGVO zu konsultieren.

Verantwortlicher / Datum / Unterschrift: ____________________  
Datenschutzberatung / Datum / Stellungnahme: ____________________

