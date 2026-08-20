'use strict';

/**
 * WhatsApp – Senden + Webhook-Helfer für ZWEI Anbieter:
 *   - Twilio (BSP): einfache Einrichtung, Sandbox zum Testen.
 *       Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
 *            (z. B. "whatsapp:+14155238886" – Sandbox – oder die echte Sendernummer).
 *            optional TWILIO_WEBHOOK_URL (exakte Webhook-URL für die Signaturprüfung).
 *   - Meta Cloud API (direkt):
 *       Env: WA_TOKEN, WA_PHONE_NUMBER_ID, WA_APP_SECRET, WA_VERIFY_TOKEN, WA_GRAPH_VERSION.
 *
 * Senden geht über Twilio, sobald dessen Variablen gesetzt sind, sonst über Meta.
 * Nur `fetch`, keine Dependency. „Schläft" (hasWhatsApp=false), bis ein Anbieter konfiguriert ist.
 */

const crypto = require('node:crypto');

// ── Meta ──
const TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
const VER = process.env.WA_GRAPH_VERSION || 'v21.0';
const APP_SECRET = process.env.WA_APP_SECRET || '';
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || '';
const hasMeta = !!(TOKEN && PHONE_ID);

// ── Twilio ──
const TW_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TW_FROM_RAW = process.env.TWILIO_WHATSAPP_FROM || '';
const hasTwilio = !!(TW_SID && TW_TOKEN && TW_FROM_RAW);

const hasWhatsApp = hasTwilio || hasMeta;

// Login-Code-Vorlage (Authentifizierung): Twilio Content-SID ODER Meta-Template-Name.
// Pflicht, weil außerhalb des 24h-Fensters nur genehmigte Vorlagen zustellbar sind.
const TW_LOGIN_SID = process.env.TWILIO_LOGIN_CONTENT_SID || '';
const WA_LOGIN_TPL = process.env.WA_LOGIN_TEMPLATE || '';
const WA_LOGIN_LANG = process.env.WA_LOGIN_TEMPLATE_LANG || 'de';
const hasWaLogin = !!((hasTwilio && TW_LOGIN_SID) || (hasMeta && WA_LOGIN_TPL));

// Bei Meta hängt die Form des Aufrufs an der ART der Vorlage:
//   Vorlage "Utility"          -> nur der Textbaustein, Code EINMAL
//   Vorlage "Authentifizierung"-> zusätzlich der Einmalpasswort-Knopf, Code ZWEIMAL
// Seit dem 2. Oktober 2023 lässt Meta Authentifizierungs-Vorlagen nur noch MIT
// diesem Knopf zu. Fehlt er im Aufruf, lehnt Meta mit (#132000) ab. Da der Login
// danach still auf E-Mail ausweicht, kommt per WhatsApp nie etwas an, ohne dass
// irgendwo ein Fehler sichtbar würde – genau das war der Fehler.
// Deshalb: beide Formen kennen, die passende einmal ermitteln und merken.
const WA_LOGIN_FORCE = (function () {
  const v = String(process.env.WA_LOGIN_TEMPLATE_AUTH || '').trim();
  return v === '1' ? 'auth' : (v === '0' ? 'body' : null);
})();
let metaLoginShape = WA_LOGIN_FORCE;   // 'auth' | 'body' | null (noch nicht bekannt)

// Freitext-Vorlage (business-initiiert außerhalb des 24h-Fensters): genehmigte Vorlage
// mit EINER Body-Variable {{1}} = der frei getippte Text. Twilio Content-SID ODER Meta-
// Template-Name. Ohne Konfiguration „schläft" der WhatsApp-Weg (hasWaText=false).
const TW_TEXT_SID = process.env.TWILIO_TEXT_CONTENT_SID || '';
const WA_TEXT_TPL = process.env.WA_TEXT_TEMPLATE || '';
const hasWaText = !!((hasTwilio && TW_TEXT_SID) || (hasMeta && WA_TEXT_TPL));

