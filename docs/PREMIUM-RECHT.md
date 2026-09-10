# Ernährungs-Premium — Rechtstexte (ENTWURF zur anwaltlichen Prüfung)

> **Stand 10. September 2026: Das Abo-Modell ist abgeschaltet** (`FEATURE_ABO`
> nicht gesetzt). FINN und alle Coaching-Funktionen sind für jedes Mitglied
> inklusive; in der App gibt es weder Premium-Kauf noch Widerrufs-Screen noch den
> Rechtstext „Coach Premium & Zahlung". Dieses Dokument bleibt als Vorlage für den
> Fall, dass das Modell wieder eingeschaltet wird.

> **Wichtig:** Dieses Dokument ist ein **Entwurf/Vorlage** für die Erweiterung eurer
> Website-AGB und -Datenschutzerklärung um das **Premium-Angebot** (Ernährungs-
> Premium, Abrechnung als **Magicline-Zusatzmodul per SEPA-Lastschrift über den
> Mitgliedsvertrag**). Es ist **keine Rechtsberatung**. Vor dem
> Premium-Launch von einem Anwalt/Steuerberater prüfen und die **Platzhalter**
> (`[...]`) mit den echten Firmendaten füllen.

## 0. Was in der App bereits umgesetzt ist

- **In-App-Rechtsscreen „Widerruf & Rechtliches"** (`nav 'recht'`, erreichbar aus der
  Fußzeile, aus dem Kauf-Screen und aus „Mein Abo"): §312j-Pflichtinfos,
  Widerrufsbelehrung (amtliches Muster, digitale Dienstleistung) und das
  Muster-Widerrufsformular.
- **Kündigung & Widerruf:** Premium ist ein Magicline-Zusatzmodul; die Abrechnung wird
  über die **Modul-Kündigung** in der App beendet
  (`POST /api/member/modules { action:'cancel-premium' }`, SEPA über den
  Mitgliedsvertrag). Ein Widerruf innerhalb der Frist wird über das
  Muster-Widerrufsformular bzw. eine eindeutige Erklärung (z. B. E-Mail an das Studio)
  erklärt und vom Studio als Vorgang bearbeitet; die Mitgliedschaft selbst bleibt
  unberührt.
- **§312j-Einwilligung** im Kauf-Flow: Checkbox „Ich verlange ausdrücklich, dass … sofort
  begonnen wird …" — ohne Häkchen startet der Kauf nicht.
- **Firmendaten-Platzhalter** stehen zentral in `mitglieder.html` in `var LEGAL={…}`
  (`firma`, `anschrift`, `email`) — **vor Launch mit echten Daten füllen.**

## 1. Firmendaten (bitte ausfüllen)

| Feld | Wert |
|---|---|
| Vollständige Firmierung | `[z. B. Fit-Inn Trier … GmbH / Inhaber …]` |
| Anschrift | `[Straße Nr., PLZ Trier]` |
| Vertretungsberechtigte(r) | `[Name]` |
| E-Mail für Widerruf/Support | `[widerruf@fit-inn-trier.de]` |
| USt-IdNr. / Steuernr. | `[…]` |
| Registergericht/-nummer (falls) | `[…]` |

## 2. AGB-Zusatz „Ernährungs-Premium" (Entwurf)

