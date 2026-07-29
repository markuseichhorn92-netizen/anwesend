# Gemeinsam kochen – Topf teilen mit prozentualem Anteil

Zwei (oder mehr) Mitglieder kochen **einen Topf** und tracken jeweils **nur ihren
Anteil** im eigenen Ernährungstagebuch – inspiriert von Nutrilize. Geteilt wird
über einen kurzen, eindeutigen Code (Link/QR), ganz ohne vorherige Freundschaft
(offener Teil-Code).

## Ablauf

1. **Erstellen:** In der App unter *Ernährung → Heute → Tools → „Gemeinsam kochen"*
   legt jemand einen Topf an – entweder per **FINN-Beschreibung** („ganzer Topf
   Chili con Carne für 4") oder mit **manuellen Gesamt-Nährwerten**. Gespeichert
   werden die Nährwerte des **ganzen Topfs**.
2. **Teilen:** Der Ersteller bekommt einen **Link + QR-Code + Code**. Der QR
   kodiert den Link (`/mitglieder?kochen=<CODE>`); zum In-Person-Scannen mit der
   Handykamera oder per WhatsApp verschicken.
3. **Beitreten:** Wer den Link öffnet (oder den QR scannt), sieht den Topf und
   tippt **„Mitmachen"**.
4. **Anteil festlegen:** Jede:r stellt per **Schieberegler** den eigenen Anteil
   in Prozent ein (z. B. 60 % / 40 %). Die App zeigt live, wie viele kcal das sind.
5. **Übernehmen:** Ein Tipp auf **„Meinen Anteil ins Tagebuch"** bucht den
   skalierten Anteil (Gesamt × Prozent) in das **eigene** Tagebuch.

## Technik

- **`lib/cookpot.js`** – Store-Modul (Upstash Redis, Präfix `cook:`), Konventionen
  wie `lib/social.js`/`lib/recipes.js`. Ein Topf hält Titel, Gesamt-Nährwerte,
  optionale Zutaten und je Teilnehmer:in Anzeigename + Prozent. Codes sind kurz
  (`cook:pot:<CODE>`, verwechslungsarmes Alphabet), eindeutig (SET NX) und laufen
  nach 30 Tagen ab (gleitende TTL bei Aktivität).
- **`api/member/nutrition.js`** – Aktionen `pot-create` / `pot-get` / `pot-join` /
  `pot-set-pct` / `pot-log` / `pot-leave`. `pot-log` schreibt über denselben
  Tages-Pfad wie `confirm-log`. Die client-sichere Sicht (`potView`) gibt **keine
  Mitglieds-IDs** nach außen, nur Anzeigename, Prozent, skalierter Anteil und ein
  `me`-Flag. Der prozentuale Anteil ist dieselbe Faktor-Skalierung wie beim
  portionsweisen Eintragen (`shareFor` = Gesamt × Prozent/100).
- **`mitglieder.html`** – Bottom-Sheet (`ernPotSheet`), Einstieg als Tool-Kachel,
  Deep-Link `?kochen=<CODE>` (in `magicGo`, aufgeräumt in `cleanMlt`). QR über die
  vorhandene lokale MIT-Bibliothek (`qrDraw` / `/assets/qrcode.min.js`), Teilen über
  `navigator.share` mit Copy-Fallback.

## Datenschutz

- Datensparsam: geteilt werden **nur** Topf-Titel, Nährwerte und je Person
  Anzeigename (Vorname + Initial) + Prozent. **Keine** Kontakt-/Mitgliedsdaten,
  **keine** fremden Tagebücher.
- Nur wer den Code hat, sieht den Topf; Codes sind unrätselbar und laufen ab.
- Teilnahme setzt ein eingerichtetes Ernährungsprofil voraus (Health-Einwilligung
  aus dem Onboarding) und ist erst **ab 16 Jahren** möglich (serverseitige Prüfung
  über das Magicline-Geburtsdatum). Serverseitige Autorisierung, `no-store`,
  Rate-Limits auf Erstellen/Beitreten.

## Tests

`tests/cookpot.test.js` prüft den kompletten Ablauf end-to-end (In-Memory-KV inkl.
`SET NX`): erstellen aus FINN-Items, Code + Teilen-Link, 60/40-Split, getrennte
Tagebücher, `me`-Flag ohne IDs, unbekannter Code, manueller Topf, Ersteller-Löschung.

## Später (Phase 2, optional)

- Echter In-App-QR-**Scanner** (Kamera) statt nur Link-Öffnen.
- Topf als wiederkehrende gemeinsame Mahlzeit speichern.
- Direkt aus einem Rezept (Bibliothek) einen Topf mit „wie viele Portionen gekocht?".
