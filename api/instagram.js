'use strict';

/**
 * Vercel Serverless Function · GET /api/instagram
 * -----------------------------------------------
 * Liefert die neuesten Instagram-Beiträge fürs Mitgliederportal
 * (Bild + Text + Link zum echten Post).
 *
 * Zwei Wege – der erste, der konfiguriert ist, wird genutzt:
 *
 *  A) Feed-Dienst (empfohlen, einfachstes Setup):
 *     IG_FEED_URL  – die JSON-Feed-Adresse von behold.so (o. ä.),
 *                    z. B. https://feeds.behold.so/XXXXXXXX
 *     Der Dienst regelt das Meta-Token samt Auto-Refresh selbst.
 *
 *  B) Instagram Graph API direkt:
 *     IG_TOKEN     – langlebiges Zugriffs-Token
 *     IG_USER_ID   – Instagram-Business/Creator-Account-ID
 *     IG_GRAPH_HOST– optional "graph.facebook.com" (Standard) / "graph.instagram.com"
 *
 * Optional für beide Wege:
 *     IG_HANDLE    – @-Name ohne @ (z. B. "fit_inn_trier") für den Profil-Link
 *
 * Ohne Konfiguration -> { available:false }; die Instagram-Sektion blendet sich
 * dann einfach aus (kein Fehler).
 */

const FEED_URL = process.env.IG_FEED_URL || process.env.BEHOLD_FEED_URL || '';
const TOKEN = process.env.IG_TOKEN || process.env.INSTAGRAM_TOKEN || '';
const USER_ID = process.env.IG_USER_ID || process.env.INSTAGRAM_USER_ID || '';
const HANDLE = (process.env.IG_HANDLE || process.env.INSTAGRAM_HANDLE || '').replace(/^@/, '');
const HOST = process.env.IG_GRAPH_HOST || 'graph.facebook.com';
const VERSION = process.env.IG_GRAPH_VERSION || 'v21.0';
const TTL_MS = 5 * 60 * 1000; // 5 Min Cache

let cache = { data: null, ts: 0 };

function profileUrl(handle) { return handle ? ('https://www.instagram.com/' + handle + '/') : null; }

// Neueste zuerst; Beiträge ohne Zeitstempel ans Ende
function byNewest(a, b) { return (Date.parse(b && b.timestamp) || 0) - (Date.parse(a && a.timestamp) || 0); }
const MAX_POSTS = 60; // faktisch „alle" – deckelt nur die Nutzlast

// ── Behold-/Feed-JSON auf unser Post-Format bringen ──
function mapFeedPost(p) {
  const sizes = p.sizes || {};
  const med =
    (sizes.medium && sizes.medium.mediaUrl) ||
    (sizes.small && sizes.small.mediaUrl) || null;
  const big =
    (sizes.large && sizes.large.mediaUrl) ||
    (sizes.full && sizes.full.mediaUrl) || null;
  const base = med || big || p.thumbnailUrl || p.thumbnail_url || p.mediaUrl || p.media_url || null;
  const type = p.mediaType || p.media_type || '';
  const isVideo = (type === 'VIDEO');
  const num = function (v) { return (typeof v === 'number' && isFinite(v)) ? v : null; };
  return {
    id: p.id || p.permalink || String(Math.random()),
    image: med || base,          // mittlere Größe für die Kacheln
    imageLg: big || med || base, // große Größe für die Detailansicht
    caption: String(p.prunedCaption || p.caption || '').replace(/^\s*📋\s*Caption:\s*/i, '').slice(0, 2200),
    permalink: p.permalink || p.link || '',
    timestamp: p.timestamp || p.date || null,
    type: type,
    video: isVideo,
    videoUrl: isVideo ? (p.mediaUrl || p.media_url || null) : null,
    likes: num(p.likeCount != null ? p.likeCount : p.like_count),
    comments: num(p.commentsCount != null ? p.commentsCount : p.comments_count),
  };
}

async function fetchFeed() {
  const r = await fetch(FEED_URL, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('feed_status_' + r.status);
  const json = await r.json();
  const list = Array.isArray(json) ? json : (Array.isArray(json.posts) ? json.posts : []);
  const handle = (json && (json.username || (json.profile && (json.profile.username || json.profile.handle)))) || HANDLE || null;
  const all = list.map(mapFeedPost).filter(function (p) { return p.image && p.permalink; }).sort(byNewest);
  const posts = all.slice(0, MAX_POSTS);
  return { available: posts.length > 0, handle: handle, profile: profileUrl(handle), posts: posts, total: all.length };
}

async function fetchGraph() {
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  const url = 'https://' + HOST + '/' + VERSION + '/' + encodeURIComponent(USER_ID) +
    '/media?fields=' + fields + '&limit=' + MAX_POSTS + '&access_token=' + encodeURIComponent(TOKEN);
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await r.text().catch(function () { return ''; });
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  if (!r.ok || !json || json.error) {
    const msg = (json && json.error && json.error.message) ? json.error.message : text.slice(0, 200);
    throw new Error(msg || ('graph_status_' + r.status));
  }
  const list = Array.isArray(json.data) ? json.data : [];
  const posts = list.map(function (m) {
    const img = m.thumbnail_url || m.media_url || null;
    const isVideo = m.media_type === 'VIDEO';
    return {
      id: m.id,
      image: img,
      imageLg: m.media_url || img,
      caption: String(m.caption || '').slice(0, 2200),
      permalink: m.permalink || profileUrl(HANDLE) || '',
      timestamp: m.timestamp || null,
      type: m.media_type || '',
      video: isVideo,
      videoUrl: isVideo ? (m.media_url || null) : null,
      likes: null,
      comments: null,
    };
  }).filter(function (p) { return p.image; }).sort(byNewest).slice(0, MAX_POSTS);
  return { available: posts.length > 0, handle: HANDLE || null, profile: profileUrl(HANDLE), posts: posts, total: posts.length };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  if (!FEED_URL && (!TOKEN || !USER_ID)) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ available: false, error: 'missing_config', handle: HANDLE || null, profile: profileUrl(HANDLE) }));
  }

  const debug = /(?:\?|&)debug=1/.test(req.url || '');
  const now = Date.now();
  if (!debug && cache.data && now - cache.ts < TTL_MS) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ...cache.data, cached: true }));
  }

  try {
    const out = FEED_URL ? await fetchFeed() : await fetchGraph();
    if (!debug) cache = { data: out, ts: now };
    res.statusCode = 200;
    return res.end(JSON.stringify(out));
  } catch (err) {
    res.statusCode = 200; // sanft scheitern -> Sektion blendet sich aus
    return res.end(JSON.stringify({ available: false, error: String(err && err.message), handle: HANDLE || null, profile: profileUrl(HANDLE) }));
  }
};
