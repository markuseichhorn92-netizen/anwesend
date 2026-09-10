# Fit-Inn Trier – native App-Hülle (Capacitor)

Live-URL-Wrapper um das Mitgliederportal (`https://mitglieder.fit-inn-trier.de`) mit
nativem Push, Apple/Google-Login und biometrischer Entsperrung.

**Schnellstart:**

```bash
cd nativeapp
npm install
npx cap add ios        # nur auf einem Mac
npx cap add android
npx cap sync
npx cap open ios       # bzw. open android
```

`ios/`, `android/` und `node_modules/` werden lokal erzeugt und sind nicht im Git
(siehe `.gitignore`). Das Vercel-Deployment ignoriert diesen Ordner (`.vercelignore`).

👉 **Die vollständige Schritt-für-Schritt-Anleitung (inkl. Veröffentlichung im App Store
und Play Store) steht in [`../docs/EIGENE-APP.md`](../docs/EIGENE-APP.md).**

## In-App-Browser für Partner-Links (Upfit)

Die App öffnet das Upfit-Portal über `@capacitor/browser` – SFSafariViewController
auf iOS, Chrome Custom Tabs auf Android. Das Mitglied bleibt in der App, „Fertig"
führt zurück. Bewusst **kein** eingebettetes WebView: Google sperrt seinen Login
dort, und Upfit bietet „Mit Google registrieren".

Nach dem Aktualisieren des Repos einmal `npm install && npx cap sync` – das Plugin
steht in `package.json`, mehr Einrichtung braucht es nicht. Fehlt es in einem
älteren Build, öffnet die Web-App stattdessen den Systembrowser.
