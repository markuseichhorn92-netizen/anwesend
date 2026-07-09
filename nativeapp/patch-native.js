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
 *
 * Es ist ein NO-OP, solange `ios/`/`android/` noch nicht erzeugt wurden, und
 * fügt vorhandene Schlüssel NICHT doppelt hinzu. Läuft automatisch aus den
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

function main() {
  console.log('Fit-Inn · native Kamera/Mikro-Berechtigungen prüfen …');
  try { patchInfoPlist(); } catch (e) { console.error('✗ iOS-Patch fehlgeschlagen:', e && e.message); }
  try { patchAndroidManifest(); } catch (e) { console.error('✗ Android-Patch fehlgeschlagen:', e && e.message); }
  console.log('Fertig.');
}

main();
