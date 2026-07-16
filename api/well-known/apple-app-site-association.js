'use strict';

/**
 * Apple App Site Association (Universal Links / Associated Domains).
 * Liefert die JSON erst, wenn APPLE_APP_ID gesetzt ist (Format: TEAMID.BUNDLEID,
 * z. B. ABCDE12345.de.fitinn.portal). Vorher 404 – damit im öffentlichen Repo
 * keine IDs hartkodiert sind. Wird via vercel.json auf
 *   /.well-known/apple-app-site-association
 * umgeschrieben und MUSS ohne Dateiendung als application/json ausgeliefert werden.
 */
module.exports = function handler(req, res) {
  const appId = (process.env.APPLE_APP_ID || '').trim();
  if (!appId) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end('{}'); }
  const body = {
    // Der Mitgliederbereich liegt jetzt auf „/" (früher „/mitglieder"). Beide öffnen die App.
    applinks: { apps: [], details: [{ appID: appId, paths: ['/', '/?*', '/mitglieder', '/mitglieder/*'] }] },
    webcredentials: { apps: [appId] },
  };
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.end(JSON.stringify(body));
};
