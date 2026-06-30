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

  // Öffentliche API – im Browser bewusst leere No-Ops, damit der Portal-Code
  // bedenkenlos FitInnNative.* aufrufen kann.
  var API = {
    isNative: isNative,
    platform: isNative && Cap.getPlatform ? Cap.getPlatform() : 'web',
    onAuthed: function () {},
    onLogout: function () {},
    biometricUnlock: function () { return Promise.resolve(null); },
    hasBiometricLogin: function () { return false; },
    signIn: function () { return Promise.resolve({ ok: false, unavailable: true }); },
    connectWifi: function () { return Promise.resolve({ ok: false, unavailable: true }); },
    getPosition: function () { return Promise.resolve(null); },
    available: { push: false, biometrics: false, apple: false, google: false, wifi: false, geo: false },
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
    st.textContent = 'html,body{max-width:100%;overflow-x:hidden;overscroll-behavior:none;-webkit-text-size-adjust:100%;touch-action:pan-y;scrollbar-width:none;-ms-overflow-style:none;}'
      + '::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;}';
    document.head.appendChild(st);
    // Doppeltipp-Zoom zusätzlich hart unterbinden (manche WebViews ignorieren user-scalable).
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
  } catch (e) {}

  API.available.push = !!(P.FirebaseMessaging || P.PushNotifications);
  API.available.biometrics = !!P.NativeBiometric;
  API.available.apple = !!(P.SignInWithApple || P.SocialLogin);
  API.available.google = !!(P.GoogleAuth || P.SocialLogin);
  API.available.wifi = !!(P.CapacitorWifiConnect && P.CapacitorWifiConnect.connect);

  // ── Ein-Tipp-WLAN: offenes Studio-Netz beitreten ───────────────────────────
  // Nutzt @falconeta/capacitor-wifi-connect (Plugin-Name: CapacitorWifiConnect;
  // iOS: NEHotspotConfiguration, Android: WifiNetworkSuggestion). Liefert { ok }.
  API.connectWifi = function (ssid) {
    var W = P.CapacitorWifiConnect;
    if (!W || !W.connect || !ssid) return Promise.resolve({ ok: false, unavailable: true });
    return W.connect({ ssid: ssid })
      .then(function (r) { return { ok: true, result: r }; })
      .catch(function (e) { return { ok: false, error: (e && e.message) || String(e) }; });
  };

  // ── Standort (nativ): zuverlässig auf iOS, wo die WebView-Geolocation fehlt ──
  API.available.geo = !!(P.Geolocation && P.Geolocation.getCurrentPosition);
  API.getPosition = function () {
    var G = P.Geolocation;
    if (!G || !G.getCurrentPosition) return Promise.resolve(null);
    var go = function () {
      return G.getCurrentPosition({ enableHighAccuracy: true, timeout: 8000 })
        .then(function (p) { return (p && p.coords) ? { lat: p.coords.latitude, lng: p.coords.longitude } : null; })
        .catch(function () { return null; });
    };
    if (G.requestPermissions) { return G.requestPermissions().then(go).catch(go); }
    return go();
  };

  function token() {
    try { return localStorage.getItem('fi_member_token') || sessionStorage.getItem('fi_member_token') || null; } catch (e) { return null; }
  }
  function post(path, bodyObj, withAuth) {
    var headers = { 'Content-Type': 'application/json' };
    if (withAuth) { var t = token(); if (t) headers.Authorization = 'Bearer ' + t; }
    return fetch(path, { method: 'POST', headers: headers, body: JSON.stringify(bodyObj || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .catch(function () { return {}; });
  }

  // ── Push: Geräte-Token registrieren ─────────────────────────────────────────
  // Bevorzugt @capacitor-firebase/messaging (liefert ein FCM-Token für iOS UND
  // Android -> passt zum FCM-Versand im Backend). Fällt auf @capacitor/push-
  // notifications zurück, falls nur das installiert ist.
  var pushReady = false;
  function registerPushToken(tok) {
    if (tok) post('/api/push/register', { token: tok, platform: API.platform }, true);
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
    if (!P.PushNotifications) return;
    pushReady = true;
    try {
      P.PushNotifications.addListener('registration', function (t) { registerPushToken(t && t.value); });
      P.PushNotifications.addListener('pushNotificationActionPerformed', function (ev) {
        try { var url = ev && ev.notification && ev.notification.data && ev.notification.data.url; if (url) location.assign(url); } catch (e) {}
      });
      P.PushNotifications.checkPermissions().then(function (st) {
        if (st && st.receive === 'granted') return P.PushNotifications.register();
        return P.PushNotifications.requestPermissions().then(function (r) {
          if (r && r.receive === 'granted') return P.PushNotifications.register();
        });
      }).catch(function () {});
    } catch (e) {}
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
