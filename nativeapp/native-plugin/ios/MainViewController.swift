import UIKit
import WebKit
import Capacitor

// App-Startseite (im Storyboard als customClass="MainViewController" gesetzt).
// Erbt das komplette Capacitor-Verhalten (WebView, Bridge, Plugins) und spielt
// zusätzlich den FitInnNative-Shim in die WebView ein – er verbindet die Web-App
// mit dem nativen FitInnNativePlugin (Puls-Gurt / GPS / Apple Health).
// Der Shim ist bewusst DIREKT hier eingebettet, damit keine zusätzliche
// Ressourcen-Datei ins Bundle muss.
class MainViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        guard let webView = self.bridge?.webView else { return }
        let js = MainViewController.fitInnBridgeJS
        // Für alle künftigen Seitenaufbauten (document-start) …
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        // … und einmal für die bereits geladene erste Seite.
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // Baut aus Capacitor.Plugins.FitInnNative das globale window.FitInnNative,
    // das die Mitglieder-App erwartet (Vertrag: docs/NATIVE-BRIDGE.md). Mischt sich
    // additiv in ein evtl. vorhandenes FitInnNative (Face-ID/Push bleiben erhalten).
    static let fitInnBridgeJS = """
    (function () {
      function plugin() {
        return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FitInnNative) || null;
      }
      if (!plugin()) return;
      var api = window.FitInnNative || {};
      api.isNative = true;
      api.__ver = 3;
      api.platform = (window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || api.platform || 'ios';
      api.available = Object.assign({}, api.available || {}, { hr: true, geo: true, health: true });
      var hrCb = null, hrBound = false;
      api.startHeartRate = function (cb) {
        hrCb = cb;
        if (!hrBound) { hrBound = true; plugin().addListener('heartRate', function (d) { if (hrCb && d && d.bpm) hrCb({ bpm: d.bpm, rr: d.rr || [] }); }); }
        return plugin().startHeartRate();
      };
      api.stopHeartRate = function () { hrCb = null; try { plugin().stopHeartRate(); } catch (e) {} };
      var geoCbs = {}, geoNext = 1, geoBound = false;
      function bindGeo() {
        if (geoBound) return; geoBound = true;
        plugin().addListener('location', function (d) { var cb = d && geoCbs[d.watchId]; if (cb) cb({ lat: d.lat, lng: d.lng, alt: d.alt, acc: d.acc }); });
      }
      api.getPosition = function () { return plugin().getPosition(); };
      api.watchPosition = function (cb) { bindGeo(); var id = geoNext++; geoCbs[id] = cb; plugin().watchPosition({ watchId: id }); return id; };
      api.clearWatch = function (id) { delete geoCbs[id]; try { plugin().clearWatch({ watchId: id }); } catch (e) {} };
      api.healthAuth = function () { return plugin().healthAuth(); };
      api.getHealthWorkouts = function (sinceTs) { return plugin().getHealthWorkouts({ sinceTs: sinceTs || 0 }); };
      api.saveHealthWorkout = function (s) { return plugin().saveHealthWorkout(s || {}); };
      window.FitInnNative = api;
    })();
    """
}
