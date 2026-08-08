---
name: fitinn-design
description: >-
  Hausinterner Design-Geschmack für die Fit-Inn-Trier-App (mitglieder.html &
  team-backend.html). IMMER anwenden, wenn an der Oberfläche gearbeitet wird –
  neue Karten/Screens/Sheets, Umbauten, „schöner/ruhiger/übersichtlicher machen",
  Layout, Typografie, Abstände, Farben, Motion/Animation, Buttons, Listen, Badges,
  Empty-States. Auch dann nutzen, wenn der Nutzer nicht ausdrücklich „Design" sagt,
  sondern z. B. „bau eine Karte für X", „räum den Screen auf", „das sieht billig
  aus", „mach das hübscher". Sorgt für konsistenten, ruhigen, hochwertigen Look im
  bestehenden Vanilla-JS/Inline-CSS-Stack – ohne neue Abhängigkeiten.
---

# Fit-Inn Design – Hausgeschmack

Diese Skill hält die Oberfläche **konsistent, ruhig und hochwertig**. Sie ist aus
dem echten Designsystem der App destilliert und mit Prinzipien guter UI-Arbeit
angereichert (Herkunft s. u.). Ziel ist nicht „mehr Effekt", sondern **Klarheit,
Hierarchie und Zurückhaltung** – der Look, in den wir die App in den Aufräum-Phasen
gebracht haben.

## Wann greifen
Bei jeder sichtbaren Änderung in `mitglieder.html` (Mitglieder-App) oder
`team-backend.html` (Team-Backend): neue Fläche, Umbau, „ruhiger/übersichtlicher",
Karten, Listen, Buttons, Sheets, Badges, Empty-States, Farben, Typo, Motion.

## Harte Rahmenbedingungen (nicht verhandelbar)
Diese App ist bewusst **Vanilla-JS, Single-File-HTML, Inline-CSS, zero-dependency**.
- **Keine** neuen npm-Pakete, keine Frameworks, kein GSAP/Framer/Tailwind, kein
  externer Font-/Icon-Import. Alles inline, alles selbst.
- **Beide Themes** müssen funktionieren: nur die vorhandenen CSS-Tokens (`var(--…)`)
  verwenden, nie feste Hex-Werte für Text/Flächen hart eincoden (sonst bricht Dark
  Mode). Ausnahme: das Team-Backend nutzt JS-Konstanten (`TEAL`, `ORANGE`) – dort
  diese verwenden.
- Nach jeder UI-Änderung `npm run check` grün halten (Lint prüft u. a. tote
  Klickziele und Inline-Skripte). Jedes `data-act`/`data-*`-Klickziel braucht einen
  Handler.
- Icons: bestehende Inline-SVGs im Stil `stroke-width:2, stroke-linecap:round`
  weiterverwenden – keine Emoji als Funktions-Icons (Akzent-Emoji sparsam ok).

## Das Designsystem (Ground Truth – so ist es, nicht neu erfinden)

### Farb-Tokens (mitglieder.html `:root`, Light + Dark gespiegelt)
- Flächen: `--bg #eef2f3`, `--surface #fff`, `--surface-2 #f4f7f7`
- Text (Hierarchie über Helligkeit!): `--text #15171B` → `--text-2 #42454b` →
  `--text-muted #6b7780` → `--text-soft #8a929a`
- Primär: `--teal #0a4958` (Marke), `--ern-acc #0e6072`
- Akzent: `--apricot #E08C53` / `--apricot-2 #F6A964` (sparsam, für Highlights/CTA-Wärme)
- Status: ok `#1d7a3e` auf `#E7F6EC`, err `#b53a2c` auf `#FCEBEA`
- Rahmen: `--border #d6dee0`
- Team-Backend: `TEAL='#0a4958'`, `ORANGE='#E08C53'` (JS-Konstanten).

### Karten (das prägende Element)
- Fläche `var(--surface)`, `border-radius:20px` für große/Hero-Karten, 12–16px für
  kleinere Elemente/Zeilen.
- Signatur-Schatten (weich, teal-getönt, niedrige Deckkraft):
  `box-shadow:0 12px 30px rgba(4,33,40,.09)` (Familie `.07–.10`). Schatten immer in
  diesem Blaugrün-Ton `rgba(4,33,40,…)`, nie neutrales Schwarz.
- **Keine Karten in Karten.** Verschachtelte Panels flach halten (Trennlinie
  `1px solid #f0f3f4` statt zweitem Schatten).
- Innenabstand großzügig (16–24px), nicht gedrängt.

### Typografie
- Grundschrift **Archivo** (schon gesetzt, `font-family:inherit` erben lassen).
- **Wichtigste Hausregel – Hierarchie NICHT nur über Gewicht:** In der Codebase
  wird `font-weight:800/900` sehr oft benutzt und dadurch stumpf. Baue Hierarchie
  primär über **Größe + Farbe (`--text-soft`/`--text-muted`) + Abstand**, und reserviere
  `900` für echte Betonung (Zahlen, Titel). Sekundärtext: `600–700` in
  `--text-muted`/`--text-soft`. So entsteht Ruhe statt „alles schreit".
- Sektions-Label (Phase-3-Stil): `12px, 800, uppercase, letter-spacing:.5px,
  color:var(--text-soft)` mit `margin:26px 4px 10px`.
