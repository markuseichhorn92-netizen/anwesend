'use strict';

/**
 * Lead-/Interessenten-Automatik für eingehende WhatsApp-Nachrichten.
 * -----------------------------------------------------------------
 * Wenn eine WhatsApp-Nummer KEINEM Mitglied zugeordnet werden kann (Interessent,
 * z. B. Probetraining-Anfrage), wird der Vorgang als Lead im Posteingang geführt.
 * Diese Schicht ergänzt:
 *   1) eine EINMALIGE freundliche Auto-Frage beim ersten Kontakt (Name + Anliegen),
 *   2) das automatische Anlegen als Magicline-Lead, sobald Vor-/Nachname + E-Mail
 *      vorliegen UND die Lead-Config das mit unseren Daten zulässt,
 *   3) anschließend die Zuordnung des Vorgangs zum neu angelegten Kunden.
 *
 * Idempotenz: nach dem Anlegen wird die Telefonnummer -> Kundennummer gemappt
 * (Key wamap:<phone>), damit Folgenachrichten nicht zu Dubletten führen.
 */

const M = require('./members');
const Inbox = require('./inbox');
const WA = require('./whatsapp');
const View = require('./teamView');
const { redisPipeline, hasStore } = require('./store');

const LINK_TTL = 60 * 60 * 24 * 90;   // 90 Tage Telefon->Kunde-Map

function firstName(name) { return String(name || '').trim().split(/\s+/).filter(Boolean)[0] || ''; }

// Einmalige Begrüßung/Frage an einen unbekannten Kontakt.
function leadIntro(name) {
  const fn = firstName(name);
  return (fn ? ('Hallo ' + fn + '! ') : 'Hallo! ')
    + 'Willkommen bei Fit-Inn Trier 👋 Schön, dass du dich meldest! Damit wir uns schnell um dich kümmern können: '
    + 'Magst du mir kurz deinen Vor- und Nachnamen schreiben – und falls du Interesse an einer Mitgliedschaft oder einem Probetraining hast, auch deine E-Mail-Adresse? Danke dir! 💪';
}

