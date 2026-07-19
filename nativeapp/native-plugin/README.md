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
| `ios/MainViewController.swift` | App-Startseite (Storyboard `customClass`); **meldet das Plugin bei Capacitor an** (`capacitorDidLoad` → `registerPluginInstance`) und spielt den `window.FitInnNative`-Shim in die WebView ein |
| `ios/FitInnNativePlugin.swift` | Das Plugin: HealthKit + CoreBluetooth + CoreLocation. Registriert sich bei Capacitor 6+/8 selbst über `CAPBridgedPlugin` (`jsName = "FitInnNative"`). |
| `ios/FitInnNativePlugin.m` | Nur noch Alt-Kompatibilität (Capacitor ≤5). Unter Capacitor 8 inaktiv – kann bleiben. |
| `fitinn-native-bridge.js` | Reine **Referenz** des Shims (der echte Code steckt eingebettet in `MainViewController.swift`) |

## Einbau

1. **iOS-Projekt erzeugen** (falls noch nicht geschehen), aus `nativeapp/`:
   ```bash
   npm install
   npx cap add ios
   npm run ios      # sync + patch-native.js + Xcode öffnen
   ```

2. **`MainViewController.swift`** gehört an den festen Pfad
   `ios/App/App/MainViewController.swift` (das Storyboard verweist bereits darauf).
   Am einfachsten per Terminal kopieren:
   ```bash
   cp native-plugin/ios/MainViewController.swift ios/App/App/MainViewController.swift
   ```
   (Xcode kennt den Verweis schon – sonst die Datei einmal in **App › App** ziehen.)

3. **Plugin hinzufügen:** In Xcode `FitInnNativePlugin.swift` **und**
   `FitInnNativePlugin.m` per Drag-&-Drop in die Gruppe **App › App** ziehen
   (⚠️ „Copy items if needed" **an**, Target **App** anhaken). Beim ersten `.m`-Import
   bietet Xcode an, einen *Bridging Header* anzulegen → **Ja**.

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

6. **Bauen & auf echtem iPhone testen:** Clean Build Folder (⇧⌘K), Gerät wählen, ▶︎.
   - Morgen-Check / „Training mit Puls" → fragt Bluetooth, verbindet den Gurt, zeigt Live-Puls.
   - Outdoor-Training → fragt Standort, Strecke/Tempo laufen mit.
   - Training › Verlauf › „Apple Health verbinden" → HealthKit-Dialog, danach werden Einheiten importiert.

> Hinweis: Der Shim steckt eingebettet in `MainViewController.swift` – die Datei
> `fitinn-native-bridge.js` muss **nicht** ins Bundle. Sie dient nur als lesbare
> Referenz; Änderungen dort bitte auch im String in `MainViewController.swift`
> nachziehen.

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
