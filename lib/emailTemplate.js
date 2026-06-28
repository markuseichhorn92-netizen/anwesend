'use strict';

/**
 * Fit-Inn Trier · E-Mail-Design-System
 * ------------------------------------
 * Ein Master-Template (premium & minimalistisch): gleicher Header (Teal + Logo),
 * gleiche Bausteine (Eyebrow, Headline, Body, Info-Panel, Code-Block, Button,
 * "Freunde werben"-Promo, Footer) – nur der Inhalt wechselt je nach Anlass.
 *
 * `renderEmail(opts)` liefert { html, text }. HTML ist tabellenbasiert mit
 * Inline-Styles (maximale Client-Kompatibilität = heller Standard); ein
 * zusätzlicher <style>-Block bringt
 *   - Responsiveness (skaliert sauber auf dem Smartphone) und
 *   - Dark Mode (passt sich der System-/Client-Einstellung an, best effort:
 *     Apple Mail/iOS u. a. respektieren prefers-color-scheme; Gmail dunkelt
 *     selbst ab). Overrides nutzen Klassen + !important, da Inline-Styles
 *     sonst gewinnen.
 *
 * Es werden KEINE Geheimnisse/PII fest verdrahtet – dynamische Werte werden
 * von den Aufrufern übergeben und hier HTML-escaped.
 */

var BASE = process.env.PUBLIC_BASE_URL || 'https://mitglieder.fit-inn-trier.de';
var LOGO = BASE + '/assets/fitinn-logo-white.png';
var WERBEN_URL = BASE + '/werben';

// Studio-Stammdaten (für Footer) – bewusst hier zentral, keine PII.
var STUDIO = {
  name: 'Fit-Inn Trier',
  address: 'Auf Hirtenberg 8 · 54296 Trier',
  email: 'info@fit-inn-trier.de',
  instagram: 'https://www.instagram.com/fitinntrier/',
  website: 'https://www.fit-inn-trier.de',
};

