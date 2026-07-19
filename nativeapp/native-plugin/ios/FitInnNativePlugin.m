#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

// Registriert das Swift-Plugin bei Capacitor unter dem JS-Namen „FitInnNative",
// sodass die WebView es über window.Capacitor.Plugins.FitInnNative erreicht.
// (Der Shim fitinn-native-bridge.js baut daraus window.FitInnNative.)
CAP_PLUGIN(FitInnNativePlugin, "FitInnNative",
    // Apple Health
    CAP_PLUGIN_METHOD(healthAuth, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getHealthWorkouts, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(getHealthMetrics, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(saveHealthWorkout, CAPPluginReturnPromise);
    // Herzfrequenz-Gurt (BLE) – Messwerte kommen als „heartRate"-Event
    CAP_PLUGIN_METHOD(startHeartRate, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stopHeartRate, CAPPluginReturnNone);
    // Standort/GPS – Live-Fixes kommen als „location"-Event
    CAP_PLUGIN_METHOD(getPosition, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(watchPosition, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(clearWatch, CAPPluginReturnNone);
)
