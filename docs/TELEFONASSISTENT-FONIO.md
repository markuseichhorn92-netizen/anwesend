# KI-Telefonassistent (fonio) anbinden

Schritt-für-Schritt-Anleitung. Alles, was **du** tun musst, steht in den Kästen.
Der Code ist fertig und live; ohne den Schlüssel sind die Endpunkte geschlossen.

---

## Schritt 1 — Schlüssel erzeugen

Auf deinem Rechner, **nicht** in einem Chat:

```
openssl rand -hex 24
```

Ergebnis ist eine lange Zeichenkette. Die brauchst du gleich zweimal.
Behandle sie wie ein Passwort.

---

## Schritt 2 — Schlüssel in Vercel eintragen

1. Vercel öffnen → Projekt **anwesend** → *Settings* → *Environment Variables*
2. Neue Variable anlegen:
   - Name: `PHONE_KEY`
   - Value: die Zeichenkette aus Schritt 1
   - Environment: **Production**
3. Speichern, dann *Deployments* → letztes Deployment → **Redeploy**

Prüfen, ob es gewirkt hat:

```
curl -s "https://mitglieder.fit-inn-trier.de/api/phone/info"
```

- Vorher: `{"ok":false,"error":"not_configured"}`
- Nachher: `{"ok":false,"error":"unauthorized"}`

Die zweite Antwort ist die richtige — die Schnittstelle lebt und verlangt den Schlüssel.

---

## Schritt 3 — In fonio den Schlüssel hinterlegen

In fonio beim Assistenten unter **API Request** → **Feste Parameter** (Default-Parameter):

| Feld | Wert |
|---|---|
| `key` | die Zeichenkette aus Schritt 1 |

**Wichtig:** als *festen*, nicht als *dynamischen* Parameter. Sonst versucht die KI,
den Schlüssel aus dem Gespräch zu füllen.

---

## Schritt 4 — Die vier Aktionen anlegen

### 4.1 Auskunft — „Habt ihr offen?", „Ist gerade viel los?"

- **Methode:** GET
- **URL:** `https://mitglieder.fit-inn-trier.de/api/phone/info`
- **Feste Parameter:** `key`
- **Dynamische Parameter:** keine
- **Während des Aufrufs sagen:** „Einen Moment, ich schaue nach."

Antwort enthält `text` mit einem fertigen Satz, z. B.
*„Wir haben gerade geöffnet, heute bis 21:30 Uhr. Aktuell ist normal viel los."*

### 4.2 Termine — „Wann könnte ich zum Probetraining kommen?"

- **Methode:** GET
- **URL:** `https://mitglieder.fit-inn-trier.de/api/phone/slots`
- **Feste Parameter:** `key`
- **Dynamische Parameter (optional):** `limit` (1–10, Standard 5)
- **Während des Aufrufs sagen:** „Ich schaue kurz, was frei ist."

Antwort: *„Frei wären zum Beispiel: Dienstag, 19. August um 17 Uhr, …"*
Der Assistent soll sich den gewählten `startDateTime` merken — den braucht 4.3.

### 4.3 Probetraining buchen

- **Methode:** POST
- **URL:** `https://mitglieder.fit-inn-trier.de/api/phone/book`
- **Feste Parameter:** `key`
- **Dynamische Parameter:**

| Feld | Pflicht | Hinweis |
|---|---|---|
| `firstname` | ja | |
| `lastname` | ja | |
| `phone` | ja | Rufnummer des Anrufers |
| `startDateTime` | ja | exakt der Wert aus 4.2 |
| `email` | nein | nur wenn der Anrufer sie von sich aus nennt |
| `gender` | nein | |
| `dateOfBirth` | nein | Format JJJJ-MM-TT |

**Nach Anschrift und Geburtsdatum soll der Assistent nicht fragen.** Das Team ergänzt
das beim Termin. Nennt der Anrufer keine E-Mail, setzt der Server automatisch eine
Platzhalter-Adresse (siehe unten) — die Buchung geht trotzdem durch.

### 4.4 Rückruf notieren — alles andere

- **Methode:** POST
- **URL:** `https://mitglieder.fit-inn-trier.de/api/phone/callback`
- **Feste Parameter:** `key`
- **Dynamische Parameter:** `name`, `phone`, `topic`, optional `note`, `preferred`, `email`

`topic` ist eines von: `probetraining`, `vertrag`, `kuendigung`, `beitrag`, `kurse`,
`beschwerde`, `sonstiges`.

Der Rückruf landet per E-Mail beim Team (`MAIL_TO`).

---

## Schritt 5 — Anweisungen für den Assistenten

In fonio ins Systemprompt / die Anweisungen aufnehmen:

