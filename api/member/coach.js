'use strict';

/**
 * FINN – der KI-Coach im Mitgliederbereich.   (Authorization: Bearer <token>)
 *
 *   GET                 -> { ok, message, ai }   Tagesimpuls für die Übersicht
 *   POST { question, history:[{role,text}] }
 *                       -> { ok, answer }         Chat-Antwort von FINN
 *
 * Nutzt lib/ai.js (Anthropic Claude) + die Hilfe-Artikel als Wissensbasis.
 * Ohne ANTHROPIC_API_KEY fällt der Tagesimpuls auf einen rotierenden Standardtipp
 * zurück; der Chat meldet dann ehrlich, dass FINN gerade nicht verfügbar ist.
 */

const M = require('../../lib/members');
const AI = require('../../lib/ai');
const HELP = require('../../lib/help');
const MLAccount = require('../../lib/mlAccount');

// ── Live-Daten fürs Chat-Gespräch (nur die des angemeldeten Mitglieds) ──
// Vertrag, nächste Termine, Besuche, Beitragskonto – parallel und fehlertolerant
// geladen. BEWUSST ohne Bank-/Adressdaten. Liefert einen kompakten Textblock.
function fmtDT(iso) {
  try {
    const d = new Date(iso); if (isNaN(d.getTime())) return String(iso || '');
    const date = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' }).format(d);
    const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(d);
    return date + ', ' + time + ' Uhr';
  } catch (e) { return String(iso || ''); }
}
function euro(n) { return (typeof n === 'number') ? (n.toFixed(2).replace('.', ',') + ' €') : String(n); }

async function contractLine(id) {
  const ct = await M.getContract(id);
  if (!ct) return null;
  const status = ct.active === false ? (ct.reversed ? 'widerrufen' : 'beendet') : (ct.cancelled ? 'gekündigt' : 'aktiv');
  let s = 'Vertrag: Tarif ' + (ct.rateName || '—') + ', Status ' + status;
  if (ct.startDate) s += ', Beginn ' + ct.startDate;
  if (ct.cancelled) s += ', gekündigt zum ' + (ct.cancellationDate || ct.endDate || '—');
  else if (ct.endDate) s += ', Laufzeit bis ' + ct.endDate;
  if (ct.cancellationPeriod) s += ', Kündigungsfrist ' + ct.cancellationPeriod;
  if (!ct.cancelled && ct.nextCancellationDate) s += ', nächstmögliche Kündigung zum ' + ct.nextCancellationDate;
  if (ct.withdrawalEligible) s += ', 14-Tage-Widerruf noch möglich bis ' + (ct.withdrawalDeadline || '—');
  return { line: s, rateName: ct.rateName || null };
}
async function appointmentsLine(id) {
  const r = await M.ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(id));
  const list = Array.isArray(r.json) ? r.json : [];
  const now = Date.now();
  const fut = list
    .filter((a) => a && a.startDateTime && new Date(a.startDateTime).getTime() > now
      && a.cancelled !== true && !/CANCEL/i.test(String(a.status || a.bookingStatus || '')))
    .sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime))
    .slice(0, 3)
    .map((a) => (a.title || a.name || 'Termin') + ' am ' + fmtDT(a.startDateTime));
  return 'Nächste Termine: ' + (fut.length ? fut.join('; ') : 'keine gebucht');
}
async function visitsLine(id) {
  const list = await M.recentCheckins(id, { windows: 1 });   // letzte ~350 Tage
  if (!Array.isArray(list) || !list.length) return 'Besuche: noch keine Check-ins im letzten Jahr';
  const newest = list[0];
  const last = newest && newest.in ? fmtDT(newest.in) : null;
  const cutoff = Date.now() - 30 * 86400000;
  const n30 = list.filter((c) => c && c.in && new Date(c.in).getTime() >= cutoff).length;
  return 'Besuche: ' + n30 + ' in den letzten 30 Tagen' + (last ? (', letzter Besuch ' + last) : '');
}
async function accountLine(id) {
  const acc = await MLAccount.accountSummary(id);
  if (!acc || !acc.available) return null;
  if ((acc.openTotal || 0) > 0.0001) {
    return 'Beitragskonto: offener Betrag ' + euro(acc.openTotal)
      + (acc.openCount ? (' (' + acc.openCount + ' Posten)') : '')
      + (acc.dunningLevel ? (', Mahnstufe ' + acc.dunningLevel) : '')
      + (acc.inDebtCollection ? ', Vorgang beim Inkasso' : '');
  }
  return 'Beitragskonto: ausgeglichen';
}
// Alle Quellen parallel; Ausfälle einzelner Quellen werden still übersprungen.
async function memberDetails(id) {
  const settle = (p) => p.then((v) => v).catch(() => null);
  const [ct, ap, vi, ac] = await Promise.all([
    settle(contractLine(id)), settle(appointmentsLine(id)), settle(visitsLine(id)), settle(accountLine(id)),
  ]);
  const lines = [];
  if (ct && ct.line) lines.push(ct.line);
  if (ap) lines.push(ap);
  if (vi) lines.push(vi);
  if (ac) lines.push(ac);
  return { text: lines.join('\n'), rateName: (ct && ct.rateName) || null };
}

