'use strict';

/**
 * Vercel Serverless Function · /api/nutri-usage-tick
 * -----------------------------------------------------------------------------
 * Rechnet aus, wie viele Menschen die Ernährungsprotokollierung tatsächlich
 * benutzen (lib/nutriUsage). Ergebnis sind AUSSCHLIESSLICH Zahlen – das Team
 * sieht sie in den Statistiken, der anonyme Überblick unter /api/ops.
 *
 * Warum ein eigener Lauf und nicht einfach beim Aufruf rechnen: Die Zahl
 * entsteht aus einem Durchlauf über den Schlüsselraum. Der ist zu langsam, um
 * ihn an eine Seite zu hängen, die jemand öffnet – und viel zu teuer, um ihn
 * bei jedem Öffnen zu wiederholen. Also einmal täglich, Ergebnis gespeichert.
 *
 * Der Lauf ist FORTSETZBAR: Reicht die Zeit nicht, antwortet der Endpunkt mit
 * `fertig:false` und macht beim nächsten Aufruf an derselben Stelle weiter.
 * Der Workflow ruft deshalb mehrfach auf, bis `fertig:true` kommt. Bis dahin
 * bleibt das zuletzt FERTIGE Ergebnis stehen – nie ein halber Durchgang.
 *
 * Schutz wie die übrigen Cron-Endpunkte: Secret als Authorization-Header,
 * fail-closed ohne Secret.
 */

const { requireCronAuth } = require('../lib/cronAuth');
const NU = require('../lib/nutriUsage');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (!requireCronAuth(req, res)) return;

  if (!NU.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, verfuegbar: false })); }

  try {
    const r = await NU.auswerten({ msBudget: 45000 });
    // Nur Zahlen ins Log – die Auswertung selbst enthält ohnehin keine Kennungen.
    try { console.log('[nutri-usage-tick]', JSON.stringify({ fertig: !!r.fertig, gesehen: r.gesehen || 0 })); } catch (e) {}
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, verfuegbar: true, fertig: !!r.fertig, gesehen: r.gesehen || 0, ergebnis: r.ergebnis || null }));
  } catch (e) {
    console.error('[nutri-usage-tick]', String(e && e.message));
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: 'tick_failed' }));
  }
};