// ---- Farben hell (1:1 aus dem Design) ----
var C = {
  teal: '#0a4958',
  ink: '#15171B',
  body: '#42454b',
  muted: '#6b7780',
  faint: '#8a8178',
  hair: '#edf0f1',
  panel: '#f1f6f7',
  accent: '#E08C53',   // Eyebrow-Orange
  promoAccent: '#F0A868',
  fine: '#b3ada5',
  page: '#eef2f3',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function asArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

// ---------- CSS (Responsive + Dark Mode) ----------
// Greift nur in Clients, die <style>/Media-Queries unterstützen. Der helle
// Inline-Standard bleibt überall als Fallback erhalten.
var STYLE = '' +
  // ---- Mobil: Karte auf volle Breite, kompaktere Abstände, kleinere Headline ----
  '@media only screen and (max-width:600px){' +
    '.email-card{width:100%!important}' +
    '.email-outer{padding:14px 8px!important}' +
    '.email-pad{padding-left:24px!important;padding-right:24px!important}' +
    '.email-pad-t{padding-top:30px!important}' +
    '.email-h1{font-size:22px!important}' +
    '.email-btn{display:block!important;text-align:center!important}' +
  '}' +
  // ---- Dark Mode (best effort) ----
  '@media (prefers-color-scheme:dark){' +
    '.email-bg{background:#0b1416!important}' +
    '.email-card{background:#16211f!important}' +
    '.email-content{background:#16211f!important}' +
    '.email-h1,.email-greet,.email-strong{color:#e9f0f0!important}' +
    '.email-p{color:#c7d2d2!important}' +
    '.email-muted{color:#9aa9a9!important}' +
    '.email-faint{color:#8a9999!important}' +
    '.email-panel{background:#1e2b29!important}' +
    '.email-panel-label{color:#9aa9a9!important}' +
    '.email-panel-val{color:#e9f0f0!important}' +
    '.email-teal{color:#5cc0d0!important}' +
    '.email-hair{background:#2d3c3b!important}' +
    '.email-footer{border-color:#2d3c3b!important}' +
  '}' +
  // ---- Outlook.com Dark (data-ogsc/ogsb) – das Wichtigste abdecken ----
  '[data-ogsc] .email-h1,[data-ogsc] .email-greet,[data-ogsc] .email-strong{color:#e9f0f0!important}' +
  '[data-ogsc] .email-p{color:#c7d2d2!important}' +
  '[data-ogsc] .email-muted{color:#9aa9a9!important}' +
  '[data-ogsc] .email-faint{color:#8a9999!important}' +
  '[data-ogsc] .email-teal{color:#5cc0d0!important}' +
  '[data-ogsb] .email-card,[data-ogsb] .email-content{background:#16211f!important}' +
  '[data-ogsb] .email-panel{background:#1e2b29!important}';

// ---------- HTML-Bausteine ----------

function htmlHeader() {
  return '' +
    '<tr><td class="email-pad" style="background:' + C.teal + '; padding:26px 40px; text-align:center;">' +
      '<img src="' + LOGO + '" alt="' + esc(STUDIO.name) + '" height="24" style="height:24px; width:auto; display:inline-block; border:0;" />' +
    '</td></tr>';
}

function htmlGreeting(name) {
  var g = name ? ('Hallo ' + esc(name) + ',') : 'Hallo,';
  return '<div class="email-greet" style="font-size:15px; font-weight:700; color:' + C.ink + '; margin-bottom:20px;">' + g + '</div>';
}

function htmlEyebrow(t) {
  if (!t) return '';
  return '<div style="font-size:12px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:' + C.accent + ';">' + esc(t) + '</div>';
}

function htmlHeadline(t) {
  if (!t) return '';
  return '<h1 class="email-h1" style="margin:12px 0 0; font-size:26px; font-weight:800; letter-spacing:-.5px; color:' + C.ink + '; line-height:1.22;">' + esc(t) + '</h1>';
}

function htmlParagraphs(intro) {
  return asArray(intro).map(function (p, i) {
    return '<p class="email-p" style="margin:' + (i === 0 ? '16px' : '14px') + ' 0 0; font-size:15px; line-height:1.65; color:' + C.body + '; font-weight:500;">' + esc(p) + '</p>';
  }).join('');
}

function htmlPanel(rows) {
  rows = asArray(rows).filter(function (r) { return r && r.label != null; });
  if (!rows.length) return '';
  var inner = rows.map(function (r, i) {
    return '<tr>' +
      '<td class="email-panel-label" style="padding:' + (i ? '13px' : '0') + ' 0 0; font-size:14px; color:' + C.muted + '; font-weight:500;">' + esc(r.label) + '</td>' +
      '<td class="email-panel-val" style="padding:' + (i ? '13px' : '0') + ' 0 0; font-size:14px; color:' + C.ink + '; font-weight:700; text-align:right;">' + esc(r.value) + '</td>' +
      '</tr>';
  }).join('');
  return '<div class="email-panel" style="margin-top:24px; background:' + C.panel + '; border-radius:14px; padding:20px 22px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">' + inner + '</table>' +
    '</div>';
}

function htmlDivider(t) {
  if (!t) return '';
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin-top:26px;"><tr>' +
    '<td style="width:50%;"><div class="email-hair" style="height:1px; background:' + C.hair + '; line-height:1px; font-size:0;">&nbsp;</div></td>' +
    '<td class="email-faint" style="white-space:nowrap; padding:0 14px; font-size:11px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:' + C.fine + ';">' + esc(t) + '</td>' +
    '<td style="width:50%;"><div class="email-hair" style="height:1px; background:' + C.hair + '; line-height:1px; font-size:0;">&nbsp;</div></td>' +
    '</tr></table>';
}

function htmlCode(code) {
  if (!code || !code.value) return '';
  var spacing = code.spacing != null ? code.spacing : 12;
  var size = code.size != null ? code.size : 36;
  return '<div class="email-panel" style="margin-top:22px; background:' + C.panel + '; border-radius:14px; padding:24px 24px 22px; text-align:center;">' +
    '<div class="email-muted" style="font-size:12px; font-weight:600; color:' + C.muted + '; letter-spacing:.3px;">' + esc(code.label || 'Dein Code') + '</div>' +
    '<div class="email-teal" style="margin-top:10px; font-size:' + size + 'px; font-weight:800; letter-spacing:' + spacing + 'px; color:' + C.teal + ';">' + esc(code.value) + '</div>' +
    '</div>';
}

function htmlButton(button, secondary) {
  if (!button || !button.href) {
    if (secondary && secondary.href) {
      return '<div style="margin-top:28px;"><a class="email-teal" href="' + esc(secondary.href) + '" style="font-size:14px; font-weight:700; color:' + C.teal + '; text-decoration:none;">' + esc(secondary.label || 'Mehr') + '</a></div>';
    }
    return '';
  }
  var full = !!button.full;
  var btn = '<a class="email-btn" href="' + esc(button.href) + '" style="' +
    (full ? 'display:block; text-align:center; ' : 'display:inline-block; ') +
    'background:' + C.teal + '; color:#fff; font-size:' + (full ? 16 : 15) + 'px; font-weight:700; padding:' + (full ? '16px 28px' : '14px 28px') + '; border-radius:11px; text-decoration:none; letter-spacing:.2px;">' + esc(button.label || 'Öffnen') + '</a>';
  if (secondary && secondary.href) {
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;"><tr>' +
      '<td style="padding-right:20px;">' + btn + '</td>' +
      '<td><a class="email-teal" href="' + esc(secondary.href) + '" style="font-size:14px; font-weight:700; color:' + C.teal + '; text-decoration:none;">' + esc(secondary.label || 'Mehr') + '</a></td>' +
      '</tr></table>';
  }
  return '<div style="margin-top:28px;">' + btn + '</div>';
}

function htmlNote(note) {
  if (!note) return '';
  return '<p class="email-faint" style="margin:22px 0 0; font-size:13px; line-height:1.6; color:' + C.faint + '; font-weight:500;">' + esc(note) + '</p>';
}

// Persönlicher Teilen-Link fürs Werben (öffnet /teilen: Handy -> Share-Sheet,
// Desktop -> Link kopieren). Ohne Code Fallback auf die allgemeine Werben-Seite.
function shareHref(referral) {
  var code = referral && referral.code;
  if (!code) return WERBEN_URL;
  var u = BASE + '/teilen?ref=' + encodeURIComponent(String(code));
  if (referral.firstName) u += '&name=' + encodeURIComponent(String(referral.firstName));
  return u;
}

function htmlPromo(referral) {
  var href = shareHref(referral);
  function stat(num, accent, label, sub) {
    return '<td width="50%" style="width:50%; vertical-align:top;">' +
      '<div style="background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.16); border-radius:13px; padding:16px 10px; text-align:center;">' +
        '<div style="font-size:30px; font-weight:900; color:' + (accent ? C.promoAccent : '#fff') + '; letter-spacing:-1px; line-height:1;">' + num + '</div>' +
        '<div style="margin-top:5px; font-size:12px; font-weight:700; color:#fff;">' + label + '</div>' +
        '<div style="margin-top:1px; font-size:11px; font-weight:500; color:#9fc0c8;">' + sub + '</div>' +
      '</div></td>';
  }
  return '<tr><td class="email-pad" style="padding:8px 40px 32px;">' +
    '<div style="background:' + C.teal + '; border-radius:16px; padding:28px 28px 26px; text-align:center;">' +
      '<div style="font-size:11px; font-weight:700; letter-spacing:1.4px; text-transform:uppercase; color:' + C.promoAccent + ';">Freunde werben</div>' +
      '<div style="margin-top:8px; font-size:21px; font-weight:800; color:#fff; letter-spacing:-.4px; line-height:1.25;">Empfehle Fit-Inn &mdash; ihr gewinnt beide</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin-top:20px; border-collapse:separate; border-spacing:12px 0;"><tr>' +
        stat('4', true, 'Wochen f&uuml;r dich', 'beitragsfrei') +
        stat('2', false, 'Wochen f&uuml;r ihn', 'gratis testen') +
      '</tr></table>' +
      '<a href="' + href + '" style="margin-top:22px; display:block; background:' + C.promoAccent + '; color:' + C.ink + '; font-size:15px; font-weight:800; padding:14px 22px; border-radius:11px; text-decoration:none; letter-spacing:.2px;">Jetzt Freund werben &rarr;</a>' +
    '</div></td></tr>';
}

function htmlFooter(kind) {
  var fine = kind === 'security'
    ? 'Diese E-Mail wurde aus Sicherheitsgr&uuml;nden versendet. Wenn du sie nicht angefordert hast, kannst du sie ignorieren.'
    : 'Du erh&auml;ltst diese E-Mail als Mitglied von ' + esc(STUDIO.name) + '.';
  return '<tr><td class="email-footer email-pad" style="padding:28px 40px 30px; border-top:1px solid ' + C.hair + ';">' +
    '<div class="email-teal" style="font-size:13px; font-weight:800; color:' + C.teal + '; letter-spacing:-.2px;">' + esc(STUDIO.name) + '</div>' +
    '<p class="email-faint" style="margin:8px 0 0; font-size:12px; line-height:1.7; color:' + C.faint + '; font-weight:500;">' + esc(STUDIO.address) + '<br />' + esc(STUDIO.email) + '</p>' +
    '<div style="margin-top:14px;">' +
      '<a class="email-muted" href="' + STUDIO.instagram + '" style="font-size:12px; color:' + C.muted + '; text-decoration:none; font-weight:600; margin-right:18px;">Instagram</a>' +
      '<a class="email-muted" href="' + STUDIO.website + '" style="font-size:12px; color:' + C.muted + '; text-decoration:none; font-weight:600;">Website</a>' +
    '</div>' +
    '<p class="email-faint" style="margin:16px 0 0; font-size:11px; line-height:1.6; color:' + C.fine + ';">' + fine + '</p>' +
    '</td></tr>';
}

function htmlPreheader(t) {
  if (!t) return '';
  return '<div style="display:none; max-height:0; overflow:hidden; mso-hide:all; font-size:1px; line-height:1px; color:' + C.page + ';">' + esc(t) +
    '&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>';
}

// ---------- Klartext-Variante ----------

function buildText(o) {
  var L = [];
  L.push(o.name ? ('Hallo ' + o.name + ',') : 'Hallo,');
  if (o.headline) { L.push(''); L.push(o.headline); }
  asArray(o.intro).forEach(function (p) { L.push(''); L.push(p); });
  asArray(o.panel).filter(function (r) { return r && r.label != null; }).forEach(function (r, i) {
    if (i === 0) L.push('');
    L.push('  ' + r.label + ': ' + r.value);
  });
  if (o.code && o.code.value) { L.push(''); L.push((o.code.label || 'Dein Code') + ': ' + o.code.value); }
  if (o.button && o.button.href) { L.push(''); L.push(o.button.label + ': ' + o.button.href); }
  if (o.secondary && o.secondary.href) { L.push(''); L.push(o.secondary.label + ': ' + o.secondary.href); }
  if (o.note) { L.push(''); L.push(o.note); }
  L.push(''); L.push('—');
  L.push(STUDIO.name + ' · ' + STUDIO.address);
  return L.join('\n');
}

// ---------- Master ----------

/**
 * @param {Object} o
 *   name, eyebrow, headline, intro(string|string[]),
 *   panel([{label,value}]), divider(string), code({label,value,spacing,size}),
 *   button({label,href,full}), secondary({label,href}), note(string),
 *   promo(bool, default false), referral({code,firstName}) für persönlichen
 *   Teilen-Link im Promo, footer('member'|'security'), preheader(string)
 * @returns {{html:string, text:string}}
 */
function renderEmail(o) {
  o = o || {};
  var bodyInner = '' +
    htmlGreeting(o.name) +
    htmlEyebrow(o.eyebrow) +
    htmlHeadline(o.headline) +
    htmlParagraphs(o.intro) +
    htmlPanel(o.panel) +
    htmlDivider(o.divider) +
    htmlCode(o.code) +
    htmlButton(o.button, o.secondary) +
    htmlNote(o.note);

  var card = '' +
    '<table role="presentation" class="email-card" width="600" cellpadding="0" cellspacing="0" border="0" align="center" style="width:600px; max-width:600px; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.08);">' +
      htmlHeader() +
      '<tr><td class="email-content email-pad email-pad-t" style="padding:44px 40px 36px;">' + bodyInner + '</td></tr>' +
      (o.promo ? htmlPromo(o.referral) : '') +
      htmlFooter(o.footer === 'security' ? 'security' : 'member') +
    '</table>';

  var html = '<!DOCTYPE html><html lang="de"><head>' +
    '<meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<meta name="color-scheme" content="light dark" />' +
    '<meta name="supported-color-schemes" content="light dark" />' +
    '<title>' + esc(o.headline || STUDIO.name) + '</title>' +
    '<style>' + STYLE + '</style>' +
    '</head>' +
    '<body class="email-bg" style="margin:0; padding:0; background:' + C.page + '; font-family:\'Archivo\', \'Segoe UI\', system-ui, -apple-system, Helvetica, Arial, sans-serif;">' +
    htmlPreheader(o.preheader) +
    '<table role="presentation" class="email-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; background:' + C.page + ';"><tr>' +
      '<td class="email-outer" align="center" style="padding:32px 16px;">' + card + '</td>' +
    '</tr></table>' +
    '</body></html>';

  return { html: html, text: buildText(o) };
}

module.exports = { renderEmail: renderEmail, STUDIO: STUDIO, BASE: BASE };
