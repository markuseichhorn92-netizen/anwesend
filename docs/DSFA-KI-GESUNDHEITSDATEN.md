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

## Nachtrag 29. September 2026: WhatsApp-Journeys und Lead-Agent

Neu: Auswertung der Check-in-Häufigkeit je Mitglied (Einstufung „auf Kurs", „rutscht ab",
„10/14/21/28 Tage nicht da") und darauf gestützte WhatsApp-Nachrichten; ein KI-Agent
beantwortet Interessenten und bucht Probetrainings (Bestätigung durch die Person).

- **Profiling (Art. 4 Nr. 4, Art. 22):** Die Einstufung löst nur Nachrichten bzw. eine
  Team-Hinweis im Posteingang aus – keine rechtlich oder ähnlich erheblich wirkende Entscheidung. Grundlage
  ist die Einwilligung `wa_marketing`, deren Text die Auswertung der Check-ins nennt.
- **Keine Gesundheitsdaten:** Vorlagen und Prompts enthalten nur Vorname, Termin,
  Besuchszahlen und Wochenziel; das Ziel „gesundheit" ist ein grober Wert ohne Befund.
  Der Lead-Agent fragt keine Gesundheitsdetails ab.
- **Messenger/Drittland:** Nachrichten laufen über Twilio und Meta (USA-Bezug) – im
  Dienstleister-Register geführt; AVV und Transfermechanismus vor dem Echtbetrieb belegen.
- **Werbung (UWG § 7):** Motivation und Angebote nur mit ausdrücklicher Einwilligung;
  die Einladungsaktion an Bestandsnummern ist standardmäßig aus und erst nach
  Rechtsprüfung einzuschalten.

| Risiko | Ausgangsrisiko | Maßnahmen | Restrisiko |
|---|---:|---|---:|
| Belästigende Werbung / fehlende Einwilligung | hoch | getrennte Einwilligungen je Nummer, Double-Opt-in, STOP vor jeder KI, Kappen, Ruhezeiten, Probelauf-Standard | niedrig–mittel |
| Fehlbuchung durch KI | mittel | Buchung nur nach ausdrücklichem „Ja", Termin muss in der aktuellen Slot-Liste stehen, Rufnummer aus dem Webhook | niedrig |
| Nachrichten an falsche Person | mittel | Nummer wird per START-Code bewiesen, Sperren bei ungültiger Nummer, Testnummern im Pilot | niedrig |

## Entscheidung und Freigabe

Vor Go-live sind AVV, Unterauftragnehmer, tatsächliche AWS-Inferenzroute, Aufbewahrungsnachweis und Löschtest zu belegen. Verbleibt ein hohes, nicht ausreichend gemindertes Risiko, ist vor der Verarbeitung die zuständige Aufsichtsbehörde nach Art. 36 DSGVO zu konsultieren.

Verantwortlicher / Datum / Unterschrift: ____________________  
Datenschutzberatung / Datum / Stellungnahme: ____________________

## Nachtrag 29. September 2026: WhatsApp erkennt Mitglieder an der Nummer

Neu: Die WhatsApp-KI erkennt Mitglieder an der Absendernummer, ohne Bestätigungs-Link
(Geburtsdatum + E-Mail). Details: `docs/WHATSAPP-KI.md`.

- **Identität:** nur bei eindeutiger Zuordnung (genau ein Kunde mit laufendem Vertrag
  bzw. eigene Verknüpfung); sonst Geburtsdatum im Chat, serverseitig geprüft.
- **Gesundheitsdaten (Art. 9):** nur nach ausdrücklicher Einwilligung im Chat
  (`wa_ai_health`, versioniert, Nachweis im Datenschutz-Protokoll, Widerruf im Chat).
- **Telefon-Hotline unverändert streng** (Anruferkennung fälschbar).

| Risiko | Ausgangsrisiko | Maßnahmen | Restrisiko |
|---|---:|---|---:|
| Auskunft an falsche Person (geteilte Nummer) | mittel | geteilte Nummer → Geburtsdatum, keine Namen anderer Konten, 3 Fehlversuche → Team | niedrig |
| Neu vergebene Nummer hängt noch am alten Mitglied | mittel | nur laufende Verträge, Auskunft nur auf Nachfrage, Gesundheitsdaten nur nach „Ja", Heikles ans Team | niedrig–mittel; vom Verantwortlichen zu bewerten |
| Fremdes Handy (Zugriff auf das Gerät) | niedrig–mittel | wie bei App/Mail: Besitz des Geräts; keine Bankdaten-/Kündigungsaktionen ohne Team | niedrig–mittel |

