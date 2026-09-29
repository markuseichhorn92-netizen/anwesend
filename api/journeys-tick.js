'use strict';

/**
 * Vercel Serverless Function · /api/journeys-tick
 * -----------------------------------------------------------------------------
 * Durchlauf der FINN Journeys (lib/journeys/tick): fällige WhatsApp-Schritte
 * senden (Ruhezeiten, Kappen, Einwilligung prüft der Sender), Mitglieder mit
 * bekannter Nummer täglich neu einstufen, Check-in-Historie nachziehen,
 * Einladung dosiert verschicken.
 *
 * Fortsetzbar: `fertig:false` heißt, der nächste Aufruf macht weiter. Der
 * Workflow .github/workflows/journeys.yml ruft alle 15 Minuten, bis `fertig`.
 * Ohne JOURNEYS=1 bzw. JOURNEYS_TRACK=1 passiert nichts (fertig:true, off:true).
 *
 * Schutz wie die übrigen Cron-Endpunkte: Secret als Authorization-Header,
 * fail-closed ohne Secret. Die Antwort enthält nur Zahlen.
 *
 * WhatsApp-Vorlagen (Workflow „FINN Journeys" → manuell starten → vorlagen):
 *   POST ?templates=submit  offene Vorlagen bei Twilio anlegen + bei Meta einreichen
 *   POST ?templates=sync    abgleichen: Vorlagen ohne SID zuordnen (nie anlegen) + Stand
 * Antwort: je Vorlage Schlüssel, Status, Metas Grund – keine Personendaten,
 * keine Zugangsdaten. „weiter:true" heißt: nochmal aufrufen (Zeit reichte nicht).
 * Unabhängig von JOURNEYS=1 – eingereicht wird, bevor gesendet wird.
 */

const { requireCronAuth } = require('../lib/cronAuth');
const Journeys = require('../lib/journeys');

async function templates(req, res, what) {
  const J = (o, code) => { res.statusCode = code || 200; res.end(JSON.stringify(o)); };
  if (req.method !== 'POST') return J({ ok: false, error: 'method_not_allowed' }, 405);
  if (what !== 'submit' && what !== 'sync') return J({ ok: false, error: 'bad_action' }, 400);
  const TC = require('../lib/journeys/twilioContent');
  const Config = require('../lib/journeys/config');
  if (!TC.configured()) return J({ ok: false, error: 'no_twilio', message: TC.NO_TWILIO, weiter: false }, 400);
  try {
    let r;
    if (what === 'submit') {
      r = await TC.submitMany({ budgetMs: 40000, who: 'workflow' });
      r = { ok: r.ok, eingereicht: r.submitted, weiter: r.remaining.length > 0, offen: r.remaining, fehler: r.message,
        ergebnis: r.results.map((x) => ({ key: x.key, ok: x.ok, status: x.status || undefined, fehler: x.ok ? undefined : (x.message || x.error) })) };
    } else {
      const s = await TC.sync({ budgetMs: 40000, who: 'workflow' });
      r = { ok: !!s.ok, verknuepft: (s.linked || []).length, fehlt: s.missing || [], textAbweichung: s.bodyDiff || [], freigegeben: s.approved || 0,
        geprueft: s.checked || 0, geaendert: s.changed || 0, fehler: s.linkError, weiter: false };
    }
    r.vorlagen = TC.summary((await Config.load(true)).templates);
    // Betrieb auf einen Blick (ohne Personenbezug): Modus, letzter Durchlauf.
    try { const last = await require('../lib/journeys/tick').lastRun(); r.betrieb = { modus: Config.mode(), modusSchalter: Config.modeState(), letzterDurchlauf: last ? { vorMin: Math.round((Date.now() - last.at) / 60000), quelle: last.src, gesendet: last.sent } : null }; } catch (e) {}
    return J(r);
  } catch (e) {
    console.error('[journeys-tick] templates', String(e && e.name));
    return J({ ok: false, error: 'templates_failed', weiter: false }, 502);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (!requireCronAuth(req, res)) return;
  let q = {}; try { q = Object.fromEntries(new URL(req.url, 'http://x').searchParams.entries()); } catch (e) {}
  if (q.templates) return templates(req, res, String(q.templates));
  try {
    const r = await Journeys.tick({ budgetMs: 45000, src: 'workflow' });
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: !!r.ok, fertig: !!r.fertig, off: !!r.off, locked: !!r.locked, due: r.due || 0, sent: r.sent || 0, evaluated: r.evaluated || 0, ms: r.ms || 0 }));
  } catch (e) {
    console.error('[journeys-tick]', String(e && e.name));
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'tick_failed' }));
  }
};
