'use strict';

/**
 * Android Digital Asset Links (App Links). Liefert die JSON erst, wenn
 * ANDROID_PACKAGE (z. B. de.fitinn.portal) und ANDROID_SHA256 (Fingerabdruck des
 * Signaturzertifikats, Doppelpunkt-getrennt) gesetzt sind – sonst 404.
 * Mehrere Fingerabdrücke (Upload- + Play-App-Signing-Key) mit Komma trennen.
 * Wird via vercel.json auf /.well-known/assetlinks.json umgeschrieben.
 */
module.exports = function handler(req, res) {
  const pkg = (process.env.ANDROID_PACKAGE || '').trim();
  const fps = String(process.env.ANDROID_SHA256 || '').split(',').map((s) => s.trim()).filter(Boolean);
  res.setHeader('Content-Type', 'application/json');
  if (!pkg || !fps.length) { res.statusCode = 404; return res.end('[]'); }
  const body = [{
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps },
  }];
  res.statusCode = 200;
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.end(JSON.stringify(body));
};