**§ A Vertragsgegenstand.** Ernährungs-Premium ist eine kostenpflichtige, digitale
Zusatzleistung innerhalb der Mitglieder-App (KI-gestützte Ernährungsfunktionen: Foto-
Analyse, KI-Chat „FINN", KI-Rezepte, Wochenplan, Auswertung). Die kostenlosen
Basisfunktionen bleiben unberührt. Premium wird als kostenpflichtiges **Zusatzmodul
zum Mitgliedsvertrag** gebucht und ist eigenständig – unabhängig von der Mitgliedschaft
– kündbar; die Mitgliedschaft selbst bleibt davon unberührt.

**§ B Preise & Laufzeit.** Der Preis beträgt `[4,99 €]`/Monat inkl. gesetzlicher
USt. Der Vertrag läuft **monatlich** und verlängert sich automatisch um je einen
weiteren Monat, sofern nicht gekündigt wird. Ein etwaiger Gratiszeitraum
(`[7 Tage]`) ist vorab ausgewiesen; nach dessen Ablauf beginnt die kostenpflichtige
Abrechnung.

**§ C Kündigung.** Das Abo ist **jederzeit zum Ende des laufenden, bezahlten
Abrechnungsmonats** kündbar — direkt in der App unter „Mein Abo". Der Zugang bleibt
bis zum Periodenende erhalten.

**§ D Zahlungsabwicklung.** Die Abrechnung erfolgt als **Magicline-Zusatzmodul per
SEPA-Lastschrift über den bestehenden Mitgliedsvertrag**. Es gelten die im
Mitgliedsvertrag hinterlegten SEPA-Mandats-/Bankdaten. In der App werden keine
Kartendaten erhoben oder gespeichert.

**§ E Widerrufsrecht.** Verbraucher haben ein 14-tägiges Widerrufsrecht (siehe
Widerrufsbelehrung, Abschnitt 4). Für die digitale Dienstleistung gilt: Verlangt der
Verbraucher die sofortige Ausführung, ist bei einem Widerruf nach Nutzungsbeginn ein
anteiliger Wertersatz zu leisten; mit vollständiger Vertragserfüllung erlischt das
Widerrufsrecht (§ 356 BGB). Die entsprechende Einwilligung wird im Kauf-Flow
eingeholt.

**§ F Verfügbarkeit/Änderungen.** `[Formulierung durch Anwalt: Verfügbarkeit „nach
dem Stand der Technik", zumutbare Änderungen der Funktionen, Preisänderungen mit
Ankündigung/Sonderkündigungsrecht.]`

**§ G Keine medizinische Beratung.** Die Inhalte dienen der allgemeinen
Ernährungsbildung und ersetzen **keine** medizinische oder diätologische Beratung.

## 3. Datenschutz-Zusatz „Premium/Zahlung (SEPA)" (Entwurf)

**Verantwortlicher:** siehe Impressum (Abschnitt 1).

**Zahlungsabwicklung (SEPA über den Mitgliedsvertrag).** Die Abrechnung des Premium-
Moduls erfolgt per SEPA-Lastschrift über den bestehenden Mitgliedsvertrag; die Buchung,
Verwaltung und Abrechnung des Zusatzmoduls läuft über unser Studioverwaltungssystem
**Magicline** (`[Anbieter/Anschrift ergänzen]`). Verarbeitet werden u. a. Name, die im
Mitgliedsvertrag hinterlegten SEPA-/Bankdaten, Betrag sowie Vertrags-/Rechnungsdaten.
Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung) und lit. f (sichere
Zahlungsabwicklung). Eine Kartenzahlung in der App oder eine Übermittlung von
Zahlungsdaten an einen externen Zahlungsdienstleister findet nicht statt.

**Entitlement/Status.** Wir speichern zum Konto den Premium-Status (aktiv/Test/
gekündigt, Laufzeitende, Kennung des gebuchten Zusatzmoduls) zur Bereitstellung der
Leistung.

**Widerruf/Vorgänge.** Ein erklärter Widerruf wird als Vorgang gespeichert und dem
Studio zur Bearbeitung (Erstattung) übermittelt; die Eingangsbestätigung erfolgt per
E-Mail.

**Speicherdauer.** `[Aufbewahrungsfristen ergänzen — insb. handels-/steuerrechtliche
Fristen für Rechnungen.]`

## 4. Widerrufsbelehrung (amtliches Muster — in der App integriert)

> Dieser Text ist im In-App-Screen bereits hinterlegt (mit Firmendaten-Platzhaltern).
> Hier zur Abstimmung mit dem Anwalt gespiegelt.

**Widerrufsrecht.** Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen
diesen Vertrag zu widerrufen. Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag des
Vertragsabschlusses. Um Ihr Widerrufsrecht auszuüben, müssen Sie uns
(`[Firma, Anschrift, E-Mail]`) mittels einer eindeutigen Erklärung (z. B. Brief oder
E-Mail) über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren. Sie können
dafür das Muster-Widerrufsformular verwenden. Zur Wahrung der Frist genügt die
rechtzeitige Absendung.

**Folgen des Widerrufs.** Im Falle eines wirksamen Widerrufs sind die beiderseits
empfangenen Leistungen zurückzugewähren; Rückzahlung binnen vierzehn Tagen. Haben Sie
verlangt, dass die Dienstleistung während der Widerrufsfrist beginnt, so haben Sie uns
einen angemessenen, anteiligen Betrag für die bis zum Widerruf erbrachte Leistung zu
zahlen.

### Muster-Widerrufsformular

```
An [Firma, Anschrift, E-Mail]:
Hiermit widerrufe ich den von mir abgeschlossenen Vertrag über die Erbringung
der folgenden Dienstleistung: Ernährungs-Premium (Abo)
– Bestellt am: __________
– Name: __________
– Anschrift: __________
– Datum: __________
– Unterschrift (nur bei Papier): __________
```

## 5. Rest-Checkliste vor Launch

- [ ] Firmendaten in `LEGAL` (`mitglieder.html`) gefüllt (Firmierung, Anschrift, E-Mail).
- [ ] AGB- und Datenschutz-Zusatz auf der Website ergänzt (oder als eigene Seiten) und
      verlinkt; Website-„Widerruf"-Link zeigt nicht mehr fälschlich auf die
      Mitgliedschafts-Kündigungsbedingungen.
- [ ] Anwaltliche Prüfung der AGB/Datenschutz/Widerruf-Texte erfolgt.
- [ ] USt-Behandlung der digitalen Leistung mit Steuerberater bestätigt (Abrechnung über den Mitgliedsvertrag/Magicline).
- [ ] `hasMail` in Produktion aktiv, damit die Widerruf-Eingangsbestätigung zugestellt wird.
