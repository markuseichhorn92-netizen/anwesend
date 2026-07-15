# Ernährungs-Premium — Rechtstexte (ENTWURF zur anwaltlichen Prüfung)

> **Wichtig:** Dieses Dokument ist ein **Entwurf/Vorlage** für die Erweiterung eurer
> Website-AGB und -Datenschutzerklärung um das **digitale Premium-Abo** (Ernährungs-
> Premium, Abrechnung über Stripe). Es ist **keine Rechtsberatung**. Vor dem
> Premium-Launch von einem Anwalt/Steuerberater prüfen und die **Platzhalter**
> (`[...]`) mit den echten Firmendaten füllen.

## 0. Was in der App bereits umgesetzt ist

- **In-App-Rechtsscreen „Widerruf & Rechtliches"** (`nav 'recht'`, erreichbar aus der
  Fußzeile, aus dem Kauf-Screen und aus „Mein Abo"): §312j-Pflichtinfos,
  Widerrufsbelehrung (amtliches Muster, digitale Dienstleistung), Muster-
  Widerrufsformular und der **Pflicht-Widerrufsbutton**.
- **Pflicht-Widerrufsbutton** (seit 2026 für online geschlossene B2C-Fernabsatz-
  verträge): „Vertrag widerrufen" → Bestätigungsschritt → Absenden. Der Server
  (`api/member/nutrition-billing.js`, Action `widerruf`) beendet das Abo **sofort**
  (Stripe), erfasst den Widerruf als Vorgang, benachrichtigt das Studio und schickt
  dem Mitglied eine **Eingangsbestätigung per E-Mail** (dauerhafter Datenträger).
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
Basisfunktionen bleiben unberührt. Premium ist **kein** Bestandteil des Studio-
Mitgliedsvertrags und wird separat abgeschlossen.

**§ B Preise & Laufzeit.** Der Preis beträgt `[4,99 €]`/Monat inkl. gesetzlicher
USt. Der Vertrag läuft **monatlich** und verlängert sich automatisch um je einen
weiteren Monat, sofern nicht gekündigt wird. Ein etwaiger Gratiszeitraum
(`[7 Tage]`) ist vorab ausgewiesen; nach dessen Ablauf beginnt die kostenpflichtige
Abrechnung.

**§ C Kündigung.** Das Abo ist **jederzeit zum Ende des laufenden, bezahlten
Abrechnungsmonats** kündbar — direkt in der App unter „Mein Abo". Der Zugang bleibt
bis zum Periodenende erhalten.

**§ D Zahlungsabwicklung.** Die Zahlung wird über den Zahlungsdienstleister **Stripe**
abgewickelt. Es gelten die dort im Bezahlvorgang wählbaren Zahlungsarten. Der
Anbieter erhält keine vollständigen Zahlungsdaten (keine Kartennummer im Klartext).

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

## 3. Datenschutz-Zusatz „Premium/Stripe" (Entwurf)

**Verantwortlicher:** siehe Impressum (Abschnitt 1).

**Zahlungsabwicklung (Stripe).** Zur Abwicklung des Premium-Abos setzen wir **Stripe
Payments Europe, Ltd.** ein. Verarbeitet werden u. a. Name, E-Mail, Zahlungsmittel-
Daten, Betrag, Abo-/Rechnungsdaten sowie technische Metadaten. Rechtsgrundlage:
Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung) und lit. f (sichere Zahlungsabwicklung/
Betrugsprävention). Es kann zu einer Übermittlung in Drittländer (u. a. USA) kommen;
Grundlage sind die EU-Standardvertragsklauseln. Details: `[Link Stripe-Datenschutz]`.

**Entitlement/Status.** Wir speichern zum Konto den Premium-Status (aktiv/Test/
gekündigt, Laufzeitende, Stripe-Kennungen) zur Bereitstellung der Leistung.

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
dafür das Muster-Widerrufsformular verwenden oder den Widerrufsbutton in der App
nutzen. Zur Wahrung der Frist genügt die rechtzeitige Absendung.

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
- [ ] USt-Behandlung der digitalen Leistung mit Steuerberater bestätigt (ggf. Stripe Tax).
- [ ] `hasMail` in Produktion aktiv, damit die Widerruf-Eingangsbestätigung zugestellt wird.
