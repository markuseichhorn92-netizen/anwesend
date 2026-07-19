# Natives Plugin `FitInnNative` – Einbau-Anleitung (iOS)

Dieses Gerüst setzt den `window.FitInnNative`-Vertrag (siehe
[`../../docs/NATIVE-BRIDGE.md`](../../docs/NATIVE-BRIDGE.md)) nativ um – für
**Apple Health**, den **Bluetooth-Herzgurt** und **GPS**. Danach funktionieren in
der iPhone-App der Vital-Check, die Trainings-Aufzeichnung (Indoor + Outdoor) und
der Health-Sync.

> ⚠️ **Nicht getestet.** Der Code ist gegen den Vertrag geschrieben, aber HealthKit
> und Bluetooth laufen nur auf einem **echten iPhone** (nicht im Simulator) und
> müssen dort geprüft werden. Ihr braucht einen **Mac mit Xcode** und einen
> **Apple-Developer-Account**.

## Dateien

| Datei | Zweck |
|---|---|
| `ios/FitInnNativePlugin.swift` | Das Plugin: HealthKit + CoreBluetooth + CoreLocation |
| `ios/FitInnNativePlugin.m` | Registriert das Plugin bei Capacitor als `FitInnNative` |
| `fitinn-native-bridge.js` | JS-Shim: baut `window.FitInnNative` aus dem Plugin |

## Einbau in 6 Schritten

1. **iOS-Projekt erzeugen** (falls noch nicht geschehen), aus `nativeapp/`:
   ```bash
   npm install
   npx cap add ios
   npx cap sync
   npx cap open ios
   ```

2. **Plugin-Dateien hinzufügen:** In Xcode die beiden Dateien aus `ios/` per
   Drag-&-Drop in die Gruppe **App › App** ziehen (⚠️ „Copy items if needed" **an**,
   Target **App** anhaken). Beim ersten `.m`/`.swift`-Import bietet Xcode an, einen
   *Bridging Header* anzulegen → **Ja**.

3. **JS-Shim ins Bundle:** `fitinn-native-bridge.js` ebenfalls in **App › App**
   ziehen und sicherstellen, dass sie unter **Target › Build Phases › Copy Bundle
   Resources** auftaucht. (Das Plugin lädt sie in `load()` und injiziert sie in die
   WebView.)

4. **HealthKit-Capability aktivieren:** Target **App** › Reiter **Signing &
   Capabilities** › **+ Capability** › **HealthKit**. Damit setzt Xcode das
   Entitlement `com.apple.developer.healthkit`. (Ohne diesen Schritt stürzt die App
   beim ersten HealthKit-Zugriff ab bzw. wird abgelehnt.)

5. **Berechtigungstexte (Info.plist):** trägt `patch-native.js` automatisch nach –
   `NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription`,
   `NSBluetooth…`, `NSLocationWhenInUse…`. Läuft es nicht automatisch:
   ```bash
   node ../patch-native.js
   ```

6. **Bauen & auf echtem iPhone testen:** Gerät wählen, ▶︎. Prüfen:
   - Morgen-Check / „Training mit Puls" → fragt Bluetooth, verbindet den Gurt, zeigt Live-Puls.
   - Outdoor-Training → fragt Standort, Strecke/Tempo laufen mit.
   - Training › Verlauf › „Apple Health verbinden" → HealthKit-Dialog, danach werden Einheiten importiert.

## Wenn ihr schon ein `FitInnNative` habt (Face-ID / Push)

Dann NICHT zwei Plugins parallel betreiben. Zwei saubere Wege:

- **Empfohlen:** die drei Bereiche (Health/BLE/GPS) aus `FitInnNativePlugin.swift`
  in euer bestehendes Plugin übernehmen und im `.m` die Methoden ergänzen.
- **Oder:** dieses Plugin zusätzlich laufen lassen – der JS-Shim ist bewusst
  **additiv**: er mischt sich in ein vorhandenes `window.FitInnNative` und
  überschreibt nur `startHeartRate/stopHeartRate/get·watch·clearWatch/health*`.
  Face-ID-Login, Push (`onAuthed`/`onLogout`) und WLAN bleiben unberührt.

## Grenzen (bewusst offen gelassen)

- **Hintergrund-Tracking** (Bildschirm aus): Dieses Gerüst trackt nur im
  Vordergrund (WhenInUse + Wake-Lock). Echtes Hintergrund-GPS braucht zusätzlich
  `NSLocationAlwaysAndWhenInUseUsageDescription`, das Background-Location-Entitlement
  und `allowsBackgroundLocationUpdates`.
- **App-Store-Review:** HealthKit-Apps prüft Apple genauer. Im Review-Formular die
  Nutzung begründen; die **Datenschutzerklärung muss die HealthKit-Nutzung nennen**
  (Gesundheitsdaten dürfen z. B. nie für Werbung genutzt werden).
- **`saveHealthWorkout`** schreibt Einheit + Kalorien + Distanz (kein Puls-Verlauf).

## Android (Health Connect)

Der Vertrag gilt 1:1 auch für Android (Health Connect + BLE + FusedLocation), die
Manifest-Rechte trägt `patch-native.js` bereits ein. Das Kotlin-Pendant ist noch
nicht gebaut – auf Zuruf lege ich es analog an.
