'use strict';

/**
 * Aufbereitung von Fehlermeldungen aus der App, bevor sie in ein Log geraten.
 *
 * Warum getrennt und getestet: die Governance verbietet Prompts, Modellantworten und
 * Gesundheitsdaten in Fehlerlogs (docs/KI-GOVERNANCE.md). Ein Fehlertext kann aber
 * beliebigen Inhalt mitschleppen – etwa wenn eine Eingabe in der Meldung landet.
 * Deshalb wird alles, was nach personenbezogener oder geheimer Angabe aussieht,
 * ersetzt, bevor irgendetwas geschrieben wird. Im Zweifel lieber unkenntlich machen
 * als durchlassen: ein unbrauchbares Log ist besser als ein Datenleck.
 */

const MAX_MSG = 300;
const MAX_FIELD = 120;

// Reihenfolge zaehlt: Spezifisches vor Allgemeinem, sonst frisst die Ziffernregel
// Teile der Tokens weg und die Muster greifen nicht mehr.
const MASKEN = [
  [/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[token]'],   // JWT
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[schluessel]'],                            // AWS-Zugriffsschluessel
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [token]'],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{6,}/g, '[schluessel]'],
  [/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[bild]'],              // eingebettete Fotos
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Za-z0-9]{4}){3,7}\b/g, '[iban]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/\+?\d[\d\s()/-]{7,}\d/g, '[nummer]'],                                        // Telefon, Mitgliedsnummer
  [/\b\d{6,}\b/g, '[zahl]'],
];

function maskiere(s) {
  let out = String(s == null ? '' : s);
  for (const [re, mit] of MASKEN) out = out.replace(re, mit);
  return out;
}

// Fragezeichen-Teil einer URL entfernen: dort stehen Codes, Einladungs- und Chat-IDs.
function kuerzeUrl(u) {
  const s = String(u == null ? '' : u);
  if (!s) return '';
  return maskiere(s.split('?')[0].split('#')[0]).slice(0, MAX_FIELD);
}

function feld(v, max) {
  return maskiere(String(v == null ? '' : v)).replace(/\s+/g, ' ').trim().slice(0, max || MAX_FIELD);
}

// Die Versionsangabe stammt aus unserem eigenen Build-Vermerk, nicht aus Nutzereingaben.
// Sie durch die Maskierung zu schicken wuerde das Datum als Telefonnummer verschlucken –
// dabei ist gerade sie entscheidend, um zu wissen, welchen Stand ein Geraet hat.
// Deshalb hier eine Zeichenbegrenzung statt Mustererkennung.
function version(v) {
  return String(v == null ? '' : v).replace(/[^\wÄÖÜäöüß .·:+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/**
 * Meldung aus dem Client in einen log-fähigen Datensatz überführen.
 * Gibt null zurück, wenn nichts Verwertbares übrig bleibt – dann wird auch nichts geloggt.
 */
function aufbereiten(body) {
  const b = body && typeof body === 'object' ? body : {};
  const message = feld(b.message, MAX_MSG);
  if (!message) return null;

  const typ = /^(fehler|abgelehnt)$/.test(String(b.type)) ? String(b.type) : 'fehler';
  const screen = String(b.screen || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
  const zeile = Number.isFinite(Number(b.line)) ? Math.max(0, Math.min(999999, Math.round(Number(b.line)))) : 0;
  const spalte = Number.isFinite(Number(b.col)) ? Math.max(0, Math.min(999999, Math.round(Number(b.col)))) : 0;

  // Nur die erste Stack-Zeile: sie zeigt den Ort, alles Weitere bringt hier nichts
  // und erhoeht nur das Risiko, dass Inhalte mitlaufen.
  const stack = feld(String(b.stack || '').split('\n')[0], MAX_FIELD);

  return {
    typ: typ,
    message: message,
    quelle: kuerzeUrl(b.source),
    zeile: zeile,
    spalte: spalte,
    screen: screen,
    version: version(b.version),
    ua: feld(b.ua, MAX_FIELD),
    stack: stack === message ? '' : stack,
  };
}

// Einzeiler fuer die Laufzeit-Logs (dort sucht das Team laut Uebergabe zuerst).
function alsLogZeile(rec) {
  if (!rec) return '';
  const teile = ['[client-fehler]', rec.typ, 'screen=' + (rec.screen || '?')];
  if (rec.quelle) teile.push(rec.quelle + ':' + rec.zeile + ':' + rec.spalte);
  if (rec.version) teile.push('v=' + rec.version);
  if (rec.ua) teile.push('ua=' + rec.ua);
  teile.push('| ' + rec.message);
  if (rec.stack) teile.push('| ' + rec.stack);
  return teile.join(' ');
}

module.exports = { aufbereiten, alsLogZeile, maskiere, MAX_MSG };
