'use strict';

/**
 * Vercel Serverless Function · GET /api/instagram
 * -----------------------------------------------
 * Liest die neuesten Instagram-Beiträge über die Instagram Graph API und gibt
 * sie fürs Mitgliederportal zurück (Bild + Text + Link zum echten Post).
 *
 * Benötigte Vercel-Env-Variablen:
 *   IG_TOKEN     – langlebiges Zugriffs-Token (Long-Lived Access Token)
 *   IG_USER_ID   – die Instagram-Business/Creator-Account-ID (numerisch)
 *   IG_HANDLE    – (optional) der @-Name ohne @, z. B. "fitinntrier" (für den Profil-Link)
 *   IG_GRAPH_HOST– (optional) "graph.facebook.com" (Standard) oder "graph.instagram.com"
 *
 * Ohne Token/ID liefert der Endpunkt { available:false } – das Widget blendet
 * die Instagram-Sektion dann einfach aus (kein Fehler).
 */

const TOKEN = process.env.IG_TOKEN || process.env.INSTAGRAM_TOKEN || '';
const USER_ID = process.env.IG_USER_ID || process.env.INSTAGRAM_USER_ID || '';
const HANDLE = (process.env.IG_HANDLE || process.env.INSTAGRAM_HANDLE || '').replace(/^@/, '');
const HOST = process.env.IG_GRAPH_HOST || 'graph.facebook.com';
const VERSION = process.env.IG_GRAPH_VERSION || 'v21.0';
const TTL_MS = 5 * 60 * 1000; // 5 Min Cache

let cache = { data: null, ts: 0 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const profile = HANDLE ? ('https://www.instagram.com/' + HANDLE + '/') : null;

  if (!TOKEN || !USER_ID) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ available: false, error: 'missing_config', handle: HANDLE || null, profile: profile }));
  }

  const debug = /(?:\?|&)debug=1/.test(req.url || '');
  const now = Date.now();
  if (!debug && cache.data && now - cache.ts < TTL_MS) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ...cache.data, cached: true }));
  }

  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  const url = 'https://' + HOST + '/' + VERSION + '/' + encodeURIComponent(USER_ID) +
    '/media?fields=' + fields + '&limit=12&access_token=' + encodeURIComponent(TOKEN);

  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await r.text().catch(() => '');
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    if (!r.ok || !json || json.error) {
      res.statusCode = 200; // sanft scheitern
      return res.end(JSON.stringify({
        available: false, status: r.status, handle: HANDLE || null, profile: profile,
        hint: (r.status === 400 || r.status === 401 || r.status === 403)
          ? 'Token abgelaufen oder ohne Berechtigung (instagram_basic). Neues Long-Lived-Token erzeugen.'
          : 'Instagram-Abruf fehlgeschlagen.',
        error: (json && json.error && json.error.message) ? json.error.message : text.slice(0, 200),
      }));
    }
    const list = Array.isArray(json.data) ? json.data : [];
    const posts = list.map(function (m) {
      const isVideo = m.media_type === 'VIDEO';
      const image = m.thumbnail_url || m.media_url || null; // Video -> Vorschaubild
      return {
        id: m.id,
        image: image,
        caption: (m.caption || '').slice(0, 220),
        permalink: m.permalink || (profile || ''),
        timestamp: m.timestamp || null,
        video: isVideo,
      };
    }).filter(function (p) { return p.image; });

    const out = { available: true, handle: HANDLE || null, profile: profile, posts: posts.slice(0, 12) };
    if (!debug) cache = { data: out, ts: now };
    res.statusCode = 200;
    return res.end(JSON.stringify(out));
  } catch (err) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ available: false, error: String(err && err.message), handle: HANDLE || null, profile: profile }));
  }
};
