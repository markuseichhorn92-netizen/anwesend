'use strict';

/**
 * Öffnungszeiten aus Magicline — geteilte Logik.
 * -----------------------------------------------------------------------------
 * Bisher stand der Abruf ausschliesslich in api/hours.js. Alles andere, was die
 * Zeiten brauchte (der Telefonassistent), holte sie sich mit einem HTTP-Aufruf
 * an die eigene Bereitstellung — also eine zweite Funktionsausführung samt
 * möglichem Kaltstart, mit knappem Zeitlimit. Wurde es überschritten, fiel die
 * Angabe stillschweigend weg und der Assistent stand ohne Öffnungszeiten da.
 *
 * Hier liegt derselbe Abruf als Funktion: gleiche Antwortform, gleicher Cache,
 * nur ohne den Umweg über das Netz.
 *
 * Wie überall im Bestand: wirft nie nach aussen. Geht etwas schief, kommt
 * `{ available: false }` zurück — der Aufrufer entscheidet, was er damit macht.
 */

const TENANT = process.env.ML_TENANT || 'fit-inn-trier';
const API_KEY =
  process.env.ML_API_KEY ||
  process.env.MLAPIKEY ||
  process.env.mlapikey ||
  process.env.ML_APIKEY ||
  process.env.MAGICLINE_API_KEY;
const URL = 'https://' + TENANT + '.open-api.magicline.com/v1/studios/information';
const TTL_MS = 30000;   // 30 s – Änderungen aus Magicline sollen schnell durchschlagen
const TIMEOUT_MS = 4000;

let cache = { data: null, ts: 0 };

/**
 * @param {object} [opts] { raw: true } liefert zusätzlich die Rohantwort (Diagnose)
 * @returns {Promise<object>} { available, studioName, openingHours, closingHours,
 *                              closingDate, openingDate, cached? } oder { available:false, … }
 */
async function fetchHours(opts) {
  opts = opts || {};
  if (!API_KEY) return { available: false, error: 'missing_api_key' };

  const now = Date.now();
  if (!opts.raw && cache.data && now - cache.ts < TTL_MS) {
    return Object.assign({}, cache.data, { cached: true });
  }

  const ac = new AbortController();
  const t = setTimeout(function () { try { ac.abort(); } catch (e) {} }, TIMEOUT_MS);
  let r = null;
  try {
    r = await fetch(URL, { headers: { 'x-api-key': API_KEY, Accept: 'application/json' }, signal: ac.signal });
  } catch (err) {
    clearTimeout(t);
    return { available: false, error: err && err.message ? err.message : 'fetch_failed' };
  }
  clearTimeout(t);

  if (!r.ok) {
    let body = '';
    try { body = await r.text(); } catch (e) { body = ''; }
    return {
      available: false,
      status: r.status,
      hint: (r.status === 401 || r.status === 403)
        ? 'Der API-Key hat vermutlich keine STUDIO_READ-Berechtigung. Im Magicline Developer Portal aktivieren.'
        : 'Magicline-Fehler beim Abruf der Studio-Informationen.',
      body: String(body).slice(0, 400),
    };
  }

  let data = null;
  try { data = await r.json(); } catch (e) { return { available: false, error: 'bad_json' }; }

  const out = {
    available: true,
    studioName: data.name || data.studioName || null,
    openingHours: data.openingHours || data.openingHourRanges || data.businessHours || null,
    closingHours: data.closingHours || null,   // abweichende Schliessungen (Feiertage etc.)
    closingDate: (data.closingDate !== undefined) ? data.closingDate : null,
    openingDate: (data.openingDate !== undefined) ? data.openingDate : null,
  };
  if (opts.raw) { out.raw = data; return out; }

  cache = { data: out, ts: now };
  return Object.assign({}, out, { cached: false });
}

module.exports = { fetchHours, TTL_MS };
