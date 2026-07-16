# Trainingspartner-Community — Rechtstexte (ENTWURF zur anwaltlichen Prüfung)

> **Wichtig:** Dieses Dokument ist ein **Entwurf/Vorlage** für die Erweiterung eurer
> Website-AGB und -Datenschutzerklärung um das **Trainingspartner-/Community-Feature**
> (Mitglied-zu-Mitglied: Verbinden per Code, 1:1- und Gruppen-Chat, gemeinsame
> Trainingszeiten, Challenges, geteilte Aktivitäts-/Ernährungs-Signale). Es ist
> **keine Rechtsberatung**. Vor dem Community-Launch (`SOCIAL_LAUNCH=true`) von einem
> Anwalt prüfen lassen und die **Platzhalter** (`[...]`) mit euren echten Daten füllen.

## 0. Was in der App bereits umgesetzt ist (Stand: Feature hinter `SOCIAL_LAUNCH=false`)

- **Reines Opt-in mit Einwilligung.** Das Feature ist standardmäßig aus. Erst nach
  aktiver Zustimmung (Anzeigename + gewählte Freigaben, Checkbox „einverstanden")
  wird ein Mitglied sichtbar. Zeitpunkt der Einwilligung wird gespeichert
  (`consentAt`) und ist im DSGVO-Datenexport enthalten.
- **Kein durchsuchbares Verzeichnis.** Verbindung ausschließlich über einen
  persönlichen Code + beidseitige Bestätigung. Es gibt keine Mitgliedersuche.
- **Datensparsamkeit.** An andere Mitglieder werden nur der selbstgewählte
  Anzeigename + Initialen sowie die **selbst freigegebenen** Aktivitäts-Signale
  (Trainings-Aktivität, Streak/Vitalpunkte, optional Ernährungs-Streak/Tagesziel)
  übermittelt. **Niemals** E-Mail, Adresse, Telefon, Geburtsdatum oder Zahlungsdaten.
- **Altersgrenze ≥ 16 Jahre**, server-seitig anhand des hinterlegten Geburtsdatums
  geprüft.
- **Widerruf jederzeit.** „Trainingspartner deaktivieren" macht den Code ungültig,
  entfernt das Mitglied aus der Sichtbarkeit und **bereinigt reziprok** Verbindungen,
  Chats, Gruppen-Mitgliedschaften und Verabredungen.
- **Melden & Blockieren** in jedem Chat; **Studio-Moderation** (Meldungen prüfen,
  Mitglieder sperren) und **globaler Notaus** (Feature abschaltbar) im Team-Backend.
- **In-App-Regeln & Datenschutzhinweis** („Regeln & Datenschutz", erreichbar aus dem
  Onboarding und aus der Community-Ansicht): Datensparsamkeits-Zusagen, Altersgrenze,
  Verhaltensregeln, Melde-/Sperrwege.
- **Nachrichten-Aufbewahrung:** je Unterhaltung werden nur die letzten Nachrichten
  gespeichert (technischer Cap), Löschung beim Deaktivieren.
- **Demo-/Test-Buddy** (Code `TEST99`) nur zum Ausprobieren; über die Umgebungs-
  variable `SOCIAL_DEMO=0` abschaltbar. **Vor dem echten Launch abschalten.**

## 1. Firmendaten (bitte ausfüllen)

| Feld | Wert |
|---|---|
| Vollständige Firmierung | `[z. B. Fit-Inn Trier … / Inhaber …]` |
| Anschrift | `[Straße Nr., PLZ Trier]` |
| Verantwortliche(r) i. S. d. DSGVO | `[Name]` |
| Kontakt für Meldungen/Datenschutz | `[community@fit-inn-trier.de bzw. datenschutz@…]` |
| Datenschutzbeauftragte(r) (falls vorhanden) | `[…]` |

## 2. AGB-Zusatz „Trainingspartner-Community" (Entwurf)

**§ A Gegenstand.** Die Trainingspartner-Community ist eine kostenlose, freiwillige
Zusatzfunktion der Mitglieder-App. Mitglieder können sich über einen persönlichen Code
gegenseitig als Trainingspartner hinzufügen, miteinander chatten (einzeln und in
Gruppen), gemeinsame Trainingszeiten verabreden, sich anfeuern/challengen und – soweit
freigegeben – ausgewählte Aktivitäts-Signale teilen. Ein Anspruch auf Verfügbarkeit
besteht nicht; die Funktion kann jederzeit geändert oder eingestellt werden.

**§ B Teilnahme & Alter.** Die Teilnahme ist freiwillig und setzt eine ausdrückliche
Einwilligung voraus. Die Nutzung ist **erst ab 16 Jahren** zulässig.

**§ C Verhaltensregeln.** Nutzer verpflichten sich, im Chat und in Gruppen respektvoll
zu bleiben. Untersagt sind insbesondere: Beleidigung, Belästigung, Diskriminierung,
Bedrohung, Mobbing; Spam und Werbung; betrügerische, sexuelle, gewaltverherrlichende,
illegale oder jugendgefährdende Inhalte; das Verbreiten sensibler personenbezogener
Daten Dritter; sowie eine gewerbliche Nutzung. Freigegebene Aktivitäts-/Ernährungsdaten
anderer sind vertraulich zu behandeln und dürfen nicht an Dritte weitergegeben werden.

**§ D Moderation & Sanktionen.** Mitglieder können Inhalte melden und andere Nutzer
blockieren. `[Fit-Inn Trier]` ist berechtigt, gemeldete Inhalte zu prüfen, Verbindungen
zu trennen, Mitglieder von der Community auszuschließen und das Feature ganz oder
teilweise vorübergehend oder dauerhaft abzuschalten. Bei schwerwiegenden oder
wiederholten Verstößen kann der Zugang zur Community entzogen werden.

**§ E Verantwortlichkeit für Inhalte.** Für die von Nutzern erstellten Inhalte
(Nachrichten, Anzeigenamen etc.) sind die jeweiligen Nutzer selbst verantwortlich.
`[Fit-Inn Trier]` macht sich diese nicht zu eigen und übernimmt keine Gewähr für von
Mitgliedern verabredete Trainings oder deren Verhalten außerhalb der App.

**§ F Widerruf/Deaktivierung.** Die Teilnahme kann jederzeit und ohne Angabe von
Gründen in der App beendet werden („Trainingspartner deaktivieren"). Dabei werden die
eigenen Community-Daten (Verbindungen, Chats, Gruppen-Mitgliedschaften, Verabredungen)
entfernt bzw. reziprok bereinigt.

## 3. Datenschutz-Zusatz „Trainingspartner-Community" (Entwurf)

**Zweck & Rechtsgrundlage.** Verarbeitet werden Community-Daten ausschließlich, um die
freiwillige Trainingspartner-Funktion bereitzustellen. Rechtsgrundlage ist die
**Einwilligung** (Art. 6 Abs. 1 lit. a DSGVO), die jederzeit mit Wirkung für die
Zukunft widerrufen werden kann (Deaktivierung in der App).

**Verarbeitete/übermittelte Daten.** Anzeigename und Initialen (frei wählbar), die
selbst gewählten Freigaben (Trainings-Aktivität, Streak/Vitalpunkte, optional
Ernährungs-Streak/Tagesziel), Verbindungen zu anderen Mitgliedern, Chat-Nachrichten
(1:1 und Gruppe), gemeinsame Trainingsverabredungen sowie Meldungen an das Studio.
**Nicht** an andere Mitglieder übermittelt werden E-Mail, Anschrift, Telefonnummer,
Geburtsdatum oder Zahlungsdaten.

**Sichtbarkeit.** Andere Mitglieder sehen nur, was das Mitglied freigegeben hat, und
nur, wenn eine Verbindung besteht (bzw. in gemeinsamen Gruppen). Es existiert kein
öffentliches oder durchsuchbares Profilverzeichnis.

**Empfänger.** Andere teilnehmende Mitglieder (im Rahmen von Verbindungen/Gruppen)
sowie das Studio-Team im Rahmen der Moderation (Meldungen). Hosting/Datenspeicherung
über `[Vercel / Upstash – wie in der übrigen Datenschutzerklärung beschrieben]`.

**Speicherdauer.** Community-Daten werden bis zur Deaktivierung bzw. bis zum Ende der
Mitgliedschaft gespeichert. Chat-Nachrichten werden je Unterhaltung technisch begrenzt
vorgehalten (nur die jeweils letzten Nachrichten) und bei Deaktivierung gelöscht.
Meldungen werden zur Bearbeitung durch das Studio befristet vorgehalten.

**Betroffenenrechte.** Auskunft, Berichtigung, Löschung, Einschränkung, Widerspruch,
Datenübertragbarkeit und Widerruf der Einwilligung. Die eigenen Community-Daten sind
Teil des **DSGVO-Datenexports** in der App.

**Push-Benachrichtigungen.** Bei Community-Ereignissen (neue Nachricht/Anfrage,
Verabredung, Anfeuern) können – nur mit entsprechender Einwilligung (Kategorie
`pushSocial`) – Push-Benachrichtigungen versendet werden; abschaltbar in den
Einstellungen.

## 4. Vor dem Launch — Checkliste

- [ ] Platzhalter (`[...]`) mit echten Firmen-/Kontaktdaten füllen.
- [ ] AGB-Zusatz (§ 2) und Datenschutz-Zusatz (§ 3) anwaltlich prüfen lassen und auf
      der Website veröffentlichen bzw. in die bestehenden Dokumente einarbeiten.
- [ ] In der App bleibt die Einwilligung Opt-in; ggf. Verlinkung der veröffentlichten
      Community-AGB/Datenschutz im Onboarding ergänzen.
- [ ] **Demo-Buddy abschalten:** `SOCIAL_DEMO=0` setzen.
- [ ] Erst danach `SOCIAL_LAUNCH=true` (separat, bewusst) setzen.
