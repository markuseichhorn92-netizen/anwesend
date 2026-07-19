# `FitInnNative` – Vertrag zwischen WebView-App und nativer Hülle

Die Mitglieder-App (`mitglieder.html`) läuft in einer Capacitor-WebView. Alles,
was der Browser nicht selbst kann (Brustgurt-Bluetooth, GPS im Hintergrund,
Apple Health / Google Fit, Biometrie, Push, WLAN-Login), stellt die **native
Hülle** über ein globales Objekt `window.FitInnNative` bereit.

Dieses Dokument ist der **Vertrag**: Was die WebView erwartet und aufruft. Der
native Teil (das eigentliche Capacitor-Plugin) liegt **nicht** in diesem Repo –
er wird gegen diesen Vertrag gebaut. Solange `FitInnNative` fehlt oder eine
Fähigkeit nicht meldet, fällt die App **sauber** auf Web-Wege bzw. auf einen
„nur in der App"-Hinweis zurück – nie auf einen harten Fehler.

> Alle Methoden sind optional. Die App prüft vor jedem Aufruf `FitInnNative` und
> das passende `available.*`-Flag bzw. die Existenz der Methode.

---

## Grundgerüst

```js
window.FitInnNative = {
  isNative: true,
  platform: 'ios' | 'android',
  __ver: 3,                       // Bridge-Version (Diagnose)
  available: {
    hr:     true,                 // Herzfrequenz-Gurt (BLE)
    geo:    true,                 // Standort / GPS
    health: true,                 // Apple Health / Google Fit
    wifi:   false,                // WLAN-Auto-Login (optional)
  },
  // Lifecycle
  onAuthed:  function(token) {},  // nach Login (Token an native Schicht)
  onLogout:  function() {},       // beim Logout
  // … je Fähigkeit die unten beschriebenen Methoden …
};
```

Wenn `FitInnNative.isNative` gesetzt ist, ruft die App beim Start
`onNativeReady()` auf. Fehlt das Objekt, läuft alles im Web-Modus.

---

## 1 · Herzfrequenz (Brustgurt, BLE) — `available.hr`

Für Morgen-Check (Vital-Check) **und** Trainings-Aufzeichnung (Indoor-Puls).

```js
// Startet das Notifizieren; ruft onSample je Messwert. Liefert ein Promise mit {ok}.
FitInnNative.startHeartRate(onSample) => Promise<{ok:boolean, error?:string}>
//   onSample({ bpm:Number, rr?:Number[] })   // rr = RR-Intervalle in ms (für HRV)
FitInnNative.stopHeartRate() => void
```

Web-Fallback: Web-Bluetooth (`navigator.bluetooth`, HR-Service `0x180D`,
Characteristic `0x2A37`). Siehe `moBleStart()` in `mitglieder.html`.

---

## 2 · Standort / GPS — `available.geo`

Für Outdoor-Training (Strecke, Distanz, Tempo, Höhe) und Studio-Check-in.

```js
FitInnNative.getPosition() => Promise<{lat, lng, alt?, acc?}>
// Live-Tracking: ruft cb je Fix, liefert eine watchId (für clearWatch).
FitInnNative.watchPosition(cb) => watchId
//   cb({ lat:Number, lng:Number, alt?:Number, acc?:Number })   // acc = Genauigkeit in m
FitInnNative.clearWatch(watchId) => void
```

Web-Fallback: `navigator.geolocation.watchPosition` bzw. gepolltes
`getCurrentPosition`. Siehe `woGeoStart()` in `mitglieder.html`.

> **Hintergrund-Tracking** (Bildschirm aus) braucht iOS
> `NSLocationAlwaysAndWhenInUseUsageDescription` + Background-Location-Entitlement
> bzw. Android einen Foreground-Service. Im Vordergrund genügt „WhenInUse" +
> Wake-Lock; darauf ist die App heute ausgelegt.

---

## 3 · Apple Health / Google Fit — `available.health`

Trainings, die **andere** Apps/Geräte aufgezeichnet haben (Apple Watch, Garmin,
Strava …), in Fit-Inn übernehmen — und in der App aufgezeichnete Einheiten
zurückschreiben. Quelle: `woHealth*`-Funktionen in `mitglieder.html`,
Server-Aktion `action:'import'` in `api/member/workouts.js`,
reine Logik in `lib/workouts.js` (`fromExternal`, `importMerge`).

