# KI-Telefonassistent (fonio) anbinden

Schritt-für-Schritt-Anleitung. Alles, was **du** tun musst, steht in den Kästen.
Der Code ist fertig und live; ohne den Schlüssel sind die Endpunkte geschlossen.

---

## Schritt 1 — Schlüssel erzeugen

> **Nicht den API-Schlüssel von fonio verwenden.**
> Der fonio-Schlüssel ist der Zugang zu *deinem fonio-Konto* — mit ihm könnte man
> dort Assistenten ändern und Gesprächsmitschriften lesen. Er hat in unserer
> Umgebung nichts zu suchen und wird für die Anbindung auch nicht gebraucht:
> fonio schickt ihn bei Anfragen an fremde Server nicht mit, er dient nur dem
> Zugriff auf fonios eigene API.
>
> Gebraucht wird ein **eigener, neuer Zufallswert**, den es ausschließlich für
> diese Schnittstelle gibt. Beide Seiten kennen ihn: Vercel prüft ihn, fonio
> schickt ihn mit.

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

**Der sicherste Weg ist der Header.** Er funktioniert bei GET *und* POST gleich –
feste Parameter landen bei GET in der URL und bei POST im Body, das ist eine
Fehlerquelle mehr.

> **Du erzeugst hier nichts in fonio.** Das Header-Feld ist ein freies Textfeld –
> du tippst den Wert aus Schritt 1 einfach hinein. In fonio einen „API-Schlüssel
> erstellen" ist etwas anderes: das ist der Zugang zu fonios eigener API und wird
> hier nicht gebraucht.
>
> Das `{{apiKey}}` im Beispieltext von fonio ist nur ein **Platzhalter für eine
> Variable**, die du dort selbst anlegen könntest. Nötig ist das nicht – der Wert
> darf direkt im Feld stehen.

Im Reiter **Anfrage** → Feld **Header** eintragen (statt des leeren `{}`):

```json
{"Authorization": "Bearer HIER-DEINEN-SCHLUESSEL-EINSETZEN"}
```

> **Nicht abtippen, sondern ersetzen.** Alles, was hier als Beispiel steht, ist
> öffentlich (dieses Dokument liegt im Repository). Ein Schlüssel aus einer
> Anleitung ist kein Schlüssel — er muss aus Schritt 1 kommen.

Das Ganze muss gültiges JSON bleiben — Anführungszeichen und geschweifte Klammern
stehen lassen, nach `Bearer` genau ein Leerzeichen.

Alternativ als **fester Parameter** `key` (nicht dynamisch — sonst versucht die KI,
ihn aus dem Gespräch zu füllen). Der Server akzeptiert beides, außerdem `apiKey`
statt `key` und den Header `X-API-Key`.

### Sofort prüfen, ob es angekommen ist

Lege in fonio testweise eine Aktion auf diese URL an und drücke „Testen":

```
https://mitglieder.fit-inn-trier.de/api/phone/ping
```

Die Antwort sagt dir direkt, woran es liegt:

| Antwort | Bedeutung |
|---|---|
| `"Verbindung steht. Der Schlüssel passt."` | fertig — genauso für die anderen Aktionen |
| `received: {header:false, query:false, body:false}` | es kam **gar kein** Schlüssel an |
| `"Ein Schlüssel kam an, stimmt aber nicht überein"` | Tippfehler oder Leerzeichen |
| `not_configured` | `PHONE_KEY` fehlt in Vercel |

Dasselbe geht auch vom Rechner aus:

```
curl "https://mitglieder.fit-inn-trier.de/api/phone/ping?key=DEIN_SCHLUESSEL"
```

---

## Schritt 4 — Die Aktionen anlegen

Jede Aktion hat in fonio dieselben vier Felder: **URL**, **Methode**, **Header**
und **Body**. Der Header ist überall gleich (Schritt 3).

> **Der Body ist der Teil, den man leicht übersieht.** Bei `POST` werden die Daten
> ausschließlich darüber übertragen. Bleibt `{}` stehen, kommt beim Server **nichts**
> an — er meldet dann „Pflichtfelder fehlen", obwohl der Anrufer alles gesagt hat.
>
> Werte aus dem Gespräch setzt du mit doppelten geschweiften Klammern ein:
> `{{firstname}}`. fonio legt die Variable an, sobald du sie eintippst, und füllt
> sie im Gespräch mit dem, was der Anrufer sagt.

