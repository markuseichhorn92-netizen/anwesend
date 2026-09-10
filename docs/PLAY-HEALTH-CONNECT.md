# Health Connect – Freigabe im Google Play Review

Diese Datei ist die Grundlage für die **Erklärung zur Datennutzung** in der Play Console.
Sie muss mit dem Code übereinstimmen; `tests/health-connect.test.js` prüft das automatisch.

---

## Warum die Einreichung abgelehnt wurde

> „Verwendung der Berechtigung ist kein zulässiger/gültiger Anwendungsfall für Health Connect"

Drei Ursachen, alle im Code behoben:

**1. Drei Schreibrechte ohne Funktion.**
Die App hat `WRITE_EXERCISE`, `WRITE_DISTANCE` und `WRITE_ACTIVE_CALORIES_BURNED`
angefragt. `saveHealthWorkout` gibt auf Android aber grundsätzlich `not_supported`
zurück – die App konnte diese Rechte gar nicht nutzen. Eine angefragte Berechtigung
ohne sichtbare Funktion ist genau das, was die Richtlinie ausschließt.

**2. Ein Leserecht ohne Funktion.**
`READ_TOTAL_CALORIES_BURNED` wurde angefragt, aber nirgends gelesen. Die Kalorien je
Einheit kommen aus `ACTIVE_CALORIES_BURNED`.

**3. Die verlinkte Datenschutzerklärung war eine 404-Seite.**
Der Health-Connect-Freigabeschirm zeigte `www.fit-inn-trier.de/datenschutz` – diese
Adresse existiert nicht. Die tatsächliche Website-Erklärung
(`fit-inn-trier.de/datenschutz-fit-inn-trier`) erwähnt Health Connect zudem mit keinem
Wort. Verlinkt wird jetzt die **App**-Datenschutzerklärung, die Health Connect samt
gelesener Datenarten ausdrücklich benennt und **ohne Login** erreichbar ist.

---

## Was die App mit Health Connect macht

**Nur lesen. Es wird nichts nach Health Connect geschrieben.**

Zweck: Das Mitglied sieht Training, Erholung und Fortschritt an einer Stelle, statt sie
aus mehreren Apps zusammenzusuchen. Ohne den Import fehlen alle Einheiten, die nicht in
der Fit-Inn-App selbst gestartet wurden (Smartwatch, Laufuhr, Fremd-App).

| Berechtigung | Wo im Code | Wofür in der App |
|---|---|---|
| `READ_EXERCISE` | `readWorkouts()` | Trainingseinheiten in den Verlauf übernehmen |
| `READ_HEART_RATE` | `readWorkouts()` → `aggregate()` | Ø- und Max-Puls je Einheit |
| `READ_DISTANCE` | `readWorkouts()` → `aggregate()` | Strecke je Einheit |
| `READ_ACTIVE_CALORIES_BURNED` | `readWorkouts()` → `aggregate()` | Kalorien je Einheit |
| `READ_STEPS` | `stepsToday()` | Schritte des Tages auf der Übersicht |
| `READ_RESTING_HEART_RATE` | `getHealthMetrics()` | Vital-Check / Erholungsampel |
| `READ_HEART_RATE_VARIABILITY` | `getHealthMetrics()` | Vital-Check / Erholungsampel |
| `READ_WEIGHT` | `getHealthMetrics()` | Gewichtsverlauf im Figur-Check |
| `READ_BODY_FAT` | `getHealthMetrics()` | Körperfettverlauf im Figur-Check |
| `READ_VO2_MAX` | `getHealthMetrics()` | Ausdauer (Vital-Check, Coach) |
| `READ_SLEEP` | `sleepLastNight()` | Schlafdauer und -phasen für die Erholung |

Keine Hintergrundabfrage (`READ_HEALTH_DATA_IN_BACKGROUND` wird **nicht** angefragt),
keine Historie über den Standardzeitraum hinaus
(`READ_HEALTH_DATA_HISTORY` wird **nicht** angefragt).