// Anklickbare Auswahl (Quick-Reply-Buttons) über WhatsApp. Meta kann interaktive
// Nachrichten IM 24h-Fenster OHNE Vorlage senden; Twilio braucht dafür eine
// genehmigte Quick-Reply-Content-Vorlage (Content-SID, {{1}}=Text, {{2..4}}=Button-
// Titel). Ohne Vorlage fällt der Aufrufer automatisch auf nummerierten Text zurück.
const TW_QUICK_SID = process.env.TWILIO_QUICK_REPLY_CONTENT_SID || '';
const hasWaButtons = !!(hasMeta || (hasTwilio && TW_QUICK_SID));

// Status-Callback (Twilio meldet gesendet/zugestellt/gelesen an diese URL zurück).
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://mitglieder.fit-inn-trier.de').replace(/\/+$/, '');
const TW_STATUS_CB = process.env.TWILIO_STATUS_CALLBACK || (PUBLIC_BASE + '/api/whatsapp-twilio');

// In E.164 ohne '+' bringen: nur Ziffern; deutsche Eingaben (0049…, 0151…) -> 49…
function toWaNumber(num) {
  let d = String(num || '').replace(/[^\d]/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);
  if (d.indexOf('0') === 0) d = '49' + d.slice(1);
  return d;
}

// ── Zustell-Robustheit: Timeout + Retry bei transienten Fehlern ──
// Login-Codes müssen zuverlässig raus. POST mit Timeout (WA_TIMEOUT_MS) und
// automatischem Retry bei Netz/Timeout/429/5xx. Echte 4xx (falsche Nummer,
// Vorlage nicht genehmigt) werden NICHT wiederholt. Liefert { ok, status, text }.
const WA_TIMEOUT_MS = Number(process.env.WA_TIMEOUT_MS || 8000);
const WA_RETRIES = Math.max(0, Number(process.env.WA_RETRIES || 2));
const waSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waTransient(status) { return status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599); }
async function waPost(url, headers, body) {
  let last = { ok: false, status: 0, text: '', error: 'unknown' };
  for (let a = 0; a <= WA_RETRIES; a++) {
    if (a > 0) await waSleep(250 * a * a + 250);
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, WA_TIMEOUT_MS);
    try {
      const r = await fetch(url, { method: 'POST', headers: headers, body: body, signal: ctrl.signal });
      const text = await r.text().catch(() => '');
      if (r.ok) return { ok: true, status: r.status, text: text, attempts: a + 1 };
      last = { ok: false, status: r.status, text: text, attempts: a + 1 };
      if (!waTransient(r.status)) return last;
    } catch (e) {
      last = { ok: false, status: 0, text: '', error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || 'fetch_error'), attempts: a + 1 };
    } finally { clearTimeout(timer); }
  }
  return last;
}

