'use strict';

/**
 * App-Tester (geschlossener Google-Play-Test) – gemeinsame Datenlogik.
 * -------------------------------------------------------------------
 * Speichermodell (Upstash/Redis):
 *   tester:emails   Set aller angemeldeten (Gmail-)Adressen (Dedup)
 *   tester:info     Hash email -> { name, joinedAt, status:'pending'|'approved', approvedAt }
 *
 * Ablauf ist zweistufig, weil Google beim geschlossenen Test nur Konten zulässt,
 * die vorher als Tester hinterlegt wurden:
 *   1) recordSignup()  – Anmeldung (Status "pending").
 *   2) approve()       – nachdem das Studio die Adresse in der Play Console
 *                        eingetragen hat: Status "approved" + „Du bist dabei"-Mail
 *                        mit funktionierendem Beitritts-Link.
 */

const { redisPipeline, hasStore } = require('./store');
const { sendMailRaw, hasMail } = require('./mail');
const { renderEmail } = require('./emailTemplate');
const { OPTIN_URL, STORE_URL } = require('./testerLinks');

const SET_KEY = 'tester:emails';
const INFO_KEY = 'tester:info';

function hashToMap(v) {
  if (!v) return {};
  if (Array.isArray(v)) { const m = {}; for (let i = 0; i + 1 < v.length; i += 2) m[v[i]] = v[i + 1]; return m; }
  if (typeof v === 'object') return v;
  return {};
}
function parseRec(s) { try { return JSON.parse(s || '{}') || {}; } catch (e) { return {}; } }

// Anmeldung ablegen. Legt den Datensatz NUR bei einer neuen Adresse an, damit ein
// bereits freigeschalteter Tester bei erneutem Absenden nicht auf "pending" zurückfällt.
// Liefert { firstTime }.
async function recordSignup(email, name) {
  if (!hasStore) return { firstTime: true };
  const [added] = await redisPipeline([['SADD', SET_KEY, email]]);
  const firstTime = Number(added) === 1;
  if (firstTime) {
    const rec = { name: name || null, joinedAt: new Date().toISOString(), status: 'pending' };
    await redisPipeline([['HSET', INFO_KEY, email, JSON.stringify(rec)]]);
  }
  return { firstTime: firstTime };
}

// Alle Tester (sortiert nach Anmeldezeit) + Anzahl noch offener.
async function listTesters() {
  if (!hasStore) return { testers: [], pending: 0 };
  const [members, infoFlat] = await redisPipeline([['SMEMBERS', SET_KEY], ['HGETALL', INFO_KEY]]);
  const info = hashToMap(infoFlat);
  const testers = (Array.isArray(members) ? members : []).map(function (email) {
    const rec = parseRec(info[email]);
    return { email: email, name: rec.name || '', status: rec.status === 'approved' ? 'approved' : 'pending', joinedAt: rec.joinedAt || '', approvedAt: rec.approvedAt || '' };
  }).sort(function (a, b) { return String(a.joinedAt).localeCompare(String(b.joinedAt)); });
  const pending = testers.filter(function (t) { return t.status !== 'approved'; }).length;
  return { testers: testers, pending: pending };
}

// „Du bist dabei"-Mail mit funktionierendem Beitritts-Link.
async function sendWelcome(email, rec) {
  if (!hasMail) return false;
  const steps = [];
  if (OPTIN_URL) steps.push('1. Öffne auf deinem Android-Handy den Button „Tester werden" und bestätige die Teilnahme.');
  if (STORE_URL) steps.push((steps.length ? '2.' : '1.') + ' Installiere die App anschließend über Google Play – fertig!');
  const mail = renderEmail({
    preheader: 'Es ist so weit – du kannst die Fit-Inn-App jetzt testen.',
    name: (rec && rec.name) || '',
    eyebrow: 'App-Test',
    headline: 'Du bist freigeschaltet 🎉',
    intro: ['Es ist so weit! Wir haben dich für den Test der Fit-Inn-App freigeschaltet. In wenigen Schritten bist du dabei:'].concat(steps),
    button: OPTIN_URL ? { label: 'Tester werden', href: OPTIN_URL, full: true } : null,
    secondary: STORE_URL ? { label: 'App bei Google Play öffnen', href: STORE_URL } : null,
    note: 'Wichtig: Nutze dieselbe Google-Adresse (' + email + '), mit der du dich angemeldet hast. Nach dem Beitritt kann es ein paar Minuten dauern, bis die App bei Google Play erscheint.',
    footer: 'security',
  });
  const r = await sendMailRaw({ to: email, subject: 'Du bist dabei: Test der Fit-Inn-App', text: mail.text, html: mail.html });
  return !!(r && r.ok);
}

// Freischalten: emails = Array von Adressen ODER null = alle noch offenen.
// Verschickt je Adresse die „Du bist dabei"-Mail und setzt status='approved'.
// Idempotent: bereits freigeschaltete werden übersprungen (keine Doppel-Mail).
// Liefert { approved:[…], failed:[…] }.
async function approve(emails) {
  if (!hasStore) return { approved: [], failed: [] };
  const [infoFlat] = await redisPipeline([['HGETALL', INFO_KEY]]);
  const info = hashToMap(infoFlat);

  let targets;
  if (emails == null) targets = Object.keys(info).filter(function (e) { return parseRec(info[e]).status !== 'approved'; });
  else targets = (Array.isArray(emails) ? emails : [emails]).map(function (e) { return String(e || '').trim().toLowerCase(); }).filter(function (e) { return info[e] != null; });

  const approved = [];
  const failed = [];
  for (const email of targets) {
    const rec = parseRec(info[email]);
    if (rec.status === 'approved') continue;
    try {
      const ok = await sendWelcome(email, rec);
      if (!ok) { failed.push(email); continue; }
      rec.status = 'approved';
      rec.approvedAt = new Date().toISOString();
      await redisPipeline([['HSET', INFO_KEY, email, JSON.stringify(rec)]]);
      approved.push(email);
    } catch (e) { failed.push(email); }
  }
  return { approved: approved, failed: failed };
}

module.exports = { recordSignup, listTesters, approve, sendWelcome, hasStore };