- Zahlen/Kennwerte dürfen groß und `900` sein (`font-size:28–46px, letter-spacing:-.5px`).
- **Kontrast (WCAG-AA):** `--text-soft` (#8a929a) hat auf hellem Grund nur ~3:1 –
  das reicht für **große/sekundäre Micro-Labels** (Uppercase-Label, Badges), aber
  **NICHT** für kleinen, wichtigen Fließtext. Für kleinen sekundären Text, den man
  wirklich lesen soll, `--text-muted` (#6b7780, ~4.5:1) oder dunkler nehmen. (Regel
  stammt aus dem Phase-C-Check mit impeccable – ein echter Befund.)

### Abstände / Rhythmus
- In 2er-Schritten denken (4/8/12/16/20/24px). Konsistenter vertikaler Rhythmus
  zwischen Blöcken (z. B. Sektionsabstand ~24px) schlägt individuelles Pixel-Tuning.
- Lieber **eine** klare Trennung (Abstand ODER Linie ODER Fläche) als drei
  gleichzeitig.

### Motion (vorhandenes Vokabular wiederverwenden)
- Enter-Easing: `cubic-bezier(.22,1,.36,1)` bzw. `cubic-bezier(.22,.61,.36,1)`
  (ease-out/abbremsend), Dauer **.2–.3s**. Für Sheets/Drawer das bestehende
  `transform`-Muster (`translateY(100%)→0`, `translateX(100%)→0`).
- Keyframe `fiUp` (fade + 14px hochziehen) für Screen-/Body-Eintritte ist gesetzt –
  nutzen statt Neues erfinden.
- **Nur bewegen, was Bedeutung trägt** (Eintritt, Auswahl, Zustandswechsel). Kein
  Dauer-Wackeln, keine Hover-Spielereien auf Touch. Immer `transform`/`opacity`
  animieren (GPU), nie `width/height/top` in Schleifen.

## Arbeitsprinzipien (der eigentliche Geschmack)

**1. Ruhe schlagen Effekt.** Der bestätigte Kurs (Aufräum-Phasen) ist *ruhiger*:
weniger Schatten-Wucht, weniger konkurrierende Betonung, klare Reihenfolge. Wenn
eine Fläche „billig" wirkt, liegt es meist an **zu viel** (zu viele Gewichte, Farben,
Ränder, Schatten), selten an zu wenig.

**2. Anti-Slop-Check.** Vermeide die generischen KI-Muster:
- kein Inter/Default-Sans (wir haben Archivo), keine Lila→Blau-Verläufe (wir sind
  Teal + Apricot), nicht jedes Element als Karte mit Schatten, keine 4 Rahmenfarben.
- Verläufe nur im Marken-Teal (`linear-gradient(165deg,#0e6072,#063540)`), sparsam.

**3. Hierarchie zuerst.** Bevor du stylst: Was ist das **eine** Wichtigste auf der
Fläche? Das bekommt Größe/Gewicht/Farbe. Alles andere tritt zurück (`--text-muted`).
Eine Fläche mit drei „wichtigsten" Dingen hat keine Hierarchie.

**4. Konsistenz vor Kreativität.** Neue Fläche = zuerst nach einer **bestehenden**
ähnlichen Karte suchen (`churnCardHTML`, `auslastungCardHTML`, `hdr()`,
Ernährungs-/Trainingskarten) und deren Muster spiegeln. Gleichheit wirkt hochwertiger
als jede Einzel-Idee.

**5. Empty-States gehören dazu.** Kein leeres Gerüst: leere Liste → freundlicher,
ruhiger Hinweis (Muster: zentriert, `--text-soft`, ein Satz, optional Emoji). Karten
mit „keine Daten" ganz ausblenden, wo sinnvoll (bestehendes Muster).

**6. Erst variieren, dann festlegen.** Bei größeren Flächen kurz 2 Varianten
durchdenken (kompakt vs. luftig; Zahl-zuerst vs. Label-zuerst) und die klarere
wählen – statt die erste Idee zu zementieren.

**7. Touch-Ergonomie.** Klickflächen ≥ 40px hoch, genug Abstand zwischen Zielen,
`cursor:pointer`, sichtbarer Aktiv-/Auswahlzustand. Mobile-first: prüfe schmale
Breite zuerst (die App läuft nativ auf iPhone/Android).

## Vor dem Abschließen: kurzer Durchgang
1. Nur Tokens/Marken-Konstanten benutzt? (Dark Mode testen-denken)
2. Hierarchie über Größe+Farbe+Abstand – nicht alles `800/900`?
3. Karten-Radius/Schatten aus der Signatur-Familie? Keine Karte-in-Karte?
4. Motion nur wo bedeutungstragend, mit Haus-Easing, `transform`/`opacity`?
5. Anti-Slop: kein Fremd-Font, kein Lila-Verlauf, nicht überladen?
6. Empty-State bedacht? Klickziele haben Handler? `npm run check` grün?

## Herkunft (destilliert, nicht eingebunden)
Die Prinzipien sind adaptiert aus öffentlich geteilten Design-Skills – als Wissen
übernommen, **ohne** deren Tooling/Dependencies (bewusst, wegen zero-dependency):
- **emilkowalski/skills** – Motion-Korrektheit (Easing, Zurückhaltung) & Apple-artige
  Ruhe.
- **leonxlnx/taste-skill** – Anti-Slop: stärkere Layout-/Typo-/Abstands-Hierarchie
  statt Boilerplate.
- **pbakaus/impeccable** – Erkennung generischer Muster (Default-Font, Klischee-
  Verläufe, Kontrast, „alles eine Karte").
`tenfoldmarc/website-builder-setup` bewusst NICHT übernommen (React/Framer – falscher
Stack).
