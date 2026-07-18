/*
 * Fit-Inn · Native-Brücke für die eigene App (Capacitor).
 * ------------------------------------------------------
 * Diese Datei ist ein NO-OP im normalen Browser. Sie wird erst aktiv, wenn das
 * Portal innerhalb der eigenen App (Capacitor) läuft – dann blendet sie native
 * Funktionen ein, ohne den Web-Code zu verändern:
 *   - Push: nach dem Login das Geräte-Token bei /api/push/register hinterlegen.
 *   - Biometrie: die Sitzung sicher im Gerät ablegen und beim nächsten Start per
 *     Face ID / Fingerabdruck entsperren.
 *   - Apple/Google-Login: native Buttons, die ein ID-Token holen und an
 *     /api/member/native-login schicken.
 *
 * Das Portal lädt diese Datei einfach mit (<script src="/assets/native.js">). Die
 * verwendeten Capacitor-Plugins (PushNotifications, Preferences, NativeBiometric,
 * SignInWithApple, SocialLogin) sind in der App-Hülle einkompiliert und stehen
 * der geladenen Live-URL über window.Capacitor.Plugins zur Verfügung.
 */
(function () {
  'use strict';

  var Cap = window.Capacitor;
  var isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  var P = (Cap && Cap.Plugins) || {};

  // Holt ein natives Plugin – funktioniert auch bei Live-URL-Apps, wo
  // Capacitor.Plugins.X nicht vorab befüllt ist (registerPlugin erzeugt den Proxy).
  function getPlugin(name) {
    try {
      if (P && P[name]) return P[name];
      if (Cap && typeof Cap.registerPlugin === 'function') return Cap.registerPlugin(name);
    } catch (e) {}
    return null;
  }

  // Öffentliche API – im Browser bewusst leere No-Ops, damit der Portal-Code
  // bedenkenlos FitInnNative.* aufrufen kann.
  var API = {
    isNative: isNative,
    platform: isNative && Cap.getPlatform ? Cap.getPlatform() : 'web',
    onAuthed: function () {},
    onTeamAuthed: function () {},
    onTeamLogout: function () {},
    onLogout: function () {},
    biometricUnlock: function () { return Promise.resolve(null); },
    hasBiometricLogin: function () { return false; },
    signIn: function () { return Promise.resolve({ ok: false, unavailable: true }); },
    connectWifi: function () { return Promise.resolve({ ok: false, unavailable: true }); },
    getPosition: function () { return Promise.resolve(null); },
    startHeartRate: function () { return Promise.resolve({ ok: false, unavailable: true }); },
    stopHeartRate: function () {},
    pushStatus: function () { return ''; },
    available: { push: false, biometrics: false, apple: false, google: false, wifi: false, geo: false, hr: false },
  };
  window.FitInnNative = API;
  if (!isNative) return;   // im Browser ist hier Schluss.

  document.documentElement.classList.add('is-native-app');

  // App-Feeling: Zoom (Pinch + Doppeltipp) abschalten und horizontales
  // Wischen/Überscrollen unterbinden – vertikales Scrollen bleibt erhalten.
  try {
    var vp = document.querySelector('meta[name=viewport]');
    if (!vp) { vp = document.createElement('meta'); vp.setAttribute('name', 'viewport'); document.head.appendChild(vp); }
    vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover');
    var st = document.createElement('style');
    // WICHTIG: overflow-x:CLIP (nicht hidden). `hidden` macht auf iOS-WebKit aus
    // <body> einen echten Scroll-Container – dann verlieren position:fixed-Elemente
    // (schwebender Initialen-Chip #profChip, Bottom-Nav) ihren Viewport-Bezug und
    // scrollen mit dem Inhalt mit. `clip` kappt den horizontalen Überlauf genauso,
    // erzeugt aber KEINEN Scroll-Container → fixed bleibt oben/unten fest verankert.
    // (Auf iOS < 16 ohne clip-Support fällt die Regel weg = kein H-Clip, aber auch
    // kein kaputtes fixed – der Inhalt ist ohnehin auf max-width:100% begrenzt.)
    st.textContent = 'html,body{max-width:100%;overflow-x:clip;overscroll-behavior:none;-webkit-text-size-adjust:100%;touch-action:pan-y;scrollbar-width:none;-ms-overflow-style:none;}'
      + '::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;}';
    document.head.appendChild(st);
    // Doppeltipp-Zoom zusätzlich hart unterbinden (manche WebViews ignorieren user-scalable).
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
  } catch (e) {}

  // ── Statusleiste: WebView bis UNTER die Statusleiste ziehen, weiße Symbole, teal Hintergrund ──
  // Ohne Overlay lässt iOS einen weißen Native-Streifen über der WebView stehen (der „blöde" Rand oben).
  // Style 'DARK' = heller/weißer Text – passt zum dunklen Teal hinter der Statusleiste.
  try {
    var SB = getPlugin('StatusBar');
    if (SB) {
      if (SB.setOverlaysWebView) SB.setOverlaysWebView({ overlay: true }).catch(function () {});
      if (SB.setStyle) SB.setStyle({ style: 'DARK' }).catch(function () {});
      if (SB.setBackgroundColor) SB.setBackgroundColor({ color: '#0e6072' }).catch(function () {}); // nur Android
    }
  } catch (e) {}

  API.available.push = !!(P.FirebaseMessaging || P.PushNotifications);
  API.available.biometrics = !!P.NativeBiometric;
  API.available.apple = !!(P.SignInWithApple || P.SocialLogin);
  API.available.google = !!(P.GoogleAuth || P.SocialLogin);
  // ── Ein-Tipp-WLAN: offenes Studio-Netz beitreten ───────────────────────────
  // Nutzt @falconeta/capacitor-wifi-connect (Plugin-Name: CapacitorWifiConnect;
  // iOS: NEHotspotConfiguration, Android: WifiNetworkSuggestion). Liefert { ok }.
  var WifiPlugin = getPlugin('CapacitorWifiConnect');
  API.available.wifi = !!WifiPlugin;
  API.connectWifi = function (ssid) {
    if (!WifiPlugin || !WifiPlugin.connect || !ssid) return Promise.resolve({ ok: false, unavailable: true });
    return WifiPlugin.connect({ ssid: ssid })
      .then(function (r) { return { ok: true, result: r }; })
      .catch(function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
  };

  // ── Standort (nativ): zuverlässig auf iOS, wo die WebView-Geolocation fehlt ──
  var GeoPlugin = getPlugin('Geolocation');
  API.available.geo = !!GeoPlugin;
  API.getPosition = function () {
    if (!GeoPlugin || !GeoPlugin.getCurrentPosition) return Promise.resolve(null);
    var go = function () {
      return GeoPlugin.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 })
        .then(function (p) { return (p && p.coords) ? { lat: p.coords.latitude, lng: p.coords.longitude } : null; })
        .catch(function () { return null; });
    };
    if (GeoPlugin.requestPermissions) { return GeoPlugin.requestPermissions().then(go).catch(go); }
    return go();
  };

  // ── Herzfrequenz (Polar H9 & andere BLE-Brustgurte): Standard Heart-Rate-Service ──
  // iOS-WKWebView kann kein Web Bluetooth -> hier nativ über @capacitor-community/bluetooth-le
  // (Plugin-Name: BluetoothLe). Streamt Puls (BPM) + – falls der Gurt sie sendet –
  // R-R-Intervalle (in ms, für die HRV-Berechnung). Der H9 sendet R-R weniger
  // zuverlässig als der H10, daher wird HRV client-seitig nur „best effort" genutzt.
  // Auf Android/Desktop nutzt der Portal-Code stattdessen direkt navigator.bluetooth.
  // HINWEIS: Event-Name/Payload des Roh-Plugins sind versionsabhängig – am echten
  // Gerät gegenprüfen (Standard-UUIDs 0x180D / 0x2A37 bleiben gleich).
  var HR_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
  var HR_MEAS = '00002a37-0000-1000-8000-00805f9b34fb';
  var Ble = getPlugin('BluetoothLe');
  // Nur „verfügbar", wenn das native Plugin WIRKLICH einkompiliert ist. registerPlugin
  // liefert sonst nur einen Proxy (truthy), dessen Aufrufe „not implemented" werfen –
  // dann wäre der Button fälschlich aktiv. isPluginAvailable prüft die echte native
  // Registrierung; fehlt die Methode (ältere Capacitor-Version), fällt es auf !!Ble zurück.
  try {
    API.available.hr = (Cap && typeof Cap.isPluginAvailable === 'function')
      ? !!Cap.isPluginAvailable('BluetoothLe')
      : !!Ble;
  } catch (e) { API.available.hr = !!Ble; }
  var hrState = { deviceId: null, listener: null };
  function b64ToBytes(b64) {
    try { var bin = atob(String(b64 || '')); var a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; } catch (e) { return new Uint8Array(0); }
  }
  // Heart-Rate-Measurement (0x2A37) parsen: Flags-Byte, dann 8- oder 16-Bit-BPM,
  // optional Energie + R-R-Intervalle (1/1024 s -> ms).
  function parseHR(bytes) {
    if (!bytes || !bytes.length) return null;
    var flags = bytes[0]; var i = 1; var bpm;
    if (flags & 0x01) { bpm = bytes[i] | (bytes[i + 1] << 8); i += 2; } else { bpm = bytes[i]; i += 1; }
    if (flags & 0x08) { i += 2; }            // Energie-Feld überspringen (falls vorhanden)
    var rr = [];
    if (flags & 0x10) { while (i + 1 < bytes.length) { rr.push(Math.round((bytes[i] | (bytes[i + 1] << 8)) / 1024 * 1000)); i += 2; } }
    return (bpm && bpm > 0) ? { bpm: bpm, rr: rr } : null;
  }
  API.startHeartRate = function (cb) {
    if (!Ble || typeof cb !== 'function') return Promise.resolve({ ok: false, unavailable: true });
    return Promise.resolve()
      .then(function () { return Ble.initialize ? Ble.initialize() : null; })
      .then(function () { return Ble.requestDevice ? Ble.requestDevice({ services: [HR_SERVICE] }) : null; })
      .then(function (dev) { hrState.deviceId = dev && (dev.deviceId || (dev.device && dev.device.deviceId)); if (!hrState.deviceId) throw new Error('no_device'); return Ble.connect({ deviceId: hrState.deviceId }); })
      .then(function () {
        if (Ble.addListener) hrState.listener = Ble.addListener('notification', function (ev) { var hr = parseHR(b64ToBytes(ev && (ev.value || ev.data))); if (hr) cb(hr); });
        return Ble.startNotifications ? Ble.startNotifications({ deviceId: hrState.deviceId, service: HR_SERVICE, characteristic: HR_MEAS }) : null;
      })
      .then(function () { return { ok: true }; })
      .catch(function (e) { API.stopHeartRate(); return { ok: false, error: (e && e.message) || String(e) }; });
  };
  API.stopHeartRate = function () {
    try { if (hrState.listener && hrState.listener.remove) hrState.listener.remove(); } catch (e) {}
    try { if (Ble && Ble.stopNotifications && hrState.deviceId) Ble.stopNotifications({ deviceId: hrState.deviceId, service: HR_SERVICE, characteristic: HR_MEAS }); } catch (e) {}
    try { if (Ble && Ble.disconnect && hrState.deviceId) Ble.disconnect({ deviceId: hrState.deviceId }); } catch (e) {}
    hrState.deviceId = null; hrState.listener = null;
  };

  function token() {
    try { return localStorage.getItem('fi_member_token') || sessionStorage.getItem('fi_member_token') || null; } catch (e) { return null; }
  }
  function teamToken() {
    try { return localStorage.getItem('fi_team_token') || null; } catch (e) { return null; }
  }
  function post(path, bodyObj, withAuth) {
    var headers = { 'Content-Type': 'application/json' };
    if (withAuth) { var t = token(); if (t) headers.Authorization = 'Bearer ' + t; }
    return fetch(path, { method: 'POST', headers: headers, body: JSON.stringify(bodyObj || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .catch(function () { return {}; });
  }
  // POST mit explizitem Bearer (für das Team-Backend, das einen eigenen Token führt).
  function postAuth(path, bodyObj, bearerTok) {
    var headers = { 'Content-Type': 'application/json' };
    if (bearerTok) headers.Authorization = 'Bearer ' + bearerTok;
    return fetch(path, { method: 'POST', headers: headers, body: JSON.stringify(bodyObj || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .catch(function () { return {}; });
  }

  // ── Push: Geräte-Token registrieren ─────────────────────────────────────────
  // Bevorzugt @capacitor-firebase/messaging (liefert ein FCM-Token für iOS UND
  // Android -> passt zum FCM-Versand im Backend). Fällt auf @capacitor/push-
  // notifications zurück, falls nur das installiert ist.
  var pushReady = false;
  var lastPushToken = null;   // zuletzt erhaltenes Geräte-Token (für Nach-Login-Registrierung)
  function pdbg(s) { try { localStorage.setItem('fi_push_dbg', String(s)); } catch (e) {} }
  API.pushStatus = function () { try { return localStorage.getItem('fi_push_dbg') || ''; } catch (e) { return ''; } };
  // Ein Geräte-Token, zwei mögliche Ziele: als Mitglied (fi_member_token) und/oder
  // als Team (fi_team_token). So bekommt derselbe App-Nutzer je nach Anmeldung
  // Mitglieder- UND/ODER Team-Pushes. Registrierung ist idempotent (Set im Backend).
  function registerPushToken(tok) {
    if (!tok) { pdbg('kein-token'); return; }
    lastPushToken = tok;
    var mt = token(), tt = teamToken();
    if (!mt && !tt) { pdbg('token erhalten, aber (noch) nicht angemeldet'); return; }
    pdbg('token erhalten (len=' + String(tok).length + '), sende …' + (mt ? ' [member]' : '') + (tt ? ' [team]' : ''));
    if (mt) post('/api/push/register', { token: tok, platform: API.platform }, true)
      .then(function (r) { pdbg('member registriert ok=' + !!(r && r.ok)); })
      .catch(function () { pdbg('member-registrierung fehlgeschlagen'); });
    if (tt) postAuth('/api/team/push', { token: tok, platform: API.platform }, tt)
      .then(function (r) { pdbg('team registriert ok=' + !!(r && r.ok)); })
      .catch(function () { pdbg('team-registrierung fehlgeschlagen'); });
  }
  function setupPush() {
    if (pushReady) return;
    var FM = P.FirebaseMessaging;
    if (FM) {
      pushReady = true;
      try {
        FM.addListener('tokenReceived', function (e) { registerPushToken(e && e.token); });
        FM.addListener('notificationActionPerformed', function (ev) {
          try { var url = ev && ev.notification && ev.notification.data && ev.notification.data.url; if (url) location.assign(url); } catch (e) {}
        });
        FM.requestPermissions().then(function (st) {
          if (st && st.receive === 'granted') return FM.getToken().then(function (r) { registerPushToken(r && r.token); });
        }).catch(function () {});
      } catch (e) {}
      return;
    }
    if (!P.PushNotifications) { pdbg('kein PushNotifications-Plugin'); return; }
    pushReady = true;
    pdbg('setup gestartet');
    try {
      P.PushNotifications.addListener('registration', function (t) { registerPushToken(t && t.value); });
      P.PushNotifications.addListener('registrationError', function (e) { pdbg('registrierungs-fehler: ' + JSON.stringify((e && (e.error || e.message)) || e).slice(0, 160)); });
      P.PushNotifications.addListener('pushNotificationActionPerformed', function (ev) {
        try { var url = ev && ev.notification && ev.notification.data && ev.notification.data.url; if (url) location.assign(url); } catch (e) {}
      });
      P.PushNotifications.checkPermissions().then(function (st) {
        pdbg('berechtigung: ' + (st && st.receive));
        if (st && st.receive === 'granted') return P.PushNotifications.register();
        return P.PushNotifications.requestPermissions().then(function (r) {
          pdbg('nach abfrage: ' + (r && r.receive));
          if (r && r.receive === 'granted') return P.PushNotifications.register();
        });
      }).catch(function (e) { pdbg('perm-fehler: ' + ((e && e.message) || e)); });
    } catch (e) { pdbg('setup-exception: ' + ((e && e.message) || e)); }
  }

  // ── Biometrie: Sitzung sicher ablegen / entsperren ──────────────────────────
  var BIO_SERVER = 'mitglieder.fit-inn-trier.de';
  function bioFlag(on) { try { if (on) localStorage.setItem('fi_bio', '1'); else localStorage.removeItem('fi_bio'); } catch (e) {} }
  function storeBiometric(t) {
    if (!P.NativeBiometric || !t) return;
    try { P.NativeBiometric.setCredentials({ username: 'member', password: t, server: BIO_SERVER }).then(function () { bioFlag(true); }).catch(function () {}); } catch (e) {}
  }
  function clearBiometric() {
    bioFlag(false);
    if (!P.NativeBiometric) return;
    try { P.NativeBiometric.deleteCredentials({ server: BIO_SERVER }).catch(function () {}); } catch (e) {}
  }
  // Soll der „Mit Face ID anmelden"-Knopf gezeigt werden? (App + Plugin + schon mal eingeloggt)
  API.hasBiometricLogin = function () {
    try { return isNative && API.available.biometrics && localStorage.getItem('fi_bio') === '1'; } catch (e) { return false; }
  };
  API.biometricUnlock = function () {
    if (!P.NativeBiometric) return Promise.resolve(null);
    return P.NativeBiometric.isAvailable().then(function (res) {
      if (!res || !res.isAvailable) return null;
      return P.NativeBiometric.verifyIdentity({ reason: 'Mit Face ID / Fingerabdruck entsperren', title: 'Fit-Inn entsperren' })
        .then(function () { return P.NativeBiometric.getCredentials({ server: BIO_SERVER }); })
        .then(function (c) { return (c && c.password) || null; })
        .catch(function () { return null; });
    }).catch(function () { return null; });
  };

  // ── Native Apple/Google-Anmeldung ───────────────────────────────────────────
  function appleIdToken() {
    if (P.SignInWithApple && P.SignInWithApple.authorize) {
      return P.SignInWithApple.authorize({ requestedScopes: [0, 1] })
        .then(function (r) { return (r && r.response && r.response.identityToken) || null; });
    }
    if (P.SocialLogin && P.SocialLogin.login) {
      return P.SocialLogin.login({ provider: 'apple', options: {} })
        .then(function (r) { return (r && r.result && (r.result.idToken || r.result.identityToken)) || null; });
    }
    return Promise.resolve(null);
  }
  function googleIdToken() {
    if (P.GoogleAuth && P.GoogleAuth.signIn) {
      return P.GoogleAuth.signIn().then(function (r) {
        return (r && (r.authentication && r.authentication.idToken)) || (r && r.idToken) || null;
      });
    }
    if (P.SocialLogin && P.SocialLogin.login) {
      return P.SocialLogin.login({ provider: 'google', options: {} })
        .then(function (r) { return (r && r.result && r.result.idToken) || null; });
    }
    return Promise.resolve(null);
  }
  // Liefert { ok, token } oder { ok:false, needsCode } -> dann normalen Code-Login zeigen.
  API.signIn = function (provider) {
    var get = provider === 'apple' ? appleIdToken : googleIdToken;
    return get().then(function (idToken) {
      if (!idToken) return { ok: false, needsCode: true };
      return post('/api/member/native-login', { provider: provider, idToken: idToken, remember: true }, false);
    }).catch(function () { return { ok: false, needsCode: true }; });
  };

  // ── Hooks fürs Portal ───────────────────────────────────────────────────────
  API.onAuthed = function (t) {
    setupPush();
    storeBiometric(t || token());
    if (lastPushToken) registerPushToken(lastPushToken);   // Token schon da? sofort dem Mitglied zuordnen.
  };
  // Vom Team-Backend nach dem Login aufgerufen: Push einrichten und das Geräte-Token
  // dem Team-Pool zuordnen (falls schon vorhanden, sofort – sonst beim Eintreffen).
  API.onTeamAuthed = function () {
    setupPush();
    if (lastPushToken) registerPushToken(lastPushToken);
  };
  // MUSS aufgerufen werden, solange fi_team_token noch existiert (vor dem Abmelden):
  // löst das Geräte-Token aus dem Team-Pool, damit ein abgemeldetes Gerät keine
  // Team-Pushes (sensible Mitgliederdaten) mehr erhält.
  API.onTeamLogout = function () {
    var tt = teamToken();
    if (lastPushToken && tt) { try { postAuth('/api/team/push', { action: 'unregister', token: lastPushToken }, tt); } catch (e) {} }
  };
  API.onLogout = function () {
    clearBiometric();
    var t = token();
    if (t && P.PushNotifications) {
      // Token serverseitig lösen (best effort) – verlangt noch die Auth.
    }
  };

  // Bekommt das Portal sofort mit, dass es nativ läuft.
  try { window.dispatchEvent(new Event('fitinn-native-ready')); } catch (e) {}
})();