**Nicht wieder aufnehmen**, solange die Funktion fehlt:
`WRITE_EXERCISE`, `WRITE_DISTANCE`, `WRITE_ACTIVE_CALORIES_BURNED`,
`READ_TOTAL_CALORIES_BURNED`.

---

## Zutreffender genehmigter Anwendungsfall

**Fitness und Wellness** – Aufzeichnung und Auswertung von Training, Aktivität und
Erholung für die nutzende Person selbst.

Ausdrücklich **nicht** zutreffend und in der App auch nicht umgesetzt: Werbung,
Marketing, Weiterverkauf oder Weitergabe an Dritte, Versicherungs- oder
Bonitätszwecke, medizinische Diagnostik.

---

## Text für die Erklärung in der Play Console

> Die Fit-Inn-Trier-App ist die Mitglieder-App eines einzelnen Fitnessstudios in Trier.
> Sie liest Health-Connect-Daten ausschließlich, um dem Mitglied sein eigenes Training,
> seine Aktivität und seine Erholung an einer Stelle zu zeigen.
>
> Konkret: Trainingseinheiten (mit Puls, Strecke und Kalorien) werden in den
> Trainingsverlauf übernommen, damit auch Einheiten sichtbar sind, die über eine
> Smartwatch oder eine andere App aufgezeichnet wurden. Schritte, Ruhepuls,
> Herzfrequenzvariabilität und Schlaf fließen in einen täglichen Erholungswert ein, der
> dem Mitglied sagt, ob heute ein intensives oder ein leichtes Training passt.
> Gewicht, Körperfett und VO₂max ergänzen die Fortschrittsanzeige.
>
> Die App schreibt nichts nach Health Connect zurück und fragt ausschließlich
> Leseberechtigungen an. Es werden weder Hintergrundzugriffe noch erweiterte
> Verlaufsdaten angefragt.
>
> Die Daten werden ausschließlich für das jeweilige Mitglied verarbeitet und ihm selbst
> angezeigt. Sie werden nicht für Werbung oder Marketing verwendet, nicht verkauft und
> nicht an Dritte zu deren eigenen Zwecken weitergegeben. Die Verarbeitung erfolgt nur
> nach ausdrücklicher Einwilligung; das Mitglied kann die Freigabe jederzeit in Health
> Connect oder in der App widerrufen. Die App ist kein Medizinprodukt und stellt keine
> Diagnosen.
>
> Datenschutzerklärung: https://mitglieder.fit-inn-trier.de/datenschutz

Zutreffender Anwendungsfall im Formular: **Fitness und Wellness**.

---

## Checkliste vor dem erneuten Einreichen

1. Neuen Build hochladen – die alten Berechtigungen dürfen im Manifest des eingereichten
   Bundles **nicht mehr** stehen. Nachsehen mit:
   `bundletool dump manifest --bundle app.aab | grep permission.health`
2. Erklärung in der Play Console durch den Text oben ersetzen; Anwendungsfall auf
   **Fitness und Wellness** setzen.
3. Datenschutz-URL in der Play Console auf `https://mitglieder.fit-inn-trier.de/datenschutz`
   setzen – dieselbe Adresse wie im Freigabeschirm.
4. Die Adresse einmal in einem privaten Browserfenster öffnen: Der Text muss **ohne
   Anmeldung** sichtbar sein und „Health Connect" enthalten.
5. Falls Google ein Demo-Video verlangt: Freigabedialog zeigen, danach den importierten
   Trainingsverlauf und den Vital-Check mit den übernommenen Werten.
6. Im Abschnitt „Datensicherheit" muss stehen, dass Gesundheits- und Fitnessdaten
   verarbeitet, aber nicht weitergegeben werden.

## Wenn das Zurückschreiben später doch kommt

Dann müssen **drei** Stellen gemeinsam geändert werden – und erst, wenn
`saveHealthWorkout` auf einem echten Gerät nachweislich schreibt:

- `AndroidManifest.xml` des Plugins
- `hcPermissions` in `FitInnNativePlugin.kt`
- die Erklärung in der Play Console

`tests/health-connect.test.js` schlägt fehl, wenn nur eine der Code-Stellen wandert.
