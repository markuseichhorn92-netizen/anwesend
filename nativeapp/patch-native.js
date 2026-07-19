#!/usr/bin/env node
'use strict';

/*
 * Fit-Inn · Native-Berechtigungen nachtragen (Kamera, Mikrofon, Fotos, Sprache).
 * ---------------------------------------------------------------------------
 * Capacitor erzeugt `ios/` und `android/` OHNE die Nutzungs-Beschreibungen für
 * Kamera & Mikrofon. Fehlen die unter iOS, STÜRZT die App hart ab, sobald die
 * WebView die Kamera/das Mikrofon öffnet (z. B. Essen-Foto, Attest-Foto,
 * Sprach-Diktat) – iOS beendet den Prozess sofort (SIGABRT).
 *
 * Dieses Skript trägt die nötigen Schlüssel idempotent nach:
 *   - iOS  Info.plist:            NSCameraUsageDescription, NSMicrophoneUsageDescription,
 *                                 NSSpeechRecognitionUsageDescription,
 *                                 NSPhotoLibraryUsageDescription, NSPhotoLibraryAddUsageDescription,
 *                                 NSBluetoothAlwaysUsageDescription, NSBluetoothPeripheralUsageDescription
 *                                 (Bluetooth für den H9-Morgen-Check),
 *                                 NSLocationWhenInUseUsageDescription (Outdoor-Training + Check-in),
 *                                 NSHealthShareUsageDescription, NSHealthUpdateUsageDescription (Apple Health)
 *   - Android AndroidManifest.xml: CAMERA, RECORD_AUDIO, BLUETOOTH_SCAN, BLUETOOTH_CONNECT,
 *                                 ACCESS_FINE/COARSE_LOCATION (Outdoor), health.READ/WRITE_* (Health Connect)
 *                                 (+ Kamera als optionales Feature)
 *   - Android MainActivity.java:  (1) fragt CAMERA/RECORD_AUDIO zur LAUFZEIT an und
 *                                 (2) setzt einen WebChromeClient mit onPermissionRequest, der
 *                                 die Kamera/Mikro für die eigene Domain im WebView freigibt.
 *                                 BEIDES ist nötig: Ohne das Laufzeit-Recht UND ohne das
 *                                 onPermissionRequest lehnt der Android-WebView getUserMedia ab
 *                                 (NotAllowedError → „Kamerazugriff wurde nicht erlaubt") – dann
 *                                 geht die Live-Kamera fürs Essen-Tracking / den Barcode-Scan /
 *                                 das Sprach-Diktat nicht. (Manifest + Laufzeit-Recht allein
 *                                 reichen auf Android NICHT; der WebView gatet Web-getUserMedia
 *                                 zusätzlich über onPermissionRequest.)
 *
 * Es ist ein NO-OP, solange `ios/`/`android/` noch nicht erzeugt wurden, und
 * fügt vorhandene Schlüssel/Anpassungen NICHT doppelt hinzu. Läuft automatisch aus den
 * npm-Scripts (`sync`, `ios`, `android`, `setup`); kann jederzeit erneut laufen.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// Klare, ehrliche deutsche Begründungen – erscheinen im iOS-Berechtigungsdialog.
const IOS_KEYS = {
  NSCameraUsageDescription:
    'Die App braucht die Kamera, um Fotos aufzunehmen – z. B. um dein Essen zu scannen oder einen Nachweis (Attest) hochzuladen.',
  NSMicrophoneUsageDescription:
    'Die App braucht das Mikrofon, damit du Mahlzeiten per Sprache eingeben kannst.',
  NSSpeechRecognitionUsageDescription:
    'Die App wandelt deine Sprache in Text um, damit du Mahlzeiten diktieren kannst.',
  NSPhotoLibraryUsageDescription:
    'Die App braucht Zugriff auf deine Fotos, damit du ein vorhandenes Bild auswählen kannst.',
  NSPhotoLibraryAddUsageDescription:
    'Die App möchte aufgenommene Fotos in deiner Mediathek speichern dürfen.',
  // Bluetooth (Polar H9 & andere BLE-Brustgurte) für den Morgen-Check.
  NSBluetoothAlwaysUsageDescription:
    'Die App verbindet sich per Bluetooth mit deinem Herzfrequenz-Gurt (z. B. Polar H9) für den Morgen-Check deiner Trainingsbereitschaft.',
  NSBluetoothPeripheralUsageDescription:
    'Die App verbindet sich per Bluetooth mit deinem Herzfrequenz-Gurt (z. B. Polar H9) für den Morgen-Check deiner Trainingsbereitschaft.',
  // Standort für Outdoor-Trainings (Strecke/Distanz/Tempo) + Studio-Check-in.
  // Hinweis: Echtes HINTERGRUND-Tracking (Bildschirm aus) braucht zusätzlich
  // NSLocationAlwaysAndWhenInUseUsageDescription, das Background-Location-Entitlement
  // und eine native watchPosition-Methode in FitInnNative. Im Vordergrund (Bildschirm an,
  // Wake-Lock) genügt „WhenInUse"; daher hier bewusst nur der WhenInUse-Schlüssel.
  NSLocationWhenInUseUsageDescription:
    'Die App braucht deinen Standort, um Outdoor-Trainings (Laufen, Radfahren) mit Strecke, Distanz und Tempo aufzuzeichnen – und um dich beim Check-in in deinem Studio zu erkennen.',
  // Apple Health (HealthKit): Trainings aus anderen Apps/Uhren übernehmen (lesen) und
  // in der App aufgezeichnete Einheiten zurückschreiben (schreiben).
  // Hinweis: HealthKit braucht ZUSÄTZLICH die HealthKit-Capability + das Entitlement
  // (com.apple.developer.healthkit) in Xcode sowie native Read/Write-Methoden in
  // FitInnNative (healthAuth/getHealthWorkouts/saveHealthWorkout, siehe docs/NATIVE-BRIDGE.md).
  // Die reinen Info.plist-Schlüssel hier reichen ohne diese native Umsetzung NICHT.
  NSHealthShareUsageDescription:
    'Die App liest deine Trainings aus Apple Health (z. B. von Apple Watch oder Garmin), damit sie für deine Erholung und deine Vitalpunkte zählen.',
  NSHealthUpdateUsageDescription:
    'Die App schreibt deine in der App aufgezeichneten Trainings nach Apple Health, damit alle deine Einheiten an einem Ort zusammenlaufen.',
};

const ANDROID_PERMISSIONS = [
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  // BLE-Herzfrequenzgurt (Android 12+ Bluetooth-Runtime-Rechte). Für ältere
  // Android-Versionen bringt das Plugin die Legacy-Rechte (BLUETOOTH/…_ADMIN) selbst mit.
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  // Standort für Outdoor-Trainings (Strecke/Distanz/Tempo) + Studio-Check-in.
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  // Health Connect (Google Fit-Nachfolger): Trainings lesen/schreiben.
  // Hinweis: Health Connect braucht ZUSÄTZLICH das androidx.health.connect-SDK, eine
  // PermissionsRationaleActivity mit Intent-Filter (ACTION_SHOW_PERMISSIONS_RATIONALE) und
  // eine veröffentlichte Datenschutzerklärung – plus native Read/Write-Methoden in
  // FitInnNative (siehe docs/NATIVE-BRIDGE.md). Die Manifest-Rechte hier allein genügen NICHT.
  'android.permission.health.READ_EXERCISE',
  'android.permission.health.WRITE_EXERCISE',
  'android.permission.health.READ_HEART_RATE',
  'android.permission.health.READ_DISTANCE',
  'android.permission.health.READ_ACTIVE_CALORIES_BURNED',
];
const ANDROID_FEATURES = [
  // Kamera/Mikro nur „optional" verlangen, damit Geräte ohne Kamera die App
  // trotzdem aus dem Play Store installieren können.
  { name: 'android.hardware.camera', required: 'false' },
  { name: 'android.hardware.microphone', required: 'false' },
];

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function patchInfoPlist() {
  const p = path.join(ROOT, 'ios', 'App', 'App', 'Info.plist');
  if (!fs.existsSync(p)) { console.log('· iOS Info.plist noch nicht vorhanden – übersprungen (' + p + ')'); return; }
  let xml = fs.readFileSync(p, 'utf8');
  const added = [];
  let block = '';
  for (const key of Object.keys(IOS_KEYS)) {
    if (new RegExp('<key>\\s*' + key + '\\s*</key>').test(xml)) continue;   // schon da
    block += '\t<key>' + key + '</key>\n\t<string>' + xmlEscape(IOS_KEYS[key]) + '</string>\n';
    added.push(key);
  }
  if (!added.length) { console.log('✓ iOS: alle Kamera/Mikro-Schlüssel bereits vorhanden.'); return; }
  // Vor dem abschließenden </dict> (Top-Level) einfügen.
  const idx = xml.lastIndexOf('</dict>');
  if (idx < 0) { console.error('✗ iOS: Info.plist unerwartetes Format – bitte Schlüssel manuell ergänzen: ' + added.join(', ')); return; }
  xml = xml.slice(0, idx) + block + xml.slice(idx);
  fs.writeFileSync(p, xml, 'utf8');
  console.log('✓ iOS: Schlüssel ergänzt → ' + added.join(', '));
}

function patchAndroidManifest() {
  const p = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(p)) { console.log('· Android AndroidManifest.xml noch nicht vorhanden – übersprungen (' + p + ')'); return; }
  let xml = fs.readFileSync(p, 'utf8');
  const lines = [];
  for (const perm of ANDROID_PERMISSIONS) {
    if (xml.indexOf('android:name="' + perm + '"') >= 0) continue;
    lines.push('    <uses-permission android:name="' + perm + '" />');
  }
  for (const feat of ANDROID_FEATURES) {
    if (xml.indexOf('android:name="' + feat.name + '"') >= 0) continue;
    lines.push('    <uses-feature android:name="' + feat.name + '" android:required="' + feat.required + '" />');
  }
  if (!lines.length) { console.log('✓ Android: alle Berechtigungen bereits vorhanden.'); return; }
  // Direkt nach dem öffnenden <manifest ...> Tag einfügen.
  const m = xml.match(/<manifest\b[^>]*>/);
  if (!m) { console.error('✗ Android: <manifest>-Tag nicht gefunden – bitte manuell ergänzen.'); return; }
  const insertAt = m.index + m[0].length;
  xml = xml.slice(0, insertAt) + '\n' + lines.join('\n') + xml.slice(insertAt);
  fs.writeFileSync(p, xml, 'utf8');
  console.log('✓ Android: ergänzt →\n' + lines.map(function (l) { return '    ' + l.trim(); }).join('\n'));
}

// Android: MainActivity so patchen, dass die Live-Kamera im WebView wirklich funktioniert.
// Zwei Dinge sind nötig – die Manifest-Berechtigung allein genügt NICHT:
//   1) CAMERA/RECORD_AUDIO zur LAUFZEIT anfragen (App-Ebene).
//   2) Einen WebChromeClient mit onPermissionRequest setzen, der die Web-getUserMedia-Anfrage
//      der eigenen Domain im WebView freigibt (WebView-Ebene). Fehlt (2), lehnt der Android-
//      WebView die Kamera ab (NotAllowedError → „Kamerazugriff wurde nicht erlaubt"), selbst
//      wenn (1) längst erteilt ist.
// Als vollständig gepatcht gilt eine MainActivity, die bereits „onPermissionRequest" enthält.
// Ersetzt werden der Capacitor-Standard UND die frühere (nur-Laufzeitrechte-)Variante – beide
// „extends BridgeActivity" ohne onPermissionRequest. Eine sonst individuell angepasste Activity
// (kein BridgeActivity) bleibt unangetastet.
function patchAndroidMainActivity() {
  const base = path.join(ROOT, 'android', 'app', 'src', 'main', 'java');
  if (!fs.existsSync(base)) { console.log('· Android MainActivity.java noch nicht vorhanden – übersprungen.'); return; }
  // MainActivity.java irgendwo unter java/ finden (Paketpfad hängt von appId ab).
  let found = null;
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const en of entries) {
      const full = path.join(dir, en.name);
      if (en.isDirectory()) walk(full);
      else if (en.name === 'MainActivity.java' && !found) found = full;
    }
  }(base));
  if (!found) { console.log('· Android MainActivity.java nicht gefunden – übersprungen.'); return; }
  let src = fs.readFileSync(found, 'utf8');
  if (src.indexOf('onPermissionRequest') >= 0) { console.log('✓ Android: MainActivity gibt Kamera im WebView bereits frei (onPermissionRequest vorhanden).'); return; }
  if (src.indexOf('extends BridgeActivity') < 0) { console.log('· Android: MainActivity ist individuell angepasst – Kamera-Freigabe (onPermissionRequest) bitte manuell ergänzen.'); return; }
  const pkgMatch = src.match(/package\s+([\w.]+)\s*;/);
  const pkg = pkgMatch ? pkgMatch[1] : 'de.fitinn.portal';
  const patched = 'package ' + pkg + ';\n\n'
    + 'import android.Manifest;\n'
    + 'import android.content.pm.PackageManager;\n'
    + 'import android.os.Bundle;\n'
    + 'import android.webkit.PermissionRequest;\n'
    + 'import androidx.core.app.ActivityCompat;\n'
    + 'import androidx.core.content.ContextCompat;\n'
    + 'import com.getcapacitor.Bridge;\n'
    + 'import com.getcapacitor.BridgeActivity;\n'
    + 'import com.getcapacitor.BridgeWebChromeClient;\n\n'
    + 'public class MainActivity extends BridgeActivity {\n'
    + '    @Override\n'
    + '    public void onCreate(Bundle savedInstanceState) {\n'
    + '        super.onCreate(savedInstanceState);\n\n'
    + '        // 1) App-Laufzeitrechte für Kamera/Mikrofon anfragen (nötige Voraussetzung).\n'
    + '        String[] perms = { Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO };\n'
    + '        boolean need = false;\n'
    + '        for (String p : perms) {\n'
    + '            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) need = true;\n'
    + '        }\n'
    + '        if (need) ActivityCompat.requestPermissions(this, perms, 4711);\n\n'
    + '        // 2) WebView-Ebene: getUserMedia der eigenen Domain freigeben. Ohne dieses\n'
    + '        //    onPermissionRequest lehnt der Android-WebView Kamera/Mikro ab, selbst wenn\n'
    + '        //    die App-Laufzeitrechte erteilt sind (Barcode-Scan, Essen-Foto, Sprach-Diktat).\n'
    + '        final Bridge b = this.getBridge();\n'
    + '        if (b != null && b.getWebView() != null) {\n'
    + '            b.getWebView().setWebChromeClient(new BridgeWebChromeClient(b) {\n'
    + '                @Override\n'
    + '                public void onPermissionRequest(final PermissionRequest request) {\n'
    + '                    String origin = request.getOrigin() != null ? request.getOrigin().toString() : "";\n'
    + '                    if (origin.contains("fit-inn-trier.de")) {\n'
    + '                        runOnUiThread(new Runnable() {\n'
    + '                            @Override\n'
    + '                            public void run() { request.grant(request.getResources()); }\n'
    + '                        });\n'
    + '                    } else {\n'
    + '                        super.onPermissionRequest(request);\n'
    + '                    }\n'
    + '                }\n'
    + '            });\n'
    + '        }\n'
    + '    }\n'
    + '}\n';
  fs.writeFileSync(found, patched, 'utf8');
  console.log('✓ Android: MainActivity ergänzt → Laufzeit-Rechte + WebView-Kamerafreigabe (onPermissionRequest) (' + found + ')');
}

function main() {
  console.log('Fit-Inn · native Kamera/Mikro-Berechtigungen prüfen …');
  try { patchInfoPlist(); } catch (e) { console.error('✗ iOS-Patch fehlgeschlagen:', e && e.message); }
  try { patchAndroidManifest(); } catch (e) { console.error('✗ Android-Patch fehlgeschlagen:', e && e.message); }
  try { patchAndroidMainActivity(); } catch (e) { console.error('✗ Android-MainActivity-Patch fehlgeschlagen:', e && e.message); }
  console.log('Fertig.');
}

main();