```js
// Freigabe anfragen (HealthKit / Health Connect Permission-Dialog).
FitInnNative.healthAuth() => Promise<{ ok:boolean, read:boolean, write:boolean }>

// Trainings seit sinceTs (ms) lesen. Nur Trainings/Workouts, keine Rohdaten.
FitInnNative.getHealthWorkouts(sinceTs) => Promise<{ ok:boolean, workouts: HealthWorkout[] }>

// Optional: eine in der App aufgezeichnete Einheit nach Health schreiben.
FitInnNative.saveHealthWorkout(session) => Promise<{ ok:boolean, extId?:string }>
```

### `HealthWorkout` (Lese-Format, von `getHealthWorkouts`)

```js
{
  extId:     String,   // STABILE Kennung des Health-Datensatzes (UUID). Pflicht: dedupliziert Re-Importe.
  start:     Number,   // Startzeit in ms (Unix)
  end:       Number,   // Endzeit in ms (Unix)   -> Dauer = end-start (oder durationSec direkt)
  durationSec?: Number,
  activity:  String,   // gemappt auf: laufen|radfahren|gehen|wandern|outdoor|studio|kraft|cardio|kurs
  kind?:     'indoor' | 'outdoor',   // sonst aus activity abgeleitet
  kcal?:     Number,
  avgHr?:    Number,
  maxHr?:    Number,
  distanceM?: Number,  // nur outdoor sinnvoll
  source?:   'health' | 'watch' | 'manual',
}
```

Die App schickt `workouts` unverändert an den Server; dort säubert und
dedupliziert `lib/workouts.js` (per `extId`). Fehlt `extId`, wird der Datensatz
trotzdem übernommen, kann aber bei erneutem Import doppelt entstehen — daher
**immer** die stabile Health-UUID mitgeben.

### `session` (Schreib-Format, an `saveHealthWorkout`)

```js
{ start:Number(ms), end:Number(ms), activity:String, kind:String,
  kcal?:Number, avgHr?:Number, maxHr?:Number, distanceM?:Number }
```

### Berechtigungen (Manifest/Plist) — via `nativeapp/patch-native.js`

- **iOS:** `NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription`
  (Info.plist) **plus** HealthKit-Capability + Entitlement
  `com.apple.developer.healthkit` in Xcode.
- **Android:** `android.permission.health.READ_EXERCISE` / `WRITE_EXERCISE` /
  `READ_HEART_RATE` / `READ_DISTANCE` / `READ_ACTIVE_CALORIES_BURNED`
  **plus** `androidx.health.connect`-SDK, eine `PermissionsRationaleActivity`
  (Intent-Filter `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE`) und eine
  veröffentlichte Datenschutzerklärung.

> Datenschutz: Herz- und Trainingsdaten sind Gesundheitsdaten (DSGVO Art. 9).
> Import/Speichern nur mit derselben ausdrücklichen Einwilligung wie der
> Vital-Check (`MO.getConsent`) und mit Coach Premium. Kein Medizinprodukt.

---

## 4 · Biometrie / WLAN / Push (bestehend)

```js
FitInnNative.hasBiometricLogin() => boolean
FitInnNative.biometricUnlock()  => Promise<token>
FitInnNative.connectWifi(ssid)  => Promise<{ok}>     // available.wifi
```

Push-Token-Bindung läuft über `onAuthed(token)` / `onLogout()`.

---

## Web-/Fallback-Verhalten (Zusammenfassung)

| Fähigkeit | Nativ | Web-Fallback | Ohne beides |
|-----------|-------|--------------|-------------|
| HR-Gurt   | `startHeartRate` | Web-Bluetooth | Hinweis „in der App" |
| GPS       | `watchPosition`  | `geolocation` | Hinweis „in der App" |
| Health    | `getHealthWorkouts` / `saveHealthWorkout` | – | Karte „in der App verfügbar" |
| Biometrie | `biometricUnlock` | – | Passwort-Login |

Die App bleibt in **jedem** Fall bedienbar; fehlende native Fähigkeiten führen
nie zu einem Absturz, sondern zu einem ehrlichen Hinweis.
