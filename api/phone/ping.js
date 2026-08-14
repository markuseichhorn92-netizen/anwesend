'use strict';

/**
 * GET|POST /api/phone/ping
 *
 * Einrichtungshilfe. Sagt, OB ein Schlüssel ankommt, WO er lag und ob er passt –
 * ohne den Schlüssel selbst zurückzugeben. Damit lässt sich die fonio-Konfiguration
 * in Sekunden prüfen, statt sie über echte Anrufe zu erraten.
 *
 * Bewusst ohne Schlüsselzwang: Der Endpunkt verrät nichts, was ein 401 der anderen
 * Endpunkte nicht ohnehin verrät (dort trifft man mit falschem Schlüssel genauso auf
 * eine Absage). Er gibt weder Daten noch Geheimnisse preis und ist eng ratenbegrenzt.
 *
 * Nach der Einrichtung kann er stehen bleiben – oder du löschst die Datei.
 */

const P = require('../../lib/phoneApi');
const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  // Eigene, enge Ratenbegrenzung – der Endpunkt prüft absichtlich keinen Schlüssel.
  const okRate = await M.rateLimit('phoneping:' + P.ipOf(req), 30, 300);
  if (!okRate) return P.json(res, 429, { ok: false, error: 'rate_limited' });

  const body = (req.method === 'POST') ? await P.readBody(req) : null;
  const g = await P.guard(req, body, 200);

  if (g.ok) {
    return P.json(res, 200, {
      ok: true,
      text: 'Verbindung steht. Der Schlüssel passt.',
      hinweis: 'Diese Aktion kannst du jetzt in fonio genauso für info, slots, book und callback anlegen.',
      method: req.method,
    });
  }

  // g.body trägt bereits hint + received aus lib/phoneApi.js
  return P.json(res, g.code, Object.assign({}, g.body, {
    method: req.method,
    naechsterSchritt: g.code === 503
      ? 'PHONE_KEY in Vercel setzen (Production) und neu deployen.'
      : 'In fonio den Schlüssel hinterlegen – am einfachsten als Header: {"Authorization": "Bearer DEIN_SCHLUESSEL"}. Das funktioniert für GET und POST gleichermaßen.',
  }));
};
