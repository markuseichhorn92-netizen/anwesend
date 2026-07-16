'use strict';

/**
 * Team-Berechtigungen (Least Privilege).
 * --------------------------------------
 * Jede Team-API trägt eine explizite Fähigkeit (Capability). Die Rollen-Matrix
 * bildet die bestehende Produkt-Semantik ab (Frontend ADMIN_ONLY_SCREENS:
 * Statistiken, Nachrichten/Broadcast, Leads, Assistent, Rückholung, Community)
 * – jetzt SERVERSEITIG durchgesetzt statt nur in der Oberfläche versteckt.
 *
 * Rollen:
 *  - admin    Passwort-Login (Studio-Leitung) – alle Fähigkeiten.
 *  - trainer  persönlicher Mitarbeiter-Login (E-Mail-Code) – Tagesgeschäft,
 *             aber keine Admin-Bereiche (Statistiken, Broadcast/Direktnachricht,
 *             Leads, KI-Assistent, Rückholung/Churn, Community-Moderation,
 *             Impersonation, Mahnwesen).
 *
 * Migration zu persönlichen Konten mit MFA: siehe docs/SECURITY.md – die
 * Capability-Schicht ist dafür vorbereitet (Fähigkeiten hängen an der Rolle
 * der Session, nicht am Login-Verfahren).
 */

const TA = require('./teamAuth');

// Fähigkeiten-Vokabular (Endpunkte referenzieren genau diese Strings).
const ALL_CAPS = [
  'member.read',            // Mitglieder suchen/ansehen, Dubletten
  'member.write',           // Stammdaten, Tags, Zugangsmedien, Aktions-Links, Pausen
  'documents.read',         // Dokumente/PDF-Bestätigungen ansehen/erzeugen
  'documents.write',        // Dokumente hochladen/ans Mitglied senden
  'checkin.manage',         // Check-in-Verlauf + Anwesenheitsbestätigungen
  'training.manage',        // Trainingspläne des Mitglieds verwalten
  'nutrition.manage',       // Ernährungsdaten/Coaching einsehen & pflegen
  'conversations.manage',   // Posteingang: Vorgänge lesen/beantworten, Snippets, Smart-Reply
  'appointments.manage',    // Termine ansehen/buchen/absagen
  'shifts.manage',          // Schichtplan, Tausch, Verfügbarkeiten, Team-Chat, Mitarbeiterliste
  'todos.manage',           // interne Aufgabenliste
  'content.manage',         // Hilfe-Artikel pflegen
  'admin.manage',           // Admin-Bereiche (Statistiken, Broadcast, Leads, Assistent,
                            // Rückholung/Churn, Community-Moderation, Impersonation, Mahnliste)
];

const TRAINER_CAPS = new Set([
  'member.read', 'member.write',
  'documents.read', 'documents.write',
  'checkin.manage', 'training.manage', 'nutrition.manage',
  'conversations.manage', 'appointments.manage',
  'shifts.manage', 'todos.manage', 'content.manage',
]);

// Hat die Session die Fähigkeit? Admin hat alle; unbekannte Rollen haben keine.
function can(sess, cap) {
  const role = TA.roleOf(sess);
  if (!role) return false;
  if (role === 'admin') return true;
  if (role === 'trainer') return TRAINER_CAPS.has(cap);
  return false;
}

// Guard für Handler: prüft die Fähigkeit und beantwortet 403 selbst.
// Verwendung:  if (!Cap.requireCap(sess, 'member.read', res)) return;
function requireCap(sess, cap, res) {
  if (can(sess, cap)) return true;
  res.statusCode = 403;
  res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
  return false;
}

// Komplett-Guard: Session auflösen + Fähigkeit prüfen (401/403 inklusive).
// Verwendung:  const sess = await Cap.requireCapability(req, res, 'member.read'); if (!sess) return;
async function requireCapability(req, res, cap) {
  const sess = await TA.requireTeam(req);
  if (!sess) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return null;
  }
  if (cap && !can(sess, cap)) {
    res.statusCode = 403;
    res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
    return null;
  }
  return sess;
}

module.exports = { ALL_CAPS, TRAINER_CAPS, can, requireCap, requireCapability };
