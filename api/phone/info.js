'use strict';

/**
 * GET /api/phone/info?key=<PHONE_KEY>
 *
 * Eine Auskunft für den KI-Telefonassistenten: Ist gerade geöffnet, wie lange
 * noch, wie voll ist es, wo sind wir. Alles in EINEM Aufruf, damit der Assistent
 * nicht mehrfach nachfragen muss (jeder Aufruf kostet Gesprächszeit).
 *
 * Antwort enthält `text` – einen fertigen Satz zum Vorlesen – und daneben die
 * Einzelwerte, falls der Assistent gezielt etwas herausgreifen soll.
 *
 * Bewusst NICHT enthalten: alles Mitgliedsbezogene. Am Telefon ist der Anrufer
 * nicht verifiziert.
 */

const P = require('../../lib/phoneApi');

const STUDIO = {
  name: 'Fit-Inn Trier',
  address: 'Auf Hirtenberg 8, 54296 Trier',
  phone: '0651 308524',
  email: 'info@fit-inn-trier.de',
};

// Interne Endpunkte über die eigene Basis-URL abrufen (gleiche Region, schnell).
function baseFrom(req) {
  const h = (req && req.headers) || {};
  const host = h['x-forwarded-host'] || h.host;
  const proto = h['x-forwarded-proto'] || 'https';
  if (host) return proto + '://' + host;
  return String(process.env.PUBLIC_BASE_URL || 'https://mitglieder.fit-inn-trier.de').replace(/\/+$/, '');
}

// Nie länger warten als der Anrufer aushält: fonio bricht nach 5 s ab, wir
// geben lieber eine Teilauskunft als gar keine.
async function grab(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(function () { ac.abort(); }, ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(t); }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return P.json(res, 405, { ok: false, error: 'method_not_allowed' });
  const g = await P.guard(req, null, 120);
  if (!g.ok) return P.json(res, g.code, g.body);

  const base = baseFrom(req);
  // Parallel holen – zusammen bleibt das deutlich unter der 5-Sekunden-Grenze.
  const [hours, load] = await Promise.all([
    grab(base + '/api/hours', 2500),
    grab(base + '/api/auslastung', 2000),
  ]);

  const st = P.openStatus(hours || {}, Date.now());
  const lt = P.loadText(load);

  const parts = [st.text];
  if (lt && st.open) parts.push(lt);
  const text = parts.join(' ');

  return P.json(res, 200, {
    ok: true,
    text: text,
    open: st.open,
    closedReason: st.closedReason,
    todayHours: st.todayText,
    occupancyPercent: (load && typeof load.percent === 'number') ? load.percent : null,
    studio: STUDIO,
    // Wenn die Öffnungszeiten gerade nicht erreichbar waren, soll der Assistent
    // das wissen und lieber ans Team weiterleiten, statt zu raten.
    degraded: !hours,
  });
};
