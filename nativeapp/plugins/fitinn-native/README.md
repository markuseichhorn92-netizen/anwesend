# `FitInnNative` – natives **Android**-Plugin (Einbau-Anleitung)

Dieses Modul setzt den `window.FitInnNative`-Vertrag (siehe
[`../../../docs/NATIVE-BRIDGE.md`](../../../docs/NATIVE-BRIDGE.md)) auf **Android**
nativ um – analog zum iOS-Plugin in [`../../native-plugin/`](../../native-plugin/):

- **Health Connect** (Google-Fit-Nachfolger): `healthAuth`, `getHealthWorkouts`,
  `getHealthMetrics`, `saveHealthWorkout`
- **Bluetooth-Herzgurt** (BLE, z. B. Polar H9): `startHeartRate` / `stopHeartRate`
- **GPS** (Fused Location): `getPosition` / `watchPosition` / `clearWatch`

> ⚠️ **Nicht auf Gerät getestet.** Der Code ist gegen den Vertrag geschrieben, aber
> Health Connect + BLE laufen nur auf einem **echten Android-Handy** (nicht im
> Emulator ohne Health-Connect-Provider). Auf einem **Mac/PC mit Android Studio**
> bauen und auf einem echten Gerät prüfen.

> Die **Kamera** (Essen-Foto, Barcode-Scan, Sprach-Diktat) läuft auf Android bereits
> über die WebView (`getUserMedia`) – dafür sorgt `patch-native.js` (Laufzeitrecht +
> `WebChromeClient.onPermissionRequest`). Dieses Plugin ergänzt nur, was der Browser
> **nicht** kann: Health, Bluetooth, GPS.

## Dateien

| Datei | Zweck |
|---|---|
| `package.json` | macht den Ordner zu einem lokalen Capacitor-Plugin (`jsName = "FitInnNative"`) |
| `android/build.gradle` | Library-Modul + Abhängigkeiten (Health Connect, Coroutinen, Play-Location) |
| `android/src/main/AndroidManifest.xml` | Berechtigungen, Health-Connect-`<queries>` + Rationale-Activity (wird ins App-Manifest gemerged) |
| `android/src/main/java/de/fitinn/nativeplugin/FitInnNativePlugin.kt` | Das Plugin (Health/BLE/GPS) |
| `android/src/main/java/de/fitinn/nativeplugin/HealthConnectRationaleActivity.kt` | Pflicht-Activity, die beim Health-Connect-Dialog die Datenschutzerklärung öffnet |

## Einbau (aus `nativeapp/`)

Das Plugin ist bereits als lokale Abhängigkeit in `nativeapp/package.json` eingetragen
(`"fitinn-native": "file:plugins/fitinn-native"`). Damit reicht:

```bash
cd nativeapp
npm install                 # verlinkt das lokale Plugin nach node_modules
npx cap add android         # falls android/ noch nicht existiert
npm run android             # cap sync android + patch-native.js + Android Studio öffnen
```

`npx cap sync android` bindet das Plugin **automatisch** als Gradle-Modul ein und
registriert es bei Capacitor – **keine** Änderung an der `MainActivity` nötig
(Capacitor findet das `@CapacitorPlugin`-annotierte Plugin selbst).

`patch-native.js` erledigt zusätzlich:
- hebt `minSdkVersion` in `android/variables.gradle` auf **26** an (Health Connect braucht API 26),
- trägt die App-Berechtigungen + die WebView-Kamerafreigabe nach.

Die Health-Connect-Berechtigungen, die `<queries>` und die Rationale-Activity kommen
aus dem **Plugin-Manifest** und werden vom Manifest-Merger automatisch ins
App-Manifest übernommen – nichts von Hand kopieren.

## In Android Studio

1. **Bauen:** *Build → Make Project* (lädt Health Connect + Play-Location aus Maven).
2. Auf einem **echten Gerät** starten (▶︎). Zum Testen von Health Connect muss die
   **Health-Connect-App** installiert sein (auf Android 14+ ist sie Teil des Systems,
   davor aus dem Play Store: „Health Connect von Android").
3. Prüfen:
   - **Morgen-Check / „Training mit Puls"** → fragt Bluetooth, verbindet den Gurt, Live-Puls.
   - **Outdoor-Training** → fragt Standort, Strecke/Tempo laufen mit.
   - **Training → Verlauf → „Health verbinden"** → Health-Connect-Dialog, danach Import.

## Google Play – Health-Connect-Freigabe

Health-Connect-Apps prüft Google gesondert. Vor der Veröffentlichung nötig:

1. **Datenschutzerklärung** muss die Health-Connect-Nutzung nennen. Die
   Rationale-Activity öffnet `https://www.fit-inn-trier.de/datenschutz` – dort muss der
   Passus stehen (Gesundheitsdaten, kein Werbe-Einsatz). URL ggf. in
   `HealthConnectRationaleActivity.kt` anpassen.
2. In der **Play Console → App-Inhalte → Health Connect** die Nutzung deklarieren
   (welche Datentypen, wozu) und das Formular ausfüllen.
3. Die angefragten Datentypen im Formular müssen zu den Berechtigungen im Manifest
   passen (Training, Herzfrequenz, Ruhepuls, HRV, Distanz, Kalorien, Schritte,
   Gewicht, Körperfett, VO₂max, Schlaf).

## Grenzen (bewusst offen gelassen)

- **Hintergrund-Tracking** (Bildschirm aus): Dieses Modul trackt nur im Vordergrund
  (Fused Location + Wake-Lock der WebView). Echtes Hintergrund-GPS bräuchte einen
  Foreground-Service + `ACCESS_BACKGROUND_LOCATION`.
- **HRV:** Health Connect liefert RMSSD (Apple Health nutzt SDNN) – der jeweils
  plattformübliche Wert wird durchgereicht.
- **`saveHealthWorkout`** schreibt Einheit + Kalorien + Distanz (kein Puls-Verlauf).

## Wenn ihr schon ein eigenes `FitInnNative` habt (Face-ID / Push / WLAN)

Der JS-Shim in `mitglieder.html` (`woNativeBind`) mischt sich **additiv** in ein
vorhandenes `window.FitInnNative` und überschreibt nur Health/BLE/GPS. Betreibt aber
**nicht zwei native Plugins mit demselben `jsName = "FitInnNative"`** parallel – dann
die Methoden aus `FitInnNativePlugin.kt` in euer bestehendes Plugin übernehmen.