// Telefon <-> bereits angelegter Kunde (verhindert Doppel-Anlage + Doppel-Vorgänge).
async function resolveKnownLead(phone) {
  if (!hasStore || !phone) return null;
  try { const [v] = await redisPipeline([['GET', 'wamap:' + phone]]); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
async function linkPhone(phone, data) {
  if (!hasStore || !phone || !data) return;
  try { await redisPipeline([['SET', 'wamap:' + phone, JSON.stringify(data), 'EX', String(LINK_TTL)]]); } catch (e) {}
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// "Vorname Nachname" (2–3 Tokens, nur Namensbuchstaben).
const NAME_RE = /^([A-Za-zÄÖÜäöüßéèáàíìúùâêîôû'’.-]{2,})\s+([A-Za-zÄÖÜäöüßéèáàíìúùâêîôû'’.-]{2,}(?:\s+[A-Za-zÄÖÜäöüßéèáàíìúùâêîôû'’.-]{2,})?)$/;
// Wörter, die eine Nachricht als „kein reiner Name" entlarven.
const NAME_STOP = /(probe|training|mitglied|frage|hallo|hi |servus|moin|info|interess|vertrag|kosten|preis|öffnung|termin|danke|kurs|gym|fitness|anmeld|kündig|wann|wie|was|gerne|bitte)/i;

// Name (Vor-/Nachname) + E-Mail aus Profilname + Kundennachrichten ziehen.
function extractLead(vorgang, profileName) {
  const out = { firstname: null, lastname: null, email: null };
  const texts = (((vorgang && vorgang.messages) || []).filter((m) => m.from === 'member').map((m) => String(m.text || '')));
  for (const t of texts) { const m = t.match(EMAIL_RE); if (m) { out.email = m[0]; break; } }
  const pn = String(profileName || '').trim();
  const ptoks = pn.split(/\s+/).filter(Boolean);
  if (ptoks.length >= 2 && !NAME_STOP.test(pn) && !EMAIL_RE.test(pn)) {
    out.firstname = ptoks[0]; out.lastname = ptoks.slice(1).join(' ');
  } else {
    for (const t of texts) {
      const tt = t.trim();
      if (tt.length > 40 || NAME_STOP.test(tt) || EMAIL_RE.test(tt)) continue;
      const m = tt.match(NAME_RE);
      if (m) { out.firstname = m[1]; out.lastname = m[2]; break; }
    }
  }
  return out;
}

// Lässt die Lead-Config eine Anlage allein mit unseren WhatsApp-Daten zu?
function configSatisfiable(cfg) {
  if (!cfg) return false;
  if (cfg.addressMode === 'MANDATORY') return false;       // Adresse haben wir nicht
  if (cfg.dateOfBirthMode === 'MANDATORY') return false;
  if (cfg.genderMode === 'MANDATORY') return false;
  const ai = cfg.additionalInformation || [];
  if (ai.some((f) => f && f.mode === 'MANDATORY')) return false;   // unbekannte Zusatz-Pflichtfelder
  return true;
}

/**
 * Bei jeder Lead-Nachricht aufrufen.
 * o: { memberId(Pseudo "wa<phone>"), vorgang, phone, profileName, firstContact }
 * Liefert { created, customerId?, customerNumber?, reason?, vorgang? }.
 */
async function onLeadMessage(o) {
  o = o || {};
  const memberId = o.memberId, vorgang = o.vorgang, phone = o.phone;
  let created = null;
  try {
    const known = await resolveKnownLead(phone);
    if (!(known && known.id)) {
      const d = extractLead(vorgang, o.profileName);
      if (d.firstname && d.lastname && d.email) {
        // Dubletten-Schutz: Existiert die Person schon (per E-Mail)? -> verknüpfen statt neu anlegen.
        let existing = null;
        try { const byMail = await M.searchByEmail(d.email); if (byMail && byMail.length) existing = byMail.find((c) => c && c.customerNumber) || byMail[0]; } catch (e) {}
        if (existing && (existing.id != null || existing.customerId != null)) {
          const exId = String(existing.id != null ? existing.id : existing.customerId);
          const nm = ((existing.firstName || '') + ' ' + (existing.lastName || '')).trim() || (d.firstname + ' ' + d.lastname);
          const snap = { name: nm, nr: existing.customerNumber || null, initials: View.initials(nm), email: existing.email || d.email, phone: String(phone) };
          await linkPhone(phone, { id: exId, name: nm, nr: existing.customerNumber || null });
          const moved = await Inbox.reassign(memberId, vorgang.id, exId, snap);
          if (moved) { try { await Inbox.addNote(exId, moved.id, { author: 'System', text: 'Bestehender Kunde per E-Mail erkannt – Vorgang verknüpft (kein neuer Lead angelegt).' }); } catch (e) {} }
          created = { created: false, linkedExisting: true, customerId: exId, vorgang: moved };
        } else {
          let cfg = null; try { cfg = await M.getLeadConfig(); } catch (e) {}
          if (!configSatisfiable(cfg)) {
            try { await Inbox.addNote(memberId, vorgang.id, { author: 'System', text: 'Auto-Anlage in Magicline nicht möglich – Pflichtfelder (z. B. Adresse/Geburtsdatum) fehlen. Bitte manuell anlegen.' }); } catch (e) {}
            created = { created: false, reason: 'config' };
          } else {
            const tel = '+' + String(phone).replace(/[^\d]/g, '');
            const r = await M.createLead({ firstname: d.firstname, lastname: d.lastname, email: d.email, telephone: tel });
            if (r && r.ok && r.customerId != null) {
              const newId = String(r.customerId);
              const full = (d.firstname + ' ' + d.lastname).trim();
              const snap = { name: full, nr: r.customerNumber || null, initials: View.initials(full), email: d.email, phone: String(phone) };
              await linkPhone(phone, { id: newId, name: full, nr: r.customerNumber || null });
              const moved = await Inbox.reassign(memberId, vorgang.id, newId, snap);
              if (moved) { try { await Inbox.addNote(newId, moved.id, { author: 'System', text: 'Automatisch als Lead in Magicline angelegt' + (r.customerNumber ? (' · ' + r.customerNumber) : '') + '.' }); } catch (e) {} }
              created = { created: true, customerId: newId, customerNumber: r.customerNumber || null, vorgang: moved };
            } else {
              try { await Inbox.addNote(memberId, vorgang.id, { author: 'System', text: 'Automatische Lead-Anlage fehlgeschlagen (HTTP ' + ((r && r.status) || '?') + '). Bitte manuell in Magicline anlegen.' }); } catch (e) {}
              created = { created: false, reason: 'api' };
            }
          }
        }
      } else {
        created = { created: false, reason: 'incomplete' };
      }
    } else {
      created = { created: false, reason: 'linked' };
    }
  } catch (e) { created = { created: false, reason: 'error', error: e && e.message }; }

  // Einmalige Auto-Frage beim ersten Kontakt (nur wenn wir nicht ohnehin schon angelegt haben).
  if (o.firstContact && !(created && created.created) && WA.hasWhatsApp) {
    try { await WA.sendText(phone, leadIntro(o.profileName)); } catch (e) {}
  }
  return created || { created: false };
}

module.exports = { leadIntro, extractLead, configSatisfiable, resolveKnownLead, linkPhone, onLeadMessage };
