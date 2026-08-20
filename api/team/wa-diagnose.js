'use strict';

/**
 * Team-Backend: warum kommt kein Anmelde-Code per WhatsApp an?
 *
 *   GET   -> wie ist der Versand eingerichtet + die letzten Versuche
 *   POST  { phone } -> einen Probe-Code an diese Nummer schicken und den
 *                      Fehler des Anbieters IM KLARTEXT zurueckgeben
 *
 * Der Grund stand bisher nur in den Vercel-Logs. Wer die nicht liest, sieht
 * beim Mitglied nur "kein Code" und raet - genau das hat hier Tage gekostet.
 *
 * Der Probe-Code wird NICHT als Anmeldung gespeichert: er ist eine Zufallszahl
 * ohne Gegenstueck, damit sich damit niemand irgendwo anmelden kann.
 * Nur fuer die Leitung (Admin), und begrenzt - sonst waere das ein bequemer
 * Weg, fremde Nummern mit Nachrichten zu belegen.
 */

const crypto = require('node:crypto');
const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const WA = require('../../lib/whatsapp');
const M = require('../../lib/members');
const LC = require('../../lib/loginCode');

function raus(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  const sess = await TA.requireTeam(req);
  if (!sess) return raus(res, 401, { ok: false, error: 'unauthorized' });
  // Ein Probeversand an eine frei gewaehlte Nummer ist ein Leitungsakt.
  if (!Cap.requireCap(sess, 'admin.manage', res)) return;

  if (req.method === 'GET') {
    const letzte = await LC.letzteMessungen(20);
    return raus(res, 200, { ok: true, einrichtung: WA.loginVorlageInfo(), letzte: letzte });
  }

  if (req.method !== 'POST') return raus(res, 405, { ok: false, error: 'method_not_allowed' });

  let body = {};
  try { body = await M.readBody(req); } catch (e) { body = {}; }
  const phone = String(body.phone || '').trim();
  if (!phone || WA.toWaNumber(phone).length < 8) {
    return raus(res, 200, { ok: false, message: 'Bitte eine vollstaendige Handynummer angeben.' });
  }

  if (M.hasStore && !(await M.rateLimit('wadiag:' + WA.toWaNumber(phone), 5, 3600))) {
    return raus(res, 200, { ok: false, message: 'Fuer diese Nummer wurden schon 5 Probe-Nachrichten geschickt. Bitte spaeter erneut.' });
  }

  const vorher = WA.loginVorlageInfo();
  if (!vorher.bereit) {
    return raus(res, 200, {
      ok: true, zugestellt: false, einrichtung: vorher,
      message: 'Es ist gar keine Vorlage fuer den Anmelde-Code eingerichtet. Deshalb bietet die App WhatsApp erst gar nicht an.',
    });
  }

  // Zufallszahl ohne gespeichertes Gegenstueck: sieht aus wie ein Code, ist keiner.
  const probe = String(crypto.randomInt(100000, 1000000));
  const t0 = Date.now();
  let r = null, geworfen = null;
  try { r = await WA.sendLoginTemplate(phone, probe); }
  catch (e) { geworfen = String((e && e.message) || 'Aufruf fehlgeschlagen').slice(0, 160); }
  const ms = Date.now() - t0;

  const ok = !!(r && r.ok);
  const grund = ok ? null : (geworfen ? { text: geworfen } : WA.fehlerInfo(r));
  return raus(res, 200, {
    ok: true,
    zugestellt: ok,
    ms: ms,
    einrichtung: WA.loginVorlageInfo(),
    fehler: grund,
    message: ok
      ? 'Der Probe-Code wurde von WhatsApp angenommen. Kommt trotzdem nichts an, liegt es an der Zustellung – nicht am Aufruf.'
      : 'WhatsApp hat den Versand abgelehnt. Der Grund steht unten.',
  });
};
