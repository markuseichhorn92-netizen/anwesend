# Performance: Ladezeit, Ladeanimationen & Modularisierungs-Plan

Stand dieser Messung (Branch `improve/security-stability`):

| Seite | roh | gzip (so liefert Vercel aus) |
| --- | --- | --- |
| `mitglieder.html` (Startseite/App) | ~1.005 KB | ~253 KB |
| `team-backend.html` | ~479 KB | ~115 KB |

Vercel liefert statische HTML-Dateien automatisch komprimiert (gzip/brotli)
und mit Edge-Cache aus – über die Leitung gehen also ~250 KB, nicht 1 MB.
Nach dem ersten Besuch greift der Browser-Cache.

## Umgesetzter Ladezeit-Pass (dieser Branch)

Gemessen und behoben wurden die drei echten Bremsen beim Start – geprüft
durch `tests/perf-loading.test.js` (statisch) und einen Playwright-Live-Check:

1. **jsPDF nur noch bei Bedarf** (vorher: ~356 KB roh / ~118 KB gzip bei
   JEDEM Aufruf von Mitglieder-App UND Team-Backend, obwohl nur PDF-Exporte
   es brauchen). Jetzt lädt `loadPdfLib()` die Bibliothek erst beim Klick auf
   „Bestätigung herunterladen/per E-Mail"; währenddessen zeigen die Buttons
   einen Lade-Zustand, bei Fehlschlag eine klare Meldung mit Retry.
2. **Google-Fonts-CSS nicht mehr render-blockierend** (`media="print"` +
   `onload`, `display=swap`, `<noscript>`-Fallback): Der erste Paint wartet
   nicht mehr auf fonts.googleapis.com – Text erscheint sofort mit der
   System-Schrift und wechselt dann auf Archivo. Im Team-Backend lädt
   `assets/native.js` jetzt mit `defer`.
3. **Boot-Splash mit Skeleton-Karten** statt weißer Seite: `#app`/`#root`
   enthalten statisches Splash-Markup (Spinner + Schimmer-Skeletons, hell &
   dunkel, `prefers-reduced-motion` beachtet). Es ist ab dem ersten
   gestreamten Byte sichtbar und deckt Download, Parsen UND den ersten
   `loadMe()`-API-Roundtrip ab (die Mitglieder-App rendert erst nach
   `loadMe()`); das erste `render()` ersetzt es automatisch.

Die Bereichs-Screens (Training, Ernährung, Community, Termine …) hatten
bereits eigene „Lädt …"-Zustände je Datenquelle; die bleiben unverändert.

## Warum kein Code-Splitting in diesem Durchgang

Die App ist eine Single-File-IIFE mit gemeinsamem Zustand (`S`, `DATA`,
`ACT`, `render()`). Training, Ernährung und Community teilen sich Renderer,
Zustands-Felder und den delegierten Event-Handler. Ein „nur bei Öffnen
laden" erfordert:

1. Extraktion der Bereichs-Renderer in eigene Dateien (`assets/js/ern.js`,
   `training.js`, `social.js`) mit definierter Schnittstelle zu `S`/`DATA`/`ACT`,
2. einen Loader (`import()`/Script-Injection) inkl. Lade-/Fehlerzustand
   pro Bereich,
3. Anpassung der CSP (script-src bleibt 'self' – kompatibel),
4. vollständige Regression aller Bereichs-Tests.

Das ist ein eigenständiges, risikoreiches Refactoring (~4.500 der ~7.700
Zeilen betreffen die drei Bereiche) und widerspricht dem Auftrag „kleine,
überprüfbare Änderungen, kein Rewrite". Es ist deshalb bewusst NICHT in
diesem Branch enthalten.

## Empfohlener Fahrplan (je Schritt einzeln testbar)

1. **Statische Inhalte zuerst** (risikoarm, ~15–20 % der Startseite):
   Hilfe-Artikel, Coaching-Lektionstexte und Inspirations-Inhalte als
   JSON unter `assets/data/` auslagern und beim ersten Öffnen des Bereichs
   fetchen (Renderer bleiben unverändert).
2. **Ernährung als erstes Code-Modul** (größter Block, klarste Grenze:
   alles hinter `ERN_ON`).
3. **Training, dann Community** nach demselben Muster.
4. Messen nach jedem Schritt (dieses Dokument aktualisieren).

## Serverseitige Module

Die riskante Logik liegt bereits in klar benannten Server-Modulen
(`lib/members.js` Sitzungen/Magicline, `lib/teamAuth.js` + `lib/capabilities.js`
Team-Zugriff, `lib/cronAuth.js` interne Endpunkte, `lib/push.js`
Geräte-Zuordnung). Der Client enthält keine Sicherheitsentscheidungen –
alle Prüfungen laufen serverseitig (siehe docs/SECURITY.md).
