# Eigene App für das Mitgliederportal (iOS + Android)

**Ziel:** Eine eigene Fit-Inn-App im App Store und im Play Store – als **Live-URL-Wrapper**
um das bestehende Portal (`https://mitglieder.fit-inn-trier.de`), erweitert um
**Push-Benachrichtigungen**, **„Mit Apple/Google anmelden"** und **biometrische Entsperrung**
(Face ID / Fingerabdruck).

Diese Anleitung ist für jemanden geschrieben, der **noch nie** eine App veröffentlicht hat.
Du brauchst sie nicht an einem Tag durchzuziehen – arbeite die Abschnitte der Reihe nach ab.

---

## 0. Wie das technisch funktioniert (in einfach)

- Die App ist im Kern eine **schlanke Hülle** (Capacitor), die beim Start direkt deine
  Live-Webseite lädt. **Du pflegst weiterhin nur das Portal** – jede Änderung am Portal ist
  sofort auch in der App sichtbar, **ohne neues App-Update**.
- Drei Dinge kann eine Webseite allein nicht, eine App aber schon. Genau die holen wir nativ:
  1. **Push** auch wenn die App zu ist,
  2. **Face ID / Fingerabdruck** zum Entsperren,
  3. **„Mit Apple/Google anmelden"** über die nativen Dialoge (im Browser/WebView ist das
     teils blockiert – nativ funktioniert es).
- Die App und das Portal reden über eine kleine **Brücke** (`/assets/native.js`), die schon
  im Repo liegt. Im normalen Browser tut sie nichts; in der App schaltet sie die nativen
  Funktionen frei.

**Wichtig:** Das alles ist bereits vorbereitet und **„schläft", bis du es konfigurierst**.
Solange du die unten genannten Schlüssel nicht in Vercel hinterlegst, ändert sich am Portal
nichts – Push/Apple/Google sind einfach inaktiv.

---

## 1. Was im Repo schon fertig ist

Du musst am Server-Code nichts mehr programmieren. Diese Teile sind bereits eingebaut:

| Bestandteil | Datei | Zweck |
|---|---|---|
| Push-Versand (FCM) | `lib/push.js` | sendet Pushes über Firebase – ein Weg für iOS **und** Android |
| Token-Registrierung | `api/push/register.js` | App meldet ihr Geräte-Token an, dem Mitglied zugeordnet |
| Push-Auslöser | `lib/studioReply.js` | wenn das Team antwortet, bekommt das Mitglied zusätzlich einen Push |
| Apple/Google-Login | `api/member/native-login.js` | prüft das ID-Token nativ und meldet das Mitglied an |
| ID-Token-Prüfung | `lib/oauthVerify.js` | verifiziert Apple/Google-Tokens kryptografisch |
| Native-Brücke | `assets/native.js` | verbindet Portal ↔ App (Push, Biometrie, Apple/Google) |
| Deep-Links (optional) | `api/well-known/*` | `apple-app-site-association` / `assetlinks.json` |
| App-Hülle | `nativeapp/` | das Capacitor-Projekt (Live-URL-Wrapper) |

Die App-Hülle liegt in **`nativeapp/`** und ist vom Vercel-Deployment ausgeschlossen
(`.vercelignore`) – sie wird **lokal auf deinem Rechner** gebaut, nicht auf Vercel.

---

## 2. Voraussetzungen

**Konten (hast du beide schon):**
- Apple Developer Program – **99 €/Jahr** (für den App Store zwingend).
- Google Play Developer – **einmalig 25 $** (für den Play Store zwingend).

**Rechner & Programme:**
- **iOS lässt sich NUR auf einem Mac bauen** (Xcode gibt es nur für macOS). Für Android
  reicht Mac, Windows oder Linux. Ohne Mac → siehe Tipp am Ende von Abschnitt 11.