> Du bist der Telefonassistent von Fit-Inn Trier, Auf Hirtenberg 8 in Trier.
> Sage zu Beginn, dass hier ein KI-Assistent antwortet und das Gespräch
> aufgezeichnet wird.
>
> Du darfst: Öffnungszeiten und Auslastung nennen, freie Probetraining-Termine
> nennen und buchen, Rückrufe notieren, den Weg zum Studio erklären.
>
> Du darfst NICHT: Auskunft zu bestehenden Verträgen, Beiträgen, Kündigungen oder
> zum Gesundheitszustand geben. Du kannst am Telefon nicht prüfen, wer anruft.
> Bei solchen Themen notierst du einen Rückruf.
>
> Frage beim Probetraining nur nach Vorname, Nachname und Rufnummer. Frage NICHT
> nach Anschrift oder Geburtsdatum. Eine E-Mail-Adresse nimmst du nur auf, wenn
> sie von selbst genannt wird — buchstabieren lassen brauchst du nicht.
>
> Bei Gesundheitsfragen, Schmerzen oder Beschwerden verweist du an das Team.

---

## Zur Platzhalter-Adresse

Magicline verlangt beim Lead eine E-Mail-Adresse. Nennt der Anrufer keine, setzt der
Server automatisch eine ein — pro Buchung eine **eigene**, in der Form:

```
info+tel-a1b2c3d4@fit-inn-trier.de
```

**Warum so:**

- **Eindeutig je Buchung.** Würden alle Telefon-Leads dieselbe Adresse bekommen,
  führt Magicline verschiedene Anrufer unter einem Datensatz zusammen.
- **Zustellbar.** Die Bestätigungsmail landet im Studio-Postfach, nicht im Nichts.
  Das Team sieht die Buchung also auch dann, wenn es die Notiz übersieht.

In der Buchungsnotiz steht ausdrücklich:
*„ACHTUNG: Keine E-Mail-Adresse genannt – die hinterlegte Adresse ist ein PLATZHALTER.
Bitte beim Rückruf die echte Adresse erfragen und im Datensatz ersetzen."*

**Falls dein Postfach kein Plus-Adressieren unterstützt** (`info+xyz@…` kommt nicht an),
setze in Vercel zusätzlich:

```
PHONE_LEAD_EMAIL=telefon-{id}@fit-inn-trier.de
```

`{id}` wird durch eine Zufallskennung ersetzt. Dann brauchst du für diese Adressen
eine Catch-All-Regel, sonst laufen die Bestätigungen ins Leere.

**Prüfe das einmal:** Schick eine Testmail an `info+test@fit-inn-trier.de`. Kommt sie
im Studio-Postfach an, passt die Voreinstellung.

---

## Schritt 6 — Datenschutz (vor dem ersten echten Anruf)

Diese Punkte sind **nicht** optional, sobald echte Anrufer telefonieren:

1. **Ansage am Gesprächsbeginn**: KI-Assistent + Aufzeichnung/Transkription.
2. **AVV mit fonio** abschließen und zu den anderen Verträgen legen
   (`docs/DIENSTLEISTER-AVV.md`).
3. **Eintrag in `docs/VVT-TOM.md`**: Verarbeitung „Telefonassistent", Zweck
   Terminvereinbarung und Erstauskunft, Kategorien Name/Rufnummer/Anliegen,
   Empfänger fonio (Server Nürnberg), Löschfrist der Aufzeichnungen.
4. **Keine Gesundheitsdaten** über den Assistenten — steht so in den Anweisungen
   oben und muss auch beim Testen kontrolliert werden.

---

## Schritt 7 — Erster Test

1. Selbst anrufen und fragen: „Habt ihr heute offen?"
2. „Wann könnte ich zum Probetraining kommen?"
3. Einen Termin buchen — **mit deinem eigenen Namen**, damit du ihn danach in
   Magicline wieder löschen kannst.
4. In Magicline prüfen: Ist der Lead da? Steht die Platzhalter-Adresse drin?
   Ist die Notiz vollständig?
5. Testtermin wieder absagen.

Läuft etwas schief, liefern die Endpunkte einen klaren Satz statt einer Fehlermeldung —
der Assistent bietet dann von selbst einen Rückruf an.

---

## Was noch offen ist

- **Die Buchung ist nie gegen das echte Magicline getestet worden.** Das ginge nur,
  indem ein echter Termin angelegt wird — das gehört in deinen Test aus Schritt 7,
  nicht in einen automatischen Testlauf.
- Ob Magicline einen Lead **ohne Anschrift** annimmt, zeigt sich erst dabei.
  Falls nicht, meldet der Endpunkt `booking_failed` und der Assistent nimmt einen
  Rückruf auf — es geht also nichts verloren. Sag Bescheid, dann ergänze ich die
  Anschrift als weiteres Pflichtfeld.
