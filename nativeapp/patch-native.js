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
 *                                 NSPhotoLibraryUsageDescription, NSPhotoLibraryAddUsageDescription
 *   - Android AndroidManifest.xml: CAMERA, RECORD_AUDIO (+ Kamera als optionales Feature)
 *   - Android MainActivity.java:  fragt CAMERA/RECORD_AUDIO zur LAUFZEIT an. Ohne erteiltes
 *                                 Laufzeit-Recht lehnt der Android-WebView getUserMedia ab
 *                                 (NotAllowedError) – dann geht die Live-Kamera fürs
 *                                 Essen-Tracking / den Barcode-Scan / das Sprach-Diktat nicht.
 *                                 (Die Manifest-Berechtigung allein reicht auf Android NICHT.)
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
};

const ANDROID_PERMISSIONS = [
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
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

// Android: MainActivity so patchen, dass CAMERA/RECORD_AUDIO zur Laufzeit angefragt werden.
// Grund: Der Android-WebView gibt getUserMedia (Foto-Tracking, Barcode-Scan, Sprach-Diktat)
// nur frei, wenn die App die Laufzeit-Berechtigung wirklich hält – die Manifest-Angabe allein
// genügt nicht. Wird nur der Capacitor-Standard (leere BridgeActivity) ersetzt; eine bereits
// angepasste Activity (enthält schon "requestPermissions") bleibt unangetastet.
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
  if (src.indexOf('requestPermissions') >= 0) { console.log('✓ Android: MainActivity fragt Laufzeit-Rechte bereits an.'); return; }
  if (src.indexOf('extends BridgeActivity') < 0) { console.log('· Android: MainActivity ist bereits individuell angepasst – Laufzeit-Rechte bitte manuell ergänzen.'); return; }
  const pkgMatch = src.match(/package\s+([\w.]+)\s*;/);
  const pkg = pkgMatch ? pkgMatch[1] : 'de.fitinn.portal';
  const patched = 'package ' + pkg + ';\n\n'
    + 'import android.Manifest;\n'
    + 'import android.content.pm.PackageManager;\n'
    + 'import android.os.Bundle;\n'
    + 'import androidx.core.app.ActivityCompat;\n'
    + 'import androidx.core.content.ContextCompat;\n'
    + 'import com.getcapacitor.BridgeActivity;\n\n'
    + 'public class MainActivity extends BridgeActivity {\n'
    + '    @Override\n'
    + '    public void onCreate(Bundle savedInstanceState) {\n'
    + '        super.onCreate(savedInstanceState);\n'
    + '        // Kamera/Mikrofon zur Laufzeit anfragen, damit getUserMedia im WebView\n'
    + '        // (Essen-Foto, Barcode-Scan, Sprach-Diktat) auf Android funktioniert.\n'
    + '        String[] perms = { Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO };\n'
    + '        boolean need = false;\n'
    + '        for (String p : perms) {\n'
    + '            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) need = true;\n'
    + '        }\n'
    + '        if (need) ActivityCompat.requestPermissions(this, perms, 4711);\n'
    + '    }\n'
    + '}\n';
  fs.writeFileSync(found, patched, 'utf8');
  console.log('✓ Android: MainActivity ergänzt → fragt CAMERA/RECORD_AUDIO zur Laufzeit an (' + found + ')');
}

function main() {
  console.log('Fit-Inn · native Kamera/Mikro-Berechtigungen prüfen …');
  try { patchInfoPlist(); } catch (e) { console.error('✗ iOS-Patch fehlgeschlagen:', e && e.message); }
  try { patchAndroidManifest(); } catch (e) { console.error('✗ Android-Patch fehlgeschlagen:', e && e.message); }
  try { patchAndroidMainActivity(); } catch (e) { console.error('✗ Android-MainActivity-Patch fehlgeschlagen:', e && e.message); }
  console.log('Fertig.');
}

main();