### 4.1 Auskunft — „Habt ihr offen?", „Ist gerade viel los?"

| Feld | Wert |
|---|---|
| URL | `https://mitglieder.fit-inn-trier.de/api/phone/info` |
| Methode | GET |
| Header | wie Schritt 3 |
| Body | leer lassen (GET sendet keinen Body) |

Wann verwenden: *„Wenn nach Öffnungszeiten, Andrang oder der Adresse gefragt wird."*

Bei **GET**-Aktionen gibt es keinen Body. Zusätzliche Angaben hängst du dort als
Query an die URL — auch mit `{{variable}}`.

### 4.2 Termine — „Wann könnte ich zum Probetraining kommen?"

| Feld | Wert |
|---|---|
| URL | `https://mitglieder.fit-inn-trier.de/api/phone/slots?wochentag={{wochentag}}&woche={{woche}}&tageszeit={{tageszeit}}&datum={{datum}}&ab={{ab}}&tage={{tage}}` |
| Methode | GET |
| Header | wie Schritt 3 |
| Body | leer lassen |

Wann verwenden: *„Wenn nach freien Terminen für ein Probetraining gefragt wird."*

Alle Angaben sind **optional** — bleiben sie leer, kommen wie bisher die
nächstmöglichen Termine.

| Variable | Beschreibung für fonio | Beispiel |
|---|---|---|
| `wochentag` | Der Wochentag, den der Anrufer nennt — einfach so weitergeben, wie er gesagt wurde. Niemals selbst in ein Datum umrechnen. Sonst leer lassen. | `Donnerstag` |
| `woche` | Nur `nächste`, wenn der Anrufer „nächste Woche" sagt. Sonst leer lassen. | `nächste` |
| `tageszeit` | Eines von `vormittag`, `nachmittag`, `abend`, wenn der Anrufer eine Tageszeit nennt. Sonst leer lassen. | `nachmittag` |
| `datum` | Ein konkretes Datum, wenn der Anrufer eines nennt. Format `JJJJ-MM-TT` oder `TT.MM.JJJJ`. Sonst leer lassen. | `2026-10-05` |
| `ab` | Ab wann gesucht werden soll, wenn der Anrufer einen Zeitraum nennt („ab Oktober"). Sonst leer lassen. | `2026-10-01` |
| `tage` | In wie vielen Tagen gesucht werden soll („in vier Wochen" = 28). Sonst leer lassen. | `28` |

> **Wochentage rechnet der Server aus, nicht die KI.** „Nächste Woche Donnerstag"
> in ein Datum umzurechnen ist etwas, das Sprachmodelle zuverlässig falsch machen —
> in einem Testgespräch wurde daraufhin Montag angeboten. Gib `wochentag` und
> `woche` deshalb unverändert weiter.

Ist der gewünschte Tag voll, nennt die Antwort von selbst Ausweichtermine.
Weiter als ein halbes Jahr im Voraus wird nicht gesucht.

**Die Antwort enthält den ganzen Tag.** Unter `zeitenAmTag` stehen alle Zeiten des
gewünschten Tages, getrennt nach `vormittag`, `nachmittag` und `abend`. Fragt der
Anrufer anschließend „und wie sieht es nachmittags aus?", steht die Antwort also
schon da — ein zweiter Aufruf ist dafür nicht nötig.

Die Antwort enthält je Termin zwei Felder: `gesprochen` und `startDateTime`.

> **Nur `gesprochen` vorlesen.** `startDateTime` ist ein technischer Wert in **UTC**
> und im Sommer zwei Stunden von der Ortszeit entfernt. In einem Testgespräch hat
> der Assistent die Rohliste vorgelesen und „elf Uhr, zwölf Uhr dreißig" angeboten —
> gemeint waren 13:00 und 14:30, und samstags öffnet das Studio erst um 13 Uhr. Es
> wurden also Zeiten genannt, zu denen abgeschlossen ist. Jede Antwort trägt dafür
> jetzt ein Feld `hinweis`. `startDateTime` gehört **unverändert** in die Buchung —
> aber nie in den gesprochenen Satz.

**Ortszeit als UTC wird geradegezogen.** Schickt der Assistent trotzdem die
gesprochene Uhrzeit als UTC (`14:30 Uhr` → `…T14:30:00.000Z`), prüft der Server,
ob diese Uhrzeit **als Ortszeit gelesen** genau einen freien Termin trifft — und
bucht dann diesen. Nur wenn das eindeutig ist; sonst bleibt es beim ehrlichen
Fehlschlag. Im Protokoll steht das als `ortszeit_korrigiert`. Die Bestätigung
nennt immer den tatsächlich gebuchten Zeitpunkt, missverstehen kann der Anrufer
das also nicht.

**Ein zweites Probetraining lehnt Magicline ab.** Die Antwort ist dann
`already_booked` — keine Störung, sondern die Auskunft, dass bereits ein Termin
existiert. Der Assistent soll dann **nicht erneut buchen**, sondern mit Aktion 4.5
nachsehen und ggf. verschieben oder absagen.

**Probetraining wird immer mit Trainer gebucht.** Der Server fragt die Slots mit
`trainerRequired=true` ab, damit Magicline dem Termin eine Ressource zuweist —
sonst steht im Kalender niemand dafür ein. Angeboten werden dadurch nur Zeiten, zu
denen wirklich jemand frei ist (gemessen: 22 statt 33 Slots pro Woche). Abschalten
ließe sich das nur über `TRIAL_TRAINER=0` in Vercel.

### 4.3 Probetraining buchen

| Feld | Wert |
|---|---|
| URL | `https://mitglieder.fit-inn-trier.de/api/phone/book` |
| Methode | POST |
| Header | wie Schritt 3 |

**Body** (das leere `{}` ersetzen):

```json
{
  "firstname": "{{firstname}}",
  "lastname": "{{lastname}}",
  "phone": "{{phone}}",
  "dateOfBirth": "{{dateOfBirth}}",
  "startDateTime": "{{startDateTime}}",
  "gender": "{{gender}}",
  "email": "{{email}}"
}
```

`gender` und `email` dürfen leer bleiben — der Server kommt damit zurecht. Die
ersten fünf Felder sind Pflicht.

**Beschreibung je Variable** (fonio verlangt sie — sie ist die Anweisung, nach der
die KI den Wert füllt):

| Variable | Beschreibung zum Einfügen |
|---|---|
| `firstname` | Nur der Vorname des Anrufers. Nennt er den vollen Namen („Markus Eichhorn"), trage hier nur „Markus" ein und frage nicht erneut nach. |
| `lastname` | Nur der Nachname des Anrufers, ohne Vorname. Bei „Markus Eichhorn" also „Eichhorn". |
| `phone` | Die Rufnummer des Anrufers, nur Ziffern und ggf. führendes Plus, ohne Leerzeichen und ohne ausgeschriebene Zahlwörter. Beispiel: 015120442044. Wenn die Nummer im Gespräch nicht genannt wurde, nutze die Nummer, von der aus angerufen wird. |
| `dateOfBirth` | Das Geburtsdatum des Anrufers im Format JJJJ-MM-TT, also 1990-05-04. TT.MM.JJJJ wird ebenfalls verstanden. Immer erfragen — ohne Geburtsdatum lehnt das Studioverwaltungssystem die Buchung ab. Niemals schätzen oder erfinden. |
| `startDateTime` | Der Zeitpunkt des gewählten Termins — **exakt und unverändert** der Wert aus dem Feld `startDateTime` der Termin-Abfrage, zum Beispiel 2026-08-15T11:00:00.000Z. Auf keinen Fall den gesprochenen Text („Samstag um 13 Uhr") eintragen und den Wert auch nicht umrechnen oder kürzen. |
| `gender` | Anrede des Anrufers, falls im Gespräch klar geworden: MALE für Herr, FEMALE für Frau, sonst UNISEX. Nicht danach fragen und nicht aus dem Vornamen erraten — im Zweifel leer lassen. |
| `email` | Die E-Mail-Adresse, aber NUR wenn der Anrufer sie von sich aus nennt. Niemals danach fragen und nicht buchstabieren lassen. Sonst leer lassen. |

**Für die Rückruf-Aktion (4.4):**

| Variable | Beschreibung zum Einfügen |
|---|---|
| `name` | Vor- und Nachname des Anrufers, so wie genannt. |
| `phone` | Rufnummer für den Rückruf, nur Ziffern, ohne Leerzeichen. |
| `topic` | Das Thema des Anliegens. Genau eines von: probetraining, vertrag, kuendigung, beitrag, kurse, beschwerde, sonstiges. |
| `note` | Ein bis zwei Sätze, worum es geht — in eigenen Worten zusammengefasst. Keine Angaben zu Gesundheit, Krankheiten oder Beschwerden aufnehmen. |

Wann verwenden:

> Immer dann aufrufen, wenn der Anrufer einen genannten Termin verbindlich buchen
> möchte. Vorher Vorname, Nachname, Rufnummer und Geburtsdatum erfragen. Ohne
> diesen Aufruf ist NICHTS gebucht.

**Nach der Anschrift nicht fragen** — fehlt sie, setzt der Server einen erkennbaren
Platzhalter, ebenso bei fehlender E-Mail.

### 4.4 Rückruf notieren — alles andere

| Feld | Wert |
|---|---|
| URL | `https://mitglieder.fit-inn-trier.de/api/phone/callback` |
| Methode | POST |
| Header | wie Schritt 3 |

**Body:**

```json
{
  "name": "{{name}}",
  "phone": "{{phone}}",
  "topic": "{{topic}}",
  "note": "{{note}}"
}
```

`topic` ist eines von: `probetraining`, `vertrag`, `kuendigung`, `beitrag`, `kurse`,
`beschwerde`, `sonstiges`.

Wann verwenden: *„Bei allem, was ich nicht selbst erledigen kann — Vertrag, Beitrag,
Kündigung, Beschwerde, persönliche Anliegen."*

Der Rückruf landet per E-Mail beim Team (`MAIL_TO`).

### 4.5 Bestehenden Termin nennen, verschieben oder absagen

| Feld | Wert |
|---|---|
| URL | `https://mitglieder.fit-inn-trier.de/api/phone/appointment` |
| Methode | POST |
| Header | wie Schritt 3 |

**Body:**

```json
{
  "aktion": "{{aktion}}",
  "phone": "{{phone}}",
  "lastname": "{{lastname}}",
  "dateOfBirth": "{{dateOfBirth}}",
  "bookingId": "{{bookingId}}",
  "startDateTime": "{{startDateTime}}"
}
```

| Variable | Beschreibung für fonio |
|---|---|
| `aktion` | Genau eines von: `auskunft` (Termin nennen), `stornieren` (absagen), `umbuchen` (verschieben). |
| `phone` | Die Rufnummer, unter der gebucht wurde. Immer erfragen. |
| `lastname` | Nachname des Anrufers. Zur Zuordnung nötig, wenn kein Geburtsdatum genannt wird. |
| `dateOfBirth` | Geburtsdatum, falls genannt. Format `TT.MM.JJJJ`. Alternative zum Nachnamen. |
| `bookingId` | Nur ausfüllen, wenn eine vorherige Antwort mehrere Termine genannt hat — dann die ID des gemeinten Termins, unverändert übernehmen. Sonst leer lassen. |
| `startDateTime` | Nur beim Umbuchen: der neue Zeitpunkt, **unverändert** aus der Antwort der Termin-Aktion (4.2). Niemals selbst ausrechnen. |

Wann verwenden: *„Wenn jemand nach seinem bereits gebuchten Termin fragt, ihn
verschieben oder absagen möchte."*

**Wie die Rufnummer zum Termin führt.** Gebucht wird über verschiedene Kanäle,
abgesagt gern telefonisch — dann liegt nur die Nummer vor. Der Server geht drei
Wege, der erste Treffer gewinnt:

| Weg | deckt ab | Kosten |
|---|---|---|
| eigener Merker | über uns gebucht (Telefon **oder** Website) | ein Lesezugriff |
| Interessenten-Bestand | alles, was über die Magicline-Webhooks kam — auch Buchungen, die nie über uns liefen | ein Lesezugriff |
| Magicline-Kundensuche | bestehende Mitglieder | bis zu sechs Abfragen, langsam |

> Ein Probetraining legt in Magicline einen *Lead* an, kein Mitglied — und die
> Kundensuche findet vor allem Mitglieder. Genau daran ist die Zuordnung vorher
> gescheitert. Welcher Weg getragen hat, steht im Protokoll unter `quelle`
> (`/api/phone/ping?log=1&key=…`): `merker`, `lead` oder `suche`.

> **Voraussetzung für den mittleren Weg:** die Magicline-Webhooks müssen aktiv
> sein. Ohne sie bleibt für fremd gebuchte Termine nur die Kundensuche.

**Warum zwei Angaben nötig sind:** Eine Rufnummer allein weist niemanden aus — eine
Anruferkennung lässt sich fälschen. Der Server gibt einen Termin deshalb nur heraus,
wenn Rufnummer **und** Nachname (oder Geburtsdatum) zusammenpassen. Passt das zweite
Merkmal nicht, antwortet er genauso wie bei einer unbekannten Nummer; sonst ließe
sich über die Leitung der Nachname zu einer Rufnummer erraten.

Zurückgegeben werden nur Terminart und Zeitpunkt — keine E-Mail, keine Anschrift,
keine Vertrags- oder Gesundheitsdaten.

Beim Umbuchen wird **zuerst** der neue Termin gebucht und **erst danach** der alte
abgesagt. Ist der neue Zeitpunkt nicht mehr frei, bleibt der bisherige stehen.

> **Timeout dieser Aktion in fonio auf 10 Sekunden stellen.** Die Zuordnung über die
> Rufnummer fragt mehrere Schreibweisen im Studioverwaltungssystem ab und braucht
> deshalb länger als die anderen Aktionen. Der Server bricht nach 3,5 Sekunden von
> selbst ab und bietet dann einen Rückruf an — bleibt fonios Standard bei 5 Sekunden,
> hängt der Assistent stattdessen mitten im Satz.

---

## Schritt 5 — Anweisungen für den Assistenten

In fonio ins Systemprompt / die Anweisungen aufnehmen:

> Du bist der Telefonassistent von Fit-Inn Trier, Auf Hirtenberg 8 in Trier.
> Sage zu Beginn, dass hier ein KI-Assistent antwortet und das Gespräch
> aufgezeichnet wird.
>
> Du darfst: Öffnungszeiten und Auslastung nennen, freie Probetraining-Termine
> nennen und buchen, einen bereits gebuchten Termin nennen, verschieben oder
> absagen, Rückrufe notieren, den Weg zum Studio erklären.
>
> Du darfst NICHT: Auskunft zu bestehenden Verträgen, Beiträgen, Kündigungen oder
> zum Gesundheitszustand geben. Du kannst am Telefon nicht prüfen, wer anruft.
> Bei solchen Themen notierst du einen Rückruf.
>
> Nennt jemand einen Wunschtermin („nächste Woche Donnerstag", „im Oktober", „in
> vier Wochen", „am 5.10."), rufe die Termin-Aktion mit `wochentag`, `woche`,
> `datum`, `ab` oder `tage` auf und gib weiter, was gesagt wurde. Rechne NIEMALS
> selbst ein Datum oder einen Wochentag aus — das macht der Server. Erfinde nie
> einen Wert für `startDateTime`, sondern übernimm ihn unverändert aus der Antwort.
>
> Fragt jemand nach einer anderen Tageszeit desselben Tages, steht die Antwort
> bereits im Feld `zeitenAmTag` der letzten Antwort. Sage niemals „dazu habe ich
> keine Informationen", wenn dort noch Zeiten stehen.
>
> Lies Uhrzeiten AUSSCHLIESSLICH aus den Feldern `gesprochen` und `text` vor.
> `startDateTime` ist ein technischer Wert in UTC und NICHT die Ortszeit — er wird
> nur unverändert zurückgeschickt, niemals ausgesprochen.
>
> Geht es um einen SCHON GEBUCHTEN Termin, frage nach der Rufnummer, unter der
> gebucht wurde, und zusätzlich nach dem Nachnamen (oder dem Geburtsdatum). Beides
> ist nötig, damit ich den Termin zuordnen darf. Findet der Server nichts, biete
> einen Rückruf an und rate nicht.
>
> Frage beim Probetraining nach Vorname, Nachname, Rufnummer und Geburtsdatum.
> Nennt jemand einen vollständigen Namen, teile ihn selbst in Vor- und Nachname
> auf und frage nicht erneut. Frage NICHT nach der Anschrift. Eine E-Mail-Adresse
> nimmst du nur auf, wenn sie von selbst genannt wird — buchstabieren lassen
> brauchst du nicht.
>
> Bei Gesundheitsfragen, Schmerzen oder Beschwerden verweist du an das Team.
>
> WICHTIG: Ein Termin ist erst gebucht, wenn du die Buchungs-Aktion aufgerufen
> hast UND sie erfolgreich war. Sage NIEMALS „vorgemerkt", „reserviert" oder
> „gebucht", bevor das passiert ist. Fehlt dir noch eine Angabe, frage danach.
> Schlägt die Buchung fehl, sage das offen und biete einen Rückruf an.

---

## Was Magicline wirklich verlangt

Am 14.08. gegen die Connect-API ausgemessen — jeweils mit einem ungültigen Termin,
damit dabei nichts gebucht wird:

| Feld | Pflicht? | am Telefon |
|---|---|---|
| firstname, lastname | ja | erfragen |
| phone | ja | erfragen |
| **dateOfBirth** | **ja** | **erfragen** (nicht ersetzbar) |
| **gender** | **ja** | optional erfragen, sonst `UNISEX` |
| email | ja | Platzhalter, falls nicht genannt |
| **Anschrift inkl. Hausnummer** | **ja** | Platzhalter |

`gender` kennt nur `MALE`, `FEMALE`, `UNISEX` — „UNKNOWN" wird abgelehnt. Eine
Anschrift **ohne Hausnummer** wird ebenfalls abgelehnt.

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


---

## Wenn der Assistent sagt „die Termine kann ich gerade nicht abrufen"

Dieser Satz kommt fast immer daher, dass der **Schlüssel nicht mitgeschickt** wird.
Der Server antwortet dann mit 401, und der Assistent formuliert selbst etwas.

Der mit Abstand häufigste Grund: **`PHONE_KEY` wurde in Vercel geändert, in fonio
aber nicht.** Dann schlägt schlagartig *jede* Aktion fehl — Öffnungszeiten, Termine,
Buchung, alles. Nach jeder Schlüssel-Änderung muss der neue Wert bei **jeder**
fonio-Aktion einzeln nachgetragen werden; fonio übernimmt ihn nicht von einer
Aktion zur nächsten.

Prüfe in dieser Reihenfolge:

1. Vom Rechner aus mit dem Wert testen, der in fonio steht:
   ```
   curl "https://mitglieder.fit-inn-trier.de/api/phone/ping?key=WERT-AUS-FONIO"
   ```
   - `"Verbindung steht"` → der Schlüssel ist richtig, die Ursache liegt woanders.
   - `"Ein Schlüssel kam an, stimmt aber nicht überein"` → **fonio und Vercel tragen
     verschiedene Werte.** Den Wert aus Vercel in alle fonio-Aktionen übernehmen.
   - `not_configured` → `PHONE_KEY` fehlt in Vercel.
2. Das Protokoll ansehen — es zeigt jetzt auch die **fehlgeschlagenen** Versuche,
   also ob fonio überhaupt anruft und wo der Schlüssel lag:
   ```
   curl "https://mitglieder.fit-inn-trier.de/api/phone/ping?log=1&key=DEIN_SCHLUESSEL"
   ```
   Einträge mit `"schritt":"auth"` und `"status":"schluessel_falsch"` sind der
   Beweis, dass fonio ankommt und nur der Wert nicht stimmt. Steht dort
   `"kein_schluessel"`, ist das Header- oder Parameterfeld in fonio leer.
   Der Schlüssel selbst wird dabei **nie** protokolliert.
3. Header-JSON prüfen: `{"Authorization": "Bearer abc123"}` — mit Anführungszeichen,
   mit Leerzeichen nach `Bearer`, ohne Zeilenumbruch im Schlüssel.
4. Steht der Schlüssel bei **allen** Aktionen (inzwischen fünf)?
5. Im fonio-Log die Roh-Antwort ansehen: Das Feld `hint` sagt im Klartext, was fehlt.

Alle Fehlerantworten enthalten ein Feld `text` mit einem vorlesbaren Satz — der
Assistent muss sich also nichts mehr ausdenken; er sagt dann von selbst, dass er
einen Rückruf notiert.


---

## Wenn der Assistent den Termin nur behauptet

Symptom: Im Verlauf steht **kein** Aufruf von `/api/phone/book`, der Assistent sagt
aber „ist vorgemerkt". Der Anrufer käme umsonst — das ist der gefährlichste Fehler
von allen, weil niemand ihn bemerkt.

Prüfe in fonio bei der Buchungs-Aktion:

1. **Aktivität** steht auf „Immer" (nicht deaktiviert).
2. **„Wann soll die KI das verwenden?"** ist eindeutig. Statt „Terminbuchen,
   Probetraining" besser:
   > Immer dann aufrufen, wenn der Anrufer einen genannten Termin verbindlich
   > buchen möchte. Vorher Vorname, Nachname, Rufnummer und Geburtsdatum
   > erfragen. Ohne diesen Aufruf ist NICHTS gebucht.
3. **Dynamische Parameter** sind angelegt: `firstname`, `lastname`, `phone`,
   `dateOfBirth`, `startDateTime`. Fehlt einer, kann die KI ihn nicht füllen.
4. Im **Systemprompt** steht der Satz aus Schritt 5, dass ein Termin erst nach
   erfolgreichem Aufruf bestätigt werden darf.

Zusätzlich trägt die Termin-Antwort inzwischen selbst den Hinweis
`naechsterSchritt`, dass ohne Buchungsaufruf nichts gebucht ist — Modelle lesen
Werkzeug-Antworten mit und halten sich meist daran.

---

## Wenn der Assistent sagt „das kann ich nicht direkt erledigen"

Symptom: Der Anrufer will einen Termin absagen, der Assistent erfragt brav Name,
Rufnummer und Geburtsdatum — und sagt dann, er könne es doch nicht.

Das heißt fast immer: **die Aktion 4.5 ist in fonio noch nicht angelegt.** Ein
Assistent kann nur aufrufen, was als Aktion existiert; alles andere endet in einer
freundlichen Absage. Lege 4.5 an und beschreibe unter „Wann soll die KI das
verwenden?" ausdrücklich auch das Absagen und Verschieben.

---

## Weiterleitung ins Leere

Symptom: Im Verlauf steht „Weiterleitung an +49…" mit **der Nummer des Anrufers**,
danach „das geht leider nicht, weil es ein Webanruf ist".

Der Assistent hat sich in dem Fall die einzige Nummer genommen, die im Gespräch
vorkam — nämlich die des Anrufers. Zu tun:

1. In fonio eine feste **Weiterleitungsnummer** des Studios hinterlegen
   (`0651 308524`), niemals eine Variable aus dem Gespräch.
2. Solange Weiterleitung über Webanrufe nicht funktioniert: die Funktion
   **abschalten** und im Systemprompt ergänzen:
   > Du kannst Anrufe NICHT weiterleiten. Biete stattdessen an, einen Rückruf zu
   > notieren, oder nenne die Studionummer 0651 308524.

Ein Angebot, das dann scheitert, ist im Gespräch schlechter als gar kein Angebot.

---

## Wenn der Assistent einen falschen Wochentag anbietet

Symptom: Gefragt war „nächste Woche Donnerstag", angeboten wurde Montag.

Ursache: Die KI hat versucht, das Datum selbst auszurechnen. Das ist behoben —
`wochentag` und `woche` gehen unverändert an den Server, der daraus das Datum
bildet. Prüfe, dass beide Variablen in der Termin-Aktion angelegt sind und ihre
Beschreibung ausdrücklich sagt: *„Niemals selbst in ein Datum umrechnen."*
