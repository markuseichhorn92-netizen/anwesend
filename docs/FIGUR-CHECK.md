# Figur-Check – die Mess-Journey fürs Mitglied

Der **Figur-Check** bringt die Erfolgskontrolle im Figurscout-Stil in die App:
Das Mitglied erfasst über die Zeit **Gewicht + Umfänge** (Taille, Hüfte, Brust,
Arm, Bein) und optional **Körperfett**, sieht seinen **Verlauf als Kurve** und
einen **Vorher-Nachher-Vergleich** (Start → aktuell je Messgröße).

Erreichbar über den **Coach-Bereich → Figur-Check** (Deep-Link `?go=figur`).

## Für wen / was kostet es

- **Frei für alle Mitglieder:** Werte erfassen, Verlauf, Kurven, Vorher-Nachher.
- **Premium (oder 1× Gratis-Kontingent):** die optionale **FINN-Auswertung**
  („FINN bewertet deinen Fortschritt") – eine kurze, wertschätzende Einordnung
  der Zahlen. Gate wie überall (`premium_required` → Upgrade-Screen).

## Warum ein eigener Bereich (nicht der Coaching-Check-in)?

Der bestehende Coaching-Check-in (`nutri:checkins`) ist an die 8-Wochen-Reise
gekoppelt (Einschreibung, 14-Tage-Takt, Stimmung/Umsetzung, Team-Einschleifung).
Der Figur-Check ist bewusst **schlicht und frei**: nur Maße, kein Programm,
keine Einschreibung. Deshalb eigener Store und eigener Screen – die beiden
Systeme beeinflussen sich nicht.

## Technik

- **`lib/figurcheck.js`** – Store `nutri:figur:<id>`, Validierung/Klemmung,
  `buildEntry` (≥1 Messwert Pflicht), `appendEntry` (1 Eintrag/Tag, chronologisch,
  gekappt auf 60), `summary` (Start/Aktuell/Delta + Serie je Messgröße),
  `reviewContext` (ziel-neutraler Kontext für die KI).
- **`api/member/figurcheck.js`** – `GET` Snapshot (Metrik-Defs, Verlauf,
  Vergleich, Premium/Quota), `POST save` / `delete` / `review`. Ohne KV:
  `available:false` (UI blendet aus).
- **`lib/ai.js` → `figurReview`** – sichere, ziel-neutrale Auswertung: lobt
  **niemals** extremen/schnellen Gewichtsverlust, benennt Stillstand neutral,
  erklärt Muskelaufbau (Gewicht hält, Umfänge sinken), verweist bei
  Auffälligkeiten aufs Team. Kein medizinischer Rat.
- **`mitglieder.html`** – Screen `figur` (`scrFigur`), SVG-Trendkurve
  (`figMiniChart`), Erfassen-Formular, Verlaufsliste; Profil-Eintrag; Deep-Link
  über `TITLES`.
- **DSGVO:** Der Figur-Check hängt an Export **und** „Alles löschen" der
  Ernährungsdaten (`api/member/nutrition.js`, `nutri:figur:<id>`).

## Datenschutz / Sicherheit

Reine Selbstvermessung, kein medizinisches Produkt. Werte werden serverseitig
geklemmt. Fotos werden (Stand jetzt) **nicht** gespeichert – bewusst nur Zahlen,
um Speicher/Datenschutz schlank zu halten (mögliche spätere Ausbaustufe).
