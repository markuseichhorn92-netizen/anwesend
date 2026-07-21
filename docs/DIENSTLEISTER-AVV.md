# Dienstleister- und AVV-Register

Keine Zeile gilt allein durch dieses Dokument als vertraglich abgeschlossen. Vertragsnummer, Abschlussdatum, Region, Unterauftragnehmerliste und Löschbestätigung sind in der echten Vertragsakte zu ergänzen.

| Anbieter | Rolle/Zweck | Daten | Erforderliche Prüfung | Status |
|---|---|---|---|---|
| Amazon Web Services EMEA SARL | Auftragsverarbeiter; Bedrock-Inferenz | notwendiger Prompt-Kontext, ggf. Gesundheitsdaten | AWS DPA, Region/Geo-Profil, Unterauftragnehmer, Retention `none`, Transfermechanismus | offen zu belegen |
| Vercel | Hosting, Functions, OIDC | Konto-, Nutzungs- und freiwillige App-Daten | DPA, Regionen, Logs, Unterauftragnehmer, Löschung | offen zu belegen |
| Upstash/Vercel KV bzw. tatsächlich eingesetzter Store | App-Datenspeicher | Profile, Pläne, Fortschritt, Einwilligungen | DPA, Datenregion, Backup-/Löschfristen | Anbieter konkret bestätigen |
| Magicline / Sport Alliance / EGYM | Mitglieder- und Vertragsverwaltung | Stamm-, Vertrags-, Zahlungs-, Check-in-Daten | Vertragsrolle, AVV, Exporte/Löschung, Unterauftragnehmer | offen zu belegen |
| Google | reCAPTCHA/ggf. Karten oder OAuth | Geräte-/Netzwerk- und Sicherheitsdaten | Rechtsgrundlage, Consent/CMP soweit nötig, Transferinformation | Nutzung prüfen |
| Apple/Google Push | Pushzustellung | Push-Token, Nachricht-Metadaten | minimale Inhalte, keine Gesundheitsdaten im Pushtext, Anbieterbedingungen | Nutzung prüfen |
| Resend/Twilio oder sonstige Kommunikationsanbieter | E-Mail/SMS, falls aktiv | Kontakt- und Zustelldaten | AVV, Region, Löschung, Transfer | nur bei Aktivierung aufnehmen |
| Open Food Facts | Produktdatenabfrage | Barcode/Produktanfrage | keine Mitglieds-ID mitsenden; Datenschutzinformation | technisch prüfen |

## Prüfrhythmus

- vor Einsatz oder wesentlicher Änderung;
- mindestens jährlich;
- bei neuer Region, neuem Unterauftragnehmer oder Sicherheitsvorfall;
- Nachweise als datierte PDF/Vertragskopie außerhalb des Quellcodes ablegen.

