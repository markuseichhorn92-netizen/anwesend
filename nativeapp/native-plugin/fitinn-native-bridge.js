/*
 * fitinn-native-bridge.js
 * -----------------------------------------------------------------------------
 * Baut aus dem nativen Capacitor-Plugin (Capacitor.Plugins.FitInnNative) das
 * globale `window.FitInnNative`, das die Mitglieder-App erwartet
 * (Vertrag: docs/NATIVE-BRIDGE.md).
 *
 * WICHTIG: Der Shim MISCHT sich in ein evtl. schon vorhandenes window.FitInnNative
 * (z. B. für Face-ID-Login oder Push) hinein und überschreibt nur die hier
 * ergänzten Methoden (Puls, GPS, Health). Bestehende Methoden bleiben erhalten.
 *
 * Wird vom Swift-Plugin in load() als WKUserScript (document-start) injiziert.
 * Läuft rein defensiv: ohne natives Plugin passiert nichts -> Web-Fallback bleibt.
 */
(function () {
  function plugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FitInnNative) || null;
  }
  if (!plugin()) return;   // kein natives Plugin -> Web-Bluetooth/Web-GPS/Hinweis übernehmen

  var api = window.FitInnNative || {};
  api.isNative = true;
  api.__ver = 3;
  api.platform = (window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || api.platform || 'ios';
  // Diese drei Fähigkeiten liefert dieses Plugin – ergänzen (bestehende Flags wie wifi bleiben).
  api.available = Object.assign({}, api.available || {}, { hr: true, geo: true, health: true });

  // ── Herzfrequenz-Gurt ──────────────────────────────────────────────────────
  var hrCb = null, hrBound = false;
  api.startHeartRate = function (cb) {
    hrCb = cb;
    if (!hrBound) {
      hrBound = true;
      plugin().addListener('heartRate', function (d) { if (hrCb && d && d.bpm) hrCb({ bpm: d.bpm, rr: d.rr || [] }); });
    }
    return plugin().startHeartRate();          // Promise<{ok, error?}>
  };
  api.stopHeartRate = function () { hrCb = null; try { plugin().stopHeartRate(); } catch (e) {} };

  // ── Standort / GPS ──────────────────────────────────────────────────────────
  var geoCbs = {}, geoNext = 1, geoBound = false;
  function bindGeo() {
    if (geoBound) return;
    geoBound = true;
    plugin().addListener('location', function (d) {
      var cb = d && geoCbs[d.watchId];
      if (cb) cb({ lat: d.lat, lng: d.lng, alt: d.alt, acc: d.acc });
    });
  }
  api.getPosition = function () { return plugin().getPosition(); };   // Promise<{lat,lng,alt,acc}>
  api.watchPosition = function (cb) {
    bindGeo();
    var id = geoNext++;
    geoCbs[id] = cb;
    plugin().watchPosition({ watchId: id });
    return id;                                  // watchId (für clearWatch)
  };
  api.clearWatch = function (id) { delete geoCbs[id]; try { plugin().clearWatch({ watchId: id }); } catch (e) {} };

  // ── Apple Health / Google Fit ───────────────────────────────────────────────
  api.healthAuth = function () { return plugin().healthAuth(); };                                  // Promise<{ok,read,write}>
  api.getHealthWorkouts = function (sinceTs) { return plugin().getHealthWorkouts({ sinceTs: sinceTs || 0 }); }; // Promise<{ok,workouts}>
  api.saveHealthWorkout = function (s) { return plugin().saveHealthWorkout(s || {}); };            // Promise<{ok,extId}>

  window.FitInnNative = api;
})();
