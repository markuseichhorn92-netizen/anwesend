# Bundeslebensmittelschlüssel (BLS 4.0) importieren

Der BLS ist Deutschlands amtliche Nährstoffdatenbank (Max Rubner-Institut).
Version 4.0 ist seit **16. Dezember 2025** unter **CC BY 4.0** frei – kommerziell
nutzbar, App-Entwicklung ausdrücklich erlaubt, einzige Auflage: Quelle nennen.
7.140 Lebensmittel, 138 Nährstoffe.

Er füllt die Lücke, die Open Food Facts (Verpackungs-/Barcode-Datenbank) lässt:
unverpackte Grundnahrungsmittel. Bis zum Import liefert die App die 105
kuratierten Alltags-Lebensmittel aus `lib/baseFoods.js`; nach dem Import wird die
Suche um den vollständigen BLS erweitert – über denselben Suchpfad, ohne weitere
Code-Änderung.

## 1. Datei herunterladen

1. Öffne im Browser: <https://www.openagrar.de/receive/openagrar_mods_00112643>
2. Lade die Hauptdatei **`BLS_4_0_Daten_2025_DE.xlsx`** herunter.

Alternativ genügt eine **CSV** (falls die XLSX Probleme macht): die XLSX in
Excel/LibreOffice öffnen und „Speichern unter → CSV (UTF-8)" wählen.

## 2. Konvertieren

```bash
node scripts/import-bls.js <pfad>/BLS_4_0_Daten_2025_DE.xlsx
```

Das Skript

- liest XLSX (ohne externe Abhängigkeit) oder CSV (`;`/`,`/Tab, deutsche Kommata),
- findet die Spalten über die BLS-Codes (`ENERCC`=kcal, `PROT625`=Eiweiß,
  `CHO`=Kohlenhydrate, `FAT`=Fett, `FIBT`=Ballaststoffe, `SUGAR`=Zucker,
  `FASAT`=ges. Fett, `NA`=Natrium → Salz),
- prüft jeden Eintrag per Atwater (kcal ≈ 4·Eiweiß + 4·KH + 9·Fett) und verwirft
  grobe Ausreißer mit Bericht,
- schreibt **`lib/data/bls-foods.json`**.

`lib/baseFoods.js` lädt diese Datei automatisch, sobald sie existiert. Fehlt sie,
bleibt es bei den kuratierten 105 – nichts bricht.

## 3. Prüfen und einspielen

```bash
npm run check      # Lint + Secret-Scan + Tests müssen grün bleiben
```

Danach `lib/data/bls-foods.json` committen (die Daten sind CC BY, dürfen ins Repo)
und deployen.

## Quellenangabe (Pflicht)

> Max Rubner-Institut (2025): Bundeslebensmittelschlüssel (BLS), Version 4.0.
> Karlsruhe. Lizenz: CC BY 4.0.

Diese Angabe gehört in die Datenquellen-Hinweise der App (analog zum
Open-Food-Facts-/ODbL-Hinweis), sobald der BLS live ist.
