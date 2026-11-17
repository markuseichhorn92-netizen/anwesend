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
const U = require('../../lib/utilization');
const { fetchHours } = require('../../lib/studioHours');

const STUDIO = {
  name: 'Fit-Inn Trier',
  address: 'Auf Hirtenberg 8, 54296 Trier',
  phone: '0651 308524',
  email: 'info@fit-inn-trier.de',
};

// Interne Endpunkte über die eigene Basis-URL abrufen (gleiche Region, schnell).
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return P.json(res, 405, { ok: false, error: 'method_not_allowed' });
  const g = await P.guard(req, null, 120);
  if (!g.ok) return P.json(res, g.code, g.body);

  // Direkt aus den geteilten Bibliotheken statt ueber HTTP an die eigene
  // Bereitstellung: das war eine zweite Funktionsausfuehrung samt moeglichem
  // Kaltstart, und bei jedem ueberschrittenen Zeitlimit fiel die Angabe
  // stillschweigend weg. Beide Aufrufe scheitern sanft (null).
  const [hours, load] = await Promise.all([
    fetchHours().then(function (h) { return (h && h.available) ? h : null; }, function () { return null; }),
    U.fetchUtilization().then(function (u) { return u || null; }, function () { return null; }),
  ]);

  const st = P.openStatus(hours || {}, Date.now());
  const lt = P.loadText(load);
  const plan = P.weekPlan(hours || {});

  // „Wann habt ihr samstags auf?" ist am Telefon die haeufigste Rueckfrage.
  // Ohne ?tag= bleibt die Antwort wie bisher beim heutigen Tag.
  let tag = '';
  try { tag = String(new URL(req.url, 'http://x').searchParams.get('tag') || '').trim(); } catch (e) { /* egal */ }
  const gefragt = tag
    ? plan.filter(function (d) { return d.day === tag.toUpperCase() || d.tag.toLowerCase() === tag.toLowerCase(); })[0]
    : null;

  const parts = [];
  if (gefragt) {
    parts.push(gefragt.offen
      ? ('Am ' + gefragt.tag + ' haben wir von ' + gefragt.text + ' geöffnet.')
      : ('Am ' + gefragt.tag + ' haben wir geschlossen.'));
  } else {
    parts.push(st.text);
    if (lt && st.open) parts.push(lt);
  }
  const text = parts.join(' ');

  return P.json(res, 200, {
    ok: true,
    text: text,
    open: st.open,
    closedReason: st.closedReason,
    todayHours: st.todayText,
    // Die ganze Woche mitliefern: der Assistent kann dann nach Tagen antworten,
    // ohne fuer jede Rueckfrage neu anzurufen (jeder Aufruf kostet Gespraechszeit).
    weekHours: plan.map(function (d) { return { tag: d.tag, zeiten: d.text }; }),
    weekText: P.weekText(hours || {}),
    occupancyPercent: (load && typeof load.percent === 'number') ? load.percent : null,
    studio: STUDIO,
    // Wenn die Öffnungszeiten gerade nicht erreichbar waren, soll der Assistent
    // das wissen und lieber ans Team weiterleiten, statt zu raten.
    degraded: !hours,
  });
};
