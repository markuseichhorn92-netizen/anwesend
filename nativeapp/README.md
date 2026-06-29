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
