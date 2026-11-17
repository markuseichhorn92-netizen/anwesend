'use strict';

/**
 * POST /api/phone/callback
 *   { key, name, phone, topic, note?, preferred?, email? }
 *
 * Nimmt einen Rückrufwunsch aus dem Telefonat auf und schickt ihn per E-Mail
 * ans Team (MAIL_TO). Das ist der ehrliche Weg für alles, was der Assistent
 * nicht selbst erledigen darf – Vertrag, Kündigung, Beschwerde, persönliche
 * Anliegen. Er verspricht damit nichts, was er nicht halten kann.
 *
 * Bewusst KEINE Mitgliedsdaten und KEIN Magicline-Zugriff: Am Telefon ist der
 * Anrufer nicht verifiziert. Wir speichern nur, was er selbst nennt.
 *
 * Gesundheitsangaben gehören hier nicht hinein. Der Assistent ist angewiesen,
 * danach nicht zu fragen; zusätzlich kappen wir die Freitextlänge.
 */

const P = require('../../lib/phoneApi');
const SR = require('../../lib/studioReply');

const TOPICS = {
  probetraining: 'Probetraining',
  vertrag: 'Vertrag / Mitgliedschaft',
  kuendigung: 'Kündigung',
  beitrag: 'Beitrag / Rechnung',
  kurse: 'Kurse & Termine',
  beschwerde: 'Beschwerde',
  sonstiges: 'Sonstiges',
};

// Telefonnummern kommen aus der Spracherkennung oft mit Leerzeichen und
// ausgeschriebenen Zeichen. Wir normalisieren nur grob – lieber die Rohform
// behalten, als eine falsche Nummer zu erzeugen.
function cleanPhone(s) {
  const raw = String(s || '').trim();
  const digits = raw.replace(/[^\d+]/g, '');
  return { raw: raw.slice(0, 40), digits: digits.slice(0, 20) };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return P.json(res, 405, { ok: false, error: 'method_not_allowed' });
  const body = await P.readBody(req);
  const g = await P.guard(req, body, 40);
  if (!g.ok) return P.json(res, g.code, g.body);

  const name = String(body.name || '').trim().slice(0, 80);
  const ph = cleanPhone(body.phone);
  if (!name || ph.digits.length < 6) {
    return P.json(res, 200, {
      ok: false, error: 'missing',
      text: 'Dafür brauche ich noch den Namen und eine Rufnummer.',
    });
  }

  const key = String(body.topic || 'sonstiges').toLowerCase();
  const topic = TOPICS[key] || TOPICS.sonstiges;
  const note = String(body.note || '').trim().slice(0, 400);
  const preferred = String(body.preferred || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().slice(0, 120);

  const when = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', dateStyle: 'full', timeStyle: 'short',
  }).format(new Date());

  const lines = [
    'Rückruf-Wunsch aus dem Telefonassistenten',
    '',
    'Name:     ' + name,
    'Telefon:  ' + ph.raw,
    'Thema:    ' + topic,
  ];
  if (preferred) lines.push('Wunsch:   ' + preferred);
  if (email) lines.push('E-Mail:   ' + email);
  if (note) lines.push('', 'Notiz aus dem Gespräch:', note);
  lines.push('', 'Eingegangen: ' + when,
    '', 'Hinweis: Der Anrufer wurde am Telefon NICHT als Mitglied verifiziert.',
    'Bitte die Identität beim Rückruf selbst prüfen, bevor Vertragsdaten genannt werden.');

  let sent = false;
  try {
    const r = await SR.notifyStudio({ subject: 'Rückruf: ' + topic + ' – ' + name, text: lines.join('\n') });
    sent = !!(r && r.ok !== false);
  } catch (e) { sent = false; }

  // Auch wenn die Mail klemmt, bekommt der Anrufer keine Fehlermeldung vorgelesen –
  // aber wir sagen dem Assistenten die Wahrheit, damit er auf die Zentrale verweist.
  return P.json(res, 200, {
    ok: true,
    delivered: sent,
    text: sent
      ? ('Alles notiert, ' + name.split(' ')[0] + '. Das Team meldet sich bei Ihnen unter der genannten Nummer.')
      : 'Ich habe es notiert. Falls Sie es eilig haben, erreichen Sie uns direkt unter 0651 308524.',
    topic: topic,
  });
};