const STATIC_TIPS = [
  'Trink vor dem Training ein großes Glas Wasser – das steigert deine Leistung spürbar. 💧',
  'Schon 20 Minuten zählen. Komm vorbei, dein Körper dankt es dir!',
  'Konstanz schlägt Intensität: lieber 3× kurz als 1× lang. 💪',
  'Wärm dich 5 Minuten auf – das beugt Verletzungen vor und macht jede Übung effektiver.',
  'Erholung ist Teil des Fortschritts: gönn dir guten Schlaf und genug Eiweiß.',
  'Setz dir für heute ein kleines, erreichbares Ziel – und feiere es danach. 🎯',
  'Ein fester Trainingspartner hält dich am Ball. Wen könntest du heute mitnehmen?',
];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  const m = await M.getMember(sess.id);
  if (!m) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }

  // ── Tagesimpuls für die Übersicht ──
  if (req.method === 'GET') {
    let ct = null; try { ct = await M.getContract(sess.id); } catch (e) {}
    const statsLine = 'Tarif ' + ((ct && ct.rateName) || 'aktiv') + (ct && ct.active === false ? ' (ehemalig)' : ' (aktiv)');
    let goal = ''; try { goal = new URL(req.url, 'http://x').searchParams.get('goal') || ''; } catch (e) {}
    if (AI.hasAI && (await M.rateLimit('coach-tip:' + sess.id, 30, 3600))) {
      const r = await AI.coachTip(statsLine, goal);
      if (r.ok) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, message: r.answer, ai: true })); }
    }
    const idx = (new Date().getDate()) % STATIC_TIPS.length;   // tagesstabil, kein Zufall nötig
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, message: STATIC_TIPS[idx], ai: false }));
  }

  // ── Chat mit FINN ──
  if (req.method === 'POST') {
    if (!(await M.rateLimit('coach-chat:' + sess.id, 40, 3600))) {
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'rate_limited', message: 'Kurz durchatmen – das waren viele Fragen auf einmal. Versuch es gleich nochmal.' }));
    }
    const body = await M.readBody(req);
    const question = String(body.question || '').trim();
    if (question.length < 2) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'empty' })); }
    if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai', message: 'FINN ist gerade nicht verfügbar. Magst du es direkt unserem Team schreiben?' })); }
    // Live-Daten (Vertrag, Termine, Besuche, Beitragskonto) für konkrete Antworten.
    let det = { text: '', rateName: null };
    try { det = await memberDetails(sess.id); } catch (e) {}
    const member = { firstName: m.firstName, lastName: m.lastName, customerNumber: m.customerNumber, rateName: det.rateName, details: det.text };
    const r = await AI.coachReply(member, Array.isArray(body.history) ? body.history : [], question, HELP);
    res.statusCode = 200;
    if (r.ok) { try { require('../../lib/handled').record('ai', sess.id, 'chat'); } catch (e) {} return res.end(JSON.stringify({ ok: true, answer: r.answer })); }
    return res.end(JSON.stringify({ ok: false, error: r.error || 'ai_failed', message: 'Da komme ich gerade nicht weiter. Magst du es unserem Team schreiben?' }));
  }

  res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
};