- [Node.js](https://nodejs.org) (LTS) – hast du durch das Portal-Projekt vermutlich schon.
- [Xcode](https://apps.apple.com/de/app/xcode/id497799835) (Mac App Store, mehrere GB).
- [Android Studio](https://developer.android.com/studio).
- Ein kostenloses [Firebase](https://console.firebase.google.com)-Projekt (für Push).

**Namen, die wir durchgehend verwenden** (du kannst sie ändern, dann überall gleich):
- App-ID / Bundle-ID / Package: **`de.fitinn.portal`**
- App-Name: **Fit-Inn Trier**

---

## 3. Capacitor-Projekt aufsetzen (einmalig, ~15 Min.)

Im Terminal in den App-Ordner wechseln und die Abhängigkeiten installieren:

```bash
cd nativeapp
npm install
```

> `capacitor.config.json` ist schon fertig konfiguriert: `appId = de.fitinn.portal`,
> und `server.url` zeigt auf `https://mitglieder.fit-inn-trier.de` (= der Live-URL-Wrapper).

Plattformen hinzufügen:

```bash
npx cap add ios
npx cap add android
```

Das erzeugt die Ordner `ios/` und `android/` (lokal, nicht im Git – sie stehen in
`.gitignore`). Danach jedes Mal nach Plugin-/Config-Änderungen:

```bash
npx cap sync
```

Öffnen in der jeweiligen IDE:

```bash
npx cap open ios       # öffnet Xcode
npx cap open android   # öffnet Android Studio
```

**Erster Funktionstest:** In Xcode bzw. Android Studio auf einem Simulator/Gerät starten.
Es sollte direkt dein Portal erscheinen und der normale Login (E-Mail/WhatsApp/Handynummer +
Code) funktionieren. **Damit hast du schon eine lauffähige App** – der Rest sind die nativen
Extras.

---

## 4. App-Icon & Startbildschirm

- Lege ein quadratisches Icon (mind. **1024×1024 px**, ohne abgerundete Ecken, ohne
  Transparenz) bereit.
- Einfachster Weg: Paket `@capacitor/assets` nutzen:
  ```bash
  npm install -D @capacitor/assets
  # Icon nach nativeapp/assets/icon.png (1024x1024) und optional logo.png für den Splash
  npx @capacitor/assets generate --iconBackgroundColor '#0f1115' --splashBackgroundColor '#0f1115'
  npx cap sync
  ```
- Das erzeugt alle benötigten Icon-/Splash-Größen für iOS und Android automatisch.

---

## 5. Push-Benachrichtigungen einrichten

Wir nutzen **Firebase Cloud Messaging (FCM)** als **einzigen** Sende-Weg – Firebase stellt
iOS-Pushes über deinen Apple-Push-Schlüssel zu. Du brauchst also nur **eine** Versand-API.

### 5a. Firebase-Projekt anlegen
1. [Firebase Console](https://console.firebase.google.com) → **Projekt hinzufügen** (z. B.
   „Fit-Inn"). Google Analytics kannst du aus lassen.

### 5b. Apps in Firebase registrieren
2. **iOS-App hinzufügen:** Bundle-ID `de.fitinn.portal`. Lade die **`GoogleService-Info.plist`**
   herunter und ziehe sie in Xcode in den App-Ordner (Haken bei „Copy if needed").
3. **Android-App hinzufügen:** Package `de.fitinn.portal`. Lade die **`google-services.json`**
   herunter und lege sie in `android/app/` ab.

### 5c. iOS: Apple-Push-Schlüssel bei Firebase hinterlegen
4. Auf [developer.apple.com](https://developer.apple.com/account) → **Certificates,
   Identifiers & Profiles → Keys → +** → einen **APNs-Key** (Apple Push Notification service)
   erstellen. Du erhältst eine **`.p8`-Datei** sowie eine **Key-ID**; deine **Team-ID** steht
   oben rechts im Account.
5. Firebase → **Projekteinstellungen → Cloud Messaging → Apple-App → APNs-Authentifizierungsschlüssel
   hochladen**: die `.p8`, Key-ID und Team-ID eintragen.

### 5d. Server-Schlüssel (Service-Account) in Vercel hinterlegen
6. Firebase → **Projekteinstellungen → Dienstkonten → Neuen privaten Schlüssel generieren**.
   Es lädt eine **JSON** herunter. Daraus brauchst du drei Felder.
7. In **Vercel → Settings → Environment Variables** (Production) eintragen – **niemals ins
   Repo committen**:
   - `FCM_PROJECT_ID`  = Feld `project_id`
   - `FCM_CLIENT_EMAIL` = Feld `client_email`
   - `FCM_PRIVATE_KEY` = Feld `private_key` (kompletten mehrzeiligen Wert einfügen; die `\n`
     dürfen drinbleiben)
8. Neu deployen. Test: das Mitglied loggt sich in der App ein → die App registriert das Token
   automatisch. Wenn das Team auf einen Vorgang antwortet, kommt ein Push „Antwort vom Team".

### 5e. Plugin in der App
Das Push-Plugin ist bereits in `nativeapp/package.json` (`@capacitor/push-notifications`).
Auf iOS in Xcode unter **Signing & Capabilities** die Capability **Push Notifications**
(und **Background Modes → Remote notifications**) hinzufügen. Danach `npx cap sync`.

---

## 6. „Mit Apple anmelden"

> Pflicht-Hinweis von Apple: **Sobald** du einen anderen Social-Login (z. B. Google) anbietest,
> verlangt Apple zusätzlich „Mit Apple anmelden". Wir bauen daher beides ein.

1. [developer.apple.com](https://developer.apple.com/account) → **Identifiers** → deine App-ID
   `de.fitinn.portal` → Capability **Sign In with Apple** aktivieren.
2. In Xcode → **Signing & Capabilities → + Capability → Sign in with Apple**.
3. Plugin ist schon dabei (`@capacitor-community/apple-sign-in`). `npx cap sync`.
4. In **Vercel** setzen:
   - `APPLE_CLIENT_ID` = `de.fitinn.portal` (mehrere Bundles mit Komma trennen)
5. Fertig – die App schickt das Apple-ID-Token an `/api/member/native-login`, der Server prüft
   es und meldet das Mitglied über die **verifizierte E-Mail** an. Verbirgt der Nutzer seine
   E-Mail (Apples „E-Mail verbergen"), fällt die App automatisch auf den Code-Login zurück.

---

## 7. „Mit Google anmelden"

1. [Google Cloud Console](https://console.cloud.google.com) → dasselbe Projekt wie Firebase →
   **APIs & Dienste → Anmeldedaten → OAuth-Client-ID erstellen**:
   - eine **iOS**-Client-ID (Bundle-ID `de.fitinn.portal`),
   - eine **Android**-Client-ID (Package `de.fitinn.portal` + SHA-1-Fingerabdruck deines
     Signaturschlüssels, siehe Abschnitt 10),
   - eine **Web**-Client-ID (die wird vom Google-Plugin serverseitig als „aud" genutzt).
2. Plugin ist dabei (`@codetrix-studio/capacitor-google-auth`). Konfiguration laut dessen
   README: Web-Client-ID in `capacitor.config` bzw. `strings.xml`/`Info.plist` eintragen,
   dann `npx cap sync`.
3. In **Vercel** setzen:
   - `GOOGLE_CLIENT_ID` = alle relevanten Client-IDs, mit Komma getrennt (iOS, Android, Web).
4. Die App schickt das Google-ID-Token an `/api/member/native-login`; Zuordnung wie bei Apple
   über die verifizierte E-Mail, sonst Rückfall auf den Code-Login.

> **Sicherheit:** Ein Login per Apple/Google ist nur erfolgreich, wenn die **verifizierte
> E-Mail** genau einem Magicline-Konto entspricht. Bei Dubletten ohne klaren Vertrag verlangt
> die App weiterhin Mitgliedsnummer/Code – niemand kommt in ein fremdes Konto.

---

## 8. Biometrische Entsperrung (Face ID / Fingerabdruck)

1. Plugin ist dabei (`capacitor-native-biometric`). Es legt die Sitzung im **sicheren
   Schlüsselbund** des Geräts ab (iOS Keychain / Android Keystore) – nicht im Web-Speicher.
2. iOS braucht in Xcode einen Nutzungstext: **Info.plist → `NSFaceIDUsageDescription`**, z. B.
   *„Zum schnellen, sicheren Entsperren deines Mitgliedskontos."*
3. Ablauf (steckt schon in `assets/native.js`): Nach dem Login wird die Sitzung sicher
   hinterlegt; beim nächsten App-Start kann sich das Mitglied per Face ID/Fingerabdruck
   entsperren, statt erneut einen Code anzufordern.

---

## 9. Deep-Links (optional, aber empfohlen)

Damit ein Tipp auf eine Push-Nachricht direkt die richtige Seite öffnet bzw. `https`-Links die
App öffnen:

- In **Vercel** setzen (dann liefern `api/well-known/*` die Dateien automatisch aus):
  - `APPLE_APP_ID` = `TEAMID.de.fitinn.portal` (Team-ID + Bundle-ID)
  - `ANDROID_PACKAGE` = `de.fitinn.portal`
  - `ANDROID_SHA256` = SHA-256-Fingerabdruck deines Signaturschlüssels (mehrere mit Komma)
- iOS: in Xcode **Associated Domains** → `applinks:mitglieder.fit-inn-trier.de`.
- Android: Capacitor richtet den Intent-Filter beim `cap sync` ein; prüfe `AndroidManifest.xml`.

---

## 10. Signaturschlüssel & Fingerabdrücke (Android)

Für Google-Login und Deep-Links brauchst du die Fingerabdrücke deines Android-Signaturschlüssels.

- **Beim Entwickeln** (Debug-Key):
  ```bash
  keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey \
    -storepass android -keypass android
  ```
- **Für die Veröffentlichung** nutzt du **Play App Signing** (siehe Abschnitt 12). Den
  endgültigen SHA-256/SHA-1 findest du danach in der **Play Console → Release → Setup →
  App-Signatur**. Trage diese Werte dann in Google Cloud (OAuth) und in `ANDROID_SHA256` ein.

---

## 11. ⚠️ Apple-Richtlinie 4.2 „Minimum Functionality"

Apple lehnt reine „Webseite-in-einer-Hülle"-Apps manchmal ab (Guideline 4.2). So vermeidest du
das – wir liefern bewusst **echten nativen Mehrwert**:

- **Push-Benachrichtigungen** (haben wir),
- **Face ID / Touch ID** (haben wir),
- **„Mit Apple anmelden"** nativ (haben wir),
- nativer **Startbildschirm/Icon**, App-typische Navigation.

Beschreibe diese nativen Funktionen im Review-Hinweis (Abschnitt 12) ausdrücklich. In aller
Regel reicht das. (Android/Play ist hier unkritisch.)

**Kein Mac?** Du kannst iOS auch über einen Cloud-Mac-Dienst (z. B. MacStadium) oder eine
CI wie **Ionic Appflow**/**Codemagic** bauen lassen. Für den ersten Versuch ist ein echter Mac
aber am einfachsten.

---

## 12. Veröffentlichen – Schritt für Schritt

### A) Apple App Store

1. **App-ID & Bundle:** In Xcode unter *Signing & Capabilities* dein Team auswählen, Bundle-ID
   `de.fitinn.portal`. „Automatically manage signing" anlassen – Xcode legt die Zertifikate an.
2. **App in App Store Connect anlegen:** [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
   → **Apps → +** → Plattform iOS, Name „Fit-Inn Trier", Sprache Deutsch, Bundle-ID auswählen,
   SKU frei wählbar (z. B. `fitinn-portal`).
3. **Pflichtangaben ausfüllen:**
   - **Datenschutzrichtlinie-URL** (Pflicht) – Link auf eure Datenschutzseite.
   - **App-Datenschutz („Nutrition Labels"):** ehrlich angeben, welche Daten erhoben werden
     (z. B. E-Mail/Kontaktdaten zur Anmeldung, ggf. Geräte-Token für Push). Tracking: „Nein".
   - **Kategorie:** z. B. „Gesundheit & Fitness".
   - **Altersfreigabe** durchklicken.
4. **Screenshots:** Mindestens für **6,7″ iPhone** (z. B. iPhone 15 Pro Max) – am einfachsten
   im Simulator über ⌘+S aufnehmen. Ein paar aussagekräftige Portal-Screens (Login, Startseite,
   Auslastung, Postfach).
5. **Build hochladen:** In Xcode **Product → Archive**, dann im Organizer **Distribute App →
   App Store Connect → Upload**. Nach ein paar Minuten taucht der Build in App Store Connect auf.
6. **Build der Version zuweisen**, Beschreibung/Keywords/Support-URL eintragen.
7. **Review-Hinweise (sehr wichtig):** Lege einen **Demo-Zugang** an (Testmitglied) und schreibe
   im Feld *App Review Information* z. B.:
   > *„Login per Einmal-Code an E-Mail/WhatsApp. Test-Account: … . Native Funktionen: Push-
   > Benachrichtigungen, Face ID-Entsperrung, Sign in with Apple."*
   Das adressiert Guideline 4.2 direkt.
8. **Zur Prüfung einreichen.** Review dauert meist **1–3 Tage**. Bei Ablehnung bekommst du eine
   konkrete Begründung – meist mit einem Satz Antwort/Anpassung lösbar.
9. **TestFlight (optional, empfohlen):** Vor der echten Veröffentlichung den Build über
   **TestFlight** an dich/Kollegen verteilen und in Ruhe testen.

### B) Google Play Store

1. **Signaturschlüssel:** In Android Studio **Build → Generate Signed Bundle/APK → Android App
   Bundle (.aab)**. Beim ersten Mal einen **Upload-Keystore** erstellen – **gut sichern!**
   Aktiviere **Play App Signing** (Google verwaltet den finalen Schlüssel; du lädst nur das
   signierte Bundle hoch).
2. **App anlegen:** [play.google.com/console](https://play.google.com/console) → **App
   erstellen** → Name „Fit-Inn Trier", Deutsch, „App", „Kostenlos".
3. **Store-Eintrag:**
   - Kurz- und Vollbeschreibung,
   - **Icon 512×512**, **Feature-Grafik 1024×500**,
   - **Screenshots** (mind. 2 Telefon-Screenshots),
   - Kategorie „Gesundheit & Fitness".
4. **Pflicht-Fragebögen** (links im Menü, alles „Grün" bekommen):
   - **Datensicherheit** („Data safety"): ehrlich angeben (E-Mail zur Anmeldung, Push-Token …),
     Datenschutz-URL angeben.
   - **Inhaltseinstufung**, **Zielgruppe**, **App-Zugriff** (hier den Demo-Login angeben, damit
     der Prüfer reinkommt), **Werbung: Nein** (falls keine).
5. **Release erstellen:** Empfehlung – erst **Interner Test** (sofort verfügbar, nur für deine
   Tester), dann **Produktion**. Unter dem jeweiligen Track das **.aab** hochladen,
   Release-Notes eintragen, **Review starten**.
6. Erst-Review bei Google dauert oft **einige Tage** (neue Entwicklerkonten werden teils
   strenger/länger geprüft). Danach sind Updates meist in Stunden durch.

---

## 13. Welche Schlüssel wohin? (Spickzettel)

| Variable | Wo | Wofür |
|---|---|---|
| `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | **Vercel** | Push-Versand |
| `GOOGLE_CLIENT_ID` | **Vercel** | Google-Login prüfen (alle Client-IDs, Komma-getrennt) |
| `APPLE_CLIENT_ID` | **Vercel** | Apple-Login prüfen (Bundle-ID) |
| `APPLE_APP_ID`, `ANDROID_PACKAGE`, `ANDROID_SHA256` | **Vercel** | Deep-Links (optional) |
| `GoogleService-Info.plist` | **Xcode** (iOS-App) | Firebase iOS |
| `google-services.json` | **`android/app/`** | Firebase Android |
| APNs-`.p8` | **Firebase Console** | iOS-Push über FCM |
| Upload-Keystore (`.jks`) | **lokal sichern** | Android-Signatur |

**Alle geheimen Werte nur in Vercel / in der jeweiligen IDE – nichts davon ins (öffentliche) Repo.**

---

## 14. Realistischer Aufwand

- **Tag 1:** Capacitor aufsetzen, App läuft mit Portal (Abschnitte 3–4). *Erfolgserlebnis.*
- **Tag 2:** Push (Abschnitt 5) + Biometrie (Abschnitt 8).
- **Tag 3:** Apple/Google-Login (Abschnitte 6–7).
- **Tag 4:** Store-Einträge, Screenshots, Fragebögen, Einreichen (Abschnitt 12).
- **+ 1–5 Tage** Review-Wartezeit je Store.

Mach es ruhig in dieser Reihenfolge – jede Stufe ist für sich nutzbar. Wenn du an einem Punkt
hängst, sag mir genau, wo (Fehlermeldung/Screenshot), dann gehen wir ihn gemeinsam durch.
