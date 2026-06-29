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
    signIn: function () { return Promise.resolve({ ok: false, unavailable: true }); },
    available: { push: false, biometrics: false, apple: false, google: false },
  };
  window.FitInnNative = API;
  if (!isNative) return;   // im Browser ist hier Schluss.

  document.documentElement.classList.add('is-native-app');
  API.available.push = !!P.PushNotifications;
  API.available.biometrics = !!P.NativeBiometric;
  API.available.apple = !!(P.SignInWithApple || P.SocialLogin);
  API.available.google = !!(P.GoogleAuth || P.SocialLogin);

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

  // ── Push: Token registrieren ────────────────────────────────────────────────
  var pushReady = false;
  function setupPush() {
    if (!P.PushNotifications || pushReady) return;
    pushReady = true;
    try {
      P.PushNotifications.addListener('registration', function (t) {
        if (t && t.value) post('/api/push/register', { token: t.value, platform: API.platform }, true);
      });
      P.PushNotifications.addListener('pushNotificationActionPerformed', function (ev) {
        try {
          var url = ev && ev.notification && ev.notification.data && ev.notification.data.url;
          if (url) location.assign(url);
        } catch (e) {}
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
  function storeBiometric(t) {
    if (!P.NativeBiometric || !t) return;
    try { P.NativeBiometric.setCredentials({ username: 'member', password: t, server: BIO_SERVER }).catch(function () {}); } catch (e) {}
  }
  function clearBiometric() {
    if (!P.NativeBiometric) return;
    try { P.NativeBiometric.deleteCredentials({ server: BIO_SERVER }).catch(function () {}); } catch (e) {}
  }
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