// ───────────────────────── Meta senden ─────────────────────────
async function metaSend(payload) {
  const res = await waPost('https://graph.facebook.com/' + VER + '/' + PHONE_ID + '/messages',
    { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    JSON.stringify(Object.assign({ messaging_product: 'whatsapp' }, payload)));
  if (!res.ok && res.error) return { ok: false, error: res.error };
  let id = null; try { const j = JSON.parse(res.text || ''); id = (j && j.messages && j.messages[0] && j.messages[0].id) || null; } catch (e) {}
  return { ok: res.ok, status: res.status, body: (res.text || '').slice(0, 300), id: id };
}
async function send(payload) {
  if (!hasMeta) return { ok: false, error: 'no_meta' };
  return metaSend(payload);
}

// ───────────────────────── Twilio senden ─────────────────────────
function twFrom() {
  const f = String(TW_FROM_RAW).trim();
  if (f.indexOf('whatsapp:') === 0) return f;
  return 'whatsapp:+' + toWaNumber(f);
}
function twTo(num) { return 'whatsapp:+' + toWaNumber(num); }
async function twilioSendText(toNum, text) {
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(TW_SID) + '/Messages.json';
  const body = new URLSearchParams({ From: twFrom(), To: twTo(toNum), Body: String(text || '').slice(0, 1600), StatusCallback: TW_STATUS_CB }).toString();
  const auth = Buffer.from(TW_SID + ':' + TW_TOKEN).toString('base64');
  const res = await waPost(url, { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  if (!res.ok && res.error) return { ok: false, error: res.error };
  let id = null; try { const j = JSON.parse(res.text || ''); id = (j && j.sid) || null; } catch (e) {}
  return { ok: res.ok, status: res.status, body: (res.text || '').slice(0, 300), id: id };
}

// Freitext (innerhalb des 24-Stunden-Servicefensters). Anbieter-bewusst.
async function sendText(toNum, text) {
  if (hasTwilio) return twilioSendText(toNum, text);
  if (hasMeta) return metaSend({ to: toWaNumber(toNum), type: 'text', text: { preview_url: false, body: String(text || '').slice(0, 4096) } });
  return { ok: false, error: 'no_whatsapp' };
}

// Twilio Content-Vorlage senden (für genehmigte Templates, z. B. Login-Code).
async function twilioSendTemplate(toNum, contentSid, vars) {
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(TW_SID) + '/Messages.json';
  const params = { From: twFrom(), To: twTo(toNum), ContentSid: contentSid, StatusCallback: TW_STATUS_CB };
  if (vars) params.ContentVariables = JSON.stringify(vars);
  const auth = Buffer.from(TW_SID + ':' + TW_TOKEN).toString('base64');
  const res = await waPost(url, { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, new URLSearchParams(params).toString());
  if (!res.ok && res.error) return { ok: false, error: res.error };
  let id = null; try { const j = JSON.parse(res.text || ''); id = (j && j.sid) || null; } catch (e) {}
  return { ok: res.ok, status: res.status, body: (res.text || '').slice(0, 300), id: id };
}

// Login-Code per genehmigter Authentifizierungs-Vorlage zustellen. Anbieter-bewusst.
// Variable {{1}} = der 6-stellige Code.
async function sendLoginTemplate(toNum, code) {
  if (hasTwilio && TW_LOGIN_SID) return twilioSendTemplate(toNum, TW_LOGIN_SID, { 1: String(code) });
  if (!(hasMeta && WA_LOGIN_TPL)) return { ok: false, error: 'no_wa_login' };

  const zuerst = metaLoginShape || 'body';
  const r = await metaLoginSend(toNum, code, zuerst);
  if (r && r.ok) { metaLoginShape = zuerst; return r; }

  // Passt die Form nicht zur Vorlage, sagt Meta das mit einem eigenen Fehler.
  // Dann einmal die andere Form versuchen, statt still auf E-Mail auszuweichen.
  if (!WA_LOGIN_FORCE && istFormFehler(r)) {
    const andere = zuerst === 'auth' ? 'body' : 'auth';
    const r2 = await metaLoginSend(toNum, code, andere);
    if (r2 && r2.ok) { metaLoginShape = andere; return r2; }
    return r2 || r;
  }
  return r;
}

// Bausteine des Login-Aufrufs. Bei der Authentifizierungs-Form steht der Code
// zweimal drin: einmal im Text, einmal im Knopf zum Kopieren.
function loginComponents(code, shape) {
  const body = { type: 'body', parameters: [{ type: 'text', text: String(code) }] };
  if (shape !== 'auth') return [body];
  return [body, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(code) }] }];
}

function metaLoginSend(toNum, code, shape) {
  return metaSend({
    to: toWaNumber(toNum),
    type: 'template',
    template: { name: WA_LOGIN_TPL, language: { code: WA_LOGIN_LANG }, components: loginComponents(code, shape) },
  });
}

// Fehlercode des Anbieters aus der Antwort holen (0, wenn keiner drinsteht).
function fehlerCode(r) {
  if (!r || !r.body) return 0;
  try { const j = JSON.parse(r.body); return Number((j && j.error && j.error.code) || 0) || 0; } catch (e) { return 0; }
}
// 132000 = Anzahl der Parameter passt nicht, 131008 = Pflichtparameter fehlt.
// Beides heißt: die Form des Aufrufs passt nicht zur Art der Vorlage.
function istFormFehler(r) { const c = fehlerCode(r); return c === 132000 || c === 131008; }

// Anbieter-Fehler so aufbereiten, dass er in ein Log darf: Code und Klartext,
// aber ohne Rufnummer, ohne Adresse und ohne den Anmelde-Code selbst. Meta
// schreibt in `error_data.details` durchaus die Zielnummer hinein.
function anonym(s) {
  return String(s || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<adresse>')
    .replace(/\+?\d[\d\s\-().]{5,}\d/g, '<nummer>')
    .replace(/\d{4,}/g, '<zahl>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
function fehlerInfo(r) {
  if (!r) return { text: 'keine Antwort' };
  const out = {};
  if (r.status) out.status = r.status;
  let j = null; try { j = r.body ? JSON.parse(r.body) : null; } catch (e) { j = null; }
  const e = j && j.error;
  if (e) {
    if (e.code) out.code = Number(e.code) || e.code;
    const txt = [e.message, e.error_data && e.error_data.details].filter(Boolean).join(' – ');
    if (txt) out.text = anonym(txt);
  } else {
    const txt = r.error || r.body || '';
    if (txt) out.text = anonym(txt);
  }
  return out;
}

// Frei getippten Text als genehmigte Vorlage zustellen (business-initiiert, außerhalb des
// 24h-Fensters). Variable {{1}} = der Text (auf ~1000 Zeichen gekappt). Anbieter-bewusst.
async function sendFreeText(toNum, text) {
  const t = String(text || '').slice(0, 1000);
  if (hasTwilio && TW_TEXT_SID) return twilioSendTemplate(toNum, TW_TEXT_SID, { 1: t });
  if (hasMeta && WA_TEXT_TPL) return sendTemplate(toNum, WA_TEXT_TPL, 'de', [t]);
  return { ok: false, error: 'no_wa_text' };
}

// Genehmigte Vorlage (Meta; Twilio-Templates folgen via Content API in Phase 2).
async function sendTemplate(toNum, name, lang, bodyParams) {
  if (!hasMeta) return { ok: false, error: 'no_meta_template' };
  const components = (bodyParams && bodyParams.length)
    ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }]
    : undefined;
  return metaSend({ to: toWaNumber(toNum), type: 'template', template: { name: name, language: { code: lang || 'de' }, components: components } });
}

// ─────────────────────── Anklickbare Auswahl (Buttons) ───────────────────────
// Normalisiert eine Auswahl { body, options:[{id,title}|string] } auf 2–10 saubere
// Optionen mit stabiler id + gekürztem Titel. Liefert null, wenn zu wenig taugt.
function normOptions(choice) {
  const body = String((choice && choice.body) || '').trim().slice(0, 1000);
  const opts = (Array.isArray(choice && choice.options) ? choice.options : [])
    .map(function (o, i) {
      const title = String((o && (o.title || o.label)) || (typeof o === 'string' ? o : '')).trim();
      return { id: String((o && o.id) || ('opt_' + (i + 1))).slice(0, 200), title: title };
    })
    .filter(function (o) { return o.title; })
    .slice(0, 10);
  return (body && opts.length >= 2) ? { body: body, options: opts } : null;
}

// Baut das `interactive`-Objekt einer Meta-Nachricht: bis 3 Optionen -> Buttons,
// mehr -> Liste (bis 10). Rein (kein Netz) und daher testbar. null bei ungültig.
function metaInteractive(choice) {
  const c = normOptions(choice);
  if (!c) return null;
  if (c.options.length <= 3) {
    return {
      type: 'button',
      body: { text: c.body },
      action: { buttons: c.options.map(function (o) { return { type: 'reply', reply: { id: o.id, title: o.title.slice(0, 20) } }; }) },
    };
  }
  return {
    type: 'list',
    body: { text: c.body },
    action: { button: 'Auswählen', sections: [{ rows: c.options.map(function (o) { return { id: o.id, title: o.title.slice(0, 24) }; }) }] },
  };
}

// Anklickbare Auswahl senden (nur INNERHALB des 24h-Servicefensters zustellbar).
// choice = { body, options:[{id,title}] } (2–10 Optionen). Anbieter-bewusst:
//   - Meta:   native interaktive Nachricht (Buttons/Liste) OHNE Vorlage.
//   - Twilio: genehmigte Quick-Reply-Content-Vorlage (bis 3 Buttons) – nur wenn
//             TWILIO_QUICK_REPLY_CONTENT_SID gesetzt ist; sonst { ok:false, error:'no_buttons' }.
async function sendButtons(toNum, choice) {
  const c = normOptions(choice);
  if (!c) return { ok: false, error: 'bad_choice' };
  if (hasTwilio) {
    if (!TW_QUICK_SID) return { ok: false, error: 'no_buttons' };
    const vars = { 1: c.body };
    c.options.slice(0, 3).forEach(function (o, i) { vars[i + 2] = o.title.slice(0, 20); });
    return twilioSendTemplate(toNum, TW_QUICK_SID, vars);
  }
  if (hasMeta) {
    const interactive = metaInteractive(c);
    if (!interactive) return { ok: false, error: 'bad_choice' };
    return metaSend({ to: toWaNumber(toNum), type: 'interactive', interactive: interactive });
  }
  return { ok: false, error: 'no_whatsapp' };
}

// ───────────────────────── Meta-Webhook ─────────────────────────
function verifyChallenge(query) {
  query = query || {};
  if (query['hub.mode'] === 'subscribe' && VERIFY_TOKEN && query['hub.verify_token'] === VERIFY_TOKEN) {
    return String(query['hub.challenge'] || '');
  }
  return null;
}
function verifySignature(rawBody, header) {
  if (!APP_SECRET) return true;
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody || '', 'utf8').digest('hex');
  try { const a = Buffer.from(header), b = Buffer.from(expected); return a.length === b.length && crypto.timingSafeEqual(a, b); }
  catch (e) { return false; }
}
function parseInbound(body) {
  const out = [];
  const entries = (body && body.entry) || [];
  for (const e of entries) {
    const changes = (e && e.changes) || [];
    for (const c of changes) {
      const value = (c && c.value) || {};
      const contacts = value.contacts || [];
      const nameOf = (waId) => { const ct = contacts.find((x) => x && x.wa_id === waId); return (ct && ct.profile && ct.profile.name) || ''; };
      const msgs = value.messages || [];
      for (const m of msgs) {
        let text = '', image = null;
        if (m.type === 'text' && m.text) text = m.text.body || '';
        else if (m.type === 'button' && m.button) text = m.button.text || '';
        else if (m.type === 'interactive' && m.interactive) {
          const it = m.interactive;
          text = (it.button_reply && it.button_reply.title) || (it.list_reply && it.list_reply.title) || '';
        } else if (m.type === 'image' && m.image) {
          image = { mediaId: m.image.id, mediaType: m.image.mime_type || 'image/jpeg' };
          text = m.image.caption || '';
        }
        if (m.from && (text || image)) out.push({ from: m.from, text: text, name: nameOf(m.from), id: m.id, image: image });
      }
    }
  }
  return out;
}

// Status-Meldungen (gesendet/zugestellt/gelesen/fehlgeschlagen) aus dem Meta-Webhook.
function parseStatuses(body) {
  const out = [];
  const entries = (body && body.entry) || [];
  for (const e of entries) {
    const changes = (e && e.changes) || [];
    for (const c of changes) {
      const value = (c && c.value) || {};
      const sts = value.statuses || [];
      for (const s of sts) { if (s && s.id && s.status) out.push({ id: s.id, status: s.status }); }
    }
  }
  return out;
}

// ───────────────────────── Twilio-Webhook ─────────────────────────
// X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sortierte (key+value) der POST-Felder)).
// Ohne TWILIO_AUTH_TOKEN nicht erzwungen; mit TWILIO_SKIP_VALIDATION='1' abschaltbar (nur Setup).
function verifyTwilioSignature(fullUrl, params, header) {
  if (!TW_TOKEN || process.env.TWILIO_SKIP_VALIDATION === '1') return true;
  if (!header) return false;
  let data = String(fullUrl || '');
  Object.keys(params || {}).sort().forEach((k) => { data += k + params[k]; });
  const expected = crypto.createHmac('sha1', TW_TOKEN).update(data, 'utf8').digest('base64');
  try { const a = Buffer.from(expected), b = Buffer.from(String(header)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
  catch (e) { return false; }
}
// Twilio liefert genau eine Nachricht je Webhook (form-urlencoded).
function parseTwilioInbound(params) {
  params = params || {};
  const from = String(params.From || '').replace(/^whatsapp:/i, '').replace(/^\+/, '').replace(/[^\d]/g, '');
  // Bei einem angetippten Quick-Reply-Button liefert Twilio den Titel i. d. R. im Body;
  // fällt der leer aus, greifen wir auf ButtonText/ButtonPayload zurück.
  const text = String(params.Body || params.ButtonText || params.ButtonPayload || '');
  const name = params.ProfileName || '';
  // Foto: Twilio liefert MediaUrl0 + MediaContentType0 (per Basic-Auth ladbar).
  let image = null;
  const num = parseInt(params.NumMedia || '0', 10);
  if (num > 0 && params.MediaUrl0 && /^image\//i.test(String(params.MediaContentType0 || ''))) {
    image = { mediaUrl: params.MediaUrl0, mediaType: String(params.MediaContentType0 || 'image/jpeg') };
  }
  const out = [];
  if (from && (text || image)) out.push({ from: from, text: text, name: name, id: params.MessageSid || '', image: image });
  return out;
}

// Ein eingehendes Bild als base64 laden. Twilio: MediaUrl per Basic-Auth. Meta: erst
// die Media-URL über den Graph holen, dann mit dem Token laden. Liefert
// { base64, mediaType } oder null (nicht verfügbar/zu groß/Fehler). Wirft nie.
const MAX_MEDIA_B64 = 8000000;   // ~6 MB Rohbild (Grenze des Foto-Endpunkts)
async function fetchMedia(image) {
  if (!image) return null;
  try {
    if (image.mediaUrl) {
      if (!(TW_SID && TW_TOKEN)) return null;
      const auth = 'Basic ' + Buffer.from(TW_SID + ':' + TW_TOKEN).toString('base64');
      const r = await fetch(image.mediaUrl, { headers: { Authorization: auth } });
      if (!r.ok) return null;
      const ct = (r.headers.get('content-type') || image.mediaType || 'image/jpeg').split(';')[0];
      const b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
      return b64.length > MAX_MEDIA_B64 ? null : { base64: b64, mediaType: ct };
    }
    if (image.mediaId) {
      if (!TOKEN) return null;
      const meta = await fetch('https://graph.facebook.com/' + VER + '/' + encodeURIComponent(image.mediaId), { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (!meta.ok) return null;
      const mj = await meta.json().catch(function () { return null; });
      if (!mj || !mj.url) return null;
      const r = await fetch(mj.url, { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (!r.ok) return null;
      const ct = (r.headers.get('content-type') || mj.mime_type || image.mediaType || 'image/jpeg').split(';')[0];
      const b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
      return b64.length > MAX_MEDIA_B64 ? null : { base64: b64, mediaType: ct };
    }
  } catch (e) { /* still: kein Bild */ }
  return null;
}

module.exports = {
  hasWhatsApp, hasTwilio, hasMeta, hasWaLogin, hasWaText, hasWaButtons, toWaNumber, send, sendText, sendTemplate,
  twilioSendTemplate, sendLoginTemplate, sendFreeText, sendButtons, metaInteractive,
  fehlerInfo, loginComponents,
  verifyChallenge, verifySignature, parseInbound, parseStatuses, fetchMedia,
  verifyTwilioSignature, parseTwilioInbound,
  VERIFY_TOKEN, APP_SECRET,
};
