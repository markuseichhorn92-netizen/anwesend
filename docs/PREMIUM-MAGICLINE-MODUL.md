# Coach Premium über ein Magicline-Zusatzmodul (SEPA)

> **Stand 10. September 2026: Das Abo-Modell ist abgeschaltet** (`FEATURE_ABO`
> nicht gesetzt). FINN und alle Coaching-Funktionen sind inklusive; das Modul wird
> in der App nicht mehr angeboten. Bestehende Buchungen bleiben in der
> Vertragsverwaltung sichtbar und **kündbar** – und sollten in Magicline geprüft
> werden, damit niemand für etwas zahlt, das es gratis gibt.

**Coach Premium** wird als **Magicline-Zusatzmodul** („App Premium") verkauft – das ist
der **einzige** Weg, Premium zu erwerben. Die Abrechnung läuft über den bestehenden
**Mitgliedsvertrag per SEPA-Lastschrift** – kein separater Zahlungsdienstleister, keine
Kartendaten in der App.

## Umfang von „Coach Premium"

Ein Premium schaltet die KI-/Coaching-Leistung in **allen drei Bereichen** frei
(ein und dasselbe Entitlement `nutri:prem:<id>`):

- **Ernährung:** Foto-Analyse, FINN-Chat, Wochenpläne, KI-Rezepte, Wochen-Auswertung.
- **Coach:** Wochen-Lektionen ab Woche 2, Vertiefungen, tiefe FINN-Analysen.
- **Training:** KI-Trainingsplan-Generierung **und die automatische Progression**
  (FINN plant die nächste Steigerung aus den protokollierten Einheiten,
  `action:'progress'`; Verlauf in `train:hist:<id>`).

Gratis bleiben: 5 FINN-Aktionen/Monat (geteiltes Kontingent über alle Bereiche),
Tracking, Übungs- & Rezept-Bibliothek, Verlauf — sowie die komplette
**Studio-Verwaltung** (Vertrag, Beitragskonto, Termine, Dokumente, Zusatzmodule) und
der allgemeine FINN-Support.

## 7-Tage-Test (Trial)

Hat das Magicline-Modul eine **Testphase** konfiguriert, wird sie in der App
automatisch mitgebucht (`bookTrialPeriod:true`). Premium ist sofort aktiv
(`status:'trialing'`, `trialEnd` = letzter Gratis-Tag); danach beginnt die
SEPA-Abbuchung. Wird **innerhalb der Testphase gekündigt**, wird zum Trial-Ende
gekündigt → **keine Abbuchung**.

## Rechtskonformer Kauf (deutsches Recht)

Der In-App-Kauf des Moduls erfüllt die Fernabsatz-Pflichten:

- **Button-Lösung (§312j Abs. 3 BGB):** Bestell-Button „Kostenpflichtig kaufen".
- **Preis sichtbar vor der Bestellung** (Pflicht) – ohne geladenen Preis kein Kauf.
- **Pflichtangaben unmittelbar davor (§312j Abs. 2):** Preis, Testphase, Laufzeit,
  Verlängerung, Kündigung, Zahlungsart (SEPA), Widerruf – aus Magicline `termInformation`.
- **Widerruf (§356 BGB):** ausdrückliche Einwilligung zur sofortigen Ausführung →
  bei sofortiger Nutzung ausgeschlossen; anteiliger Wertersatz bei Widerruf vor Erfüllung.

> ⚠️ Die konkreten Rechtstexte gehören **vor Go-Live anwaltlich geprüft**
> (siehe `docs/PREMIUM-RECHT.md`).

## Warum dieser Weg?

- **App Store / Play Store:** Premium ist eine über den Mitgliedsvertrag abgerechnete
  reale Leistung des Studios, kein klassischer In‑App‑Kauf digitaler Güter. Damit greift
  der IAP‑Zwang (Apple 3.1.1 / Google Play Billing) nicht – SEPA über den Vertrag ist erlaubt.
- **Ein Zahlungsmittel:** Das Mitglied zahlt Premium zusammen mit dem Beitrag, kein
  zweites Zahlprofil nötig.
- **Kündigung ohne Risiko:** Gekündigt wird **nur das Modul**, nie die Mitgliedschaft.

## Aktivierung

Der Weg ist **nur aktiv, wenn `ML_PREMIUM_MODULE_ID` gesetzt ist.** Ohne die Variable
kann in der App kein Premium hinzugebucht werden; bereits bestehende Berechtigungen
(z. B. Team‑Comp, `source:'team*'`) bleiben unberührt. Der Premium‑Status wird
server‑autoritativ aus dem Modulstatus abgeglichen (`lib/mlPremium.js`).

### 1. Zusatzmodul in Magicline anlegen

- Modul „App Premium" (frei wählbarer Name) anlegen.
- **Preis** + **monatliche Zahlungsfrequenz** (SEPA) hinterlegen.
- **Kündigungsfrist / Laufzeit** konfigurieren (bestimmt das Enddatum bei Kündigung).
- Die **Modul‑ID** notieren.

### 2. API‑Key‑Scopes

Der in `ML_API_KEY` hinterlegte Open‑API‑Key braucht:

- `MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_READ` – buchbare Module lesen.
- `MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_WRITE` – buchen & kündigen.
- `MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_CONTRACT_READ` – gebuchten Modul‑Vertrag per ID lesen (Status/Kündigungsdatum).
- `MEMBERSHIP_SELF_SERVICE_READ` – Kündigungsgründe lesen (Pflichtangabe beim Kündigen).

### Wichtig: Die Open API hat KEINE „gebuchte Module auflisten"-Funktion

Die Magicline Open API kann die gebuchten Zusatzmodule eines Mitglieds **nicht
auflisten** – es gibt nur *buchen* (liefert die Modul‑Vertrags‑ID zurück), *per ID
lesen* und *per ID kündigen*. Deshalb merkt sich die App die beim Kauf zurückgegebene
`additionalModuleContractId` (im Entitlement‑Datensatz) und nutzt sie später zum
Statusabgleich und zur Kündigung.

Konsequenz: **Nur ein Premium, das über die App gebucht wurde, ist auch in der App
kündbar.** Ein direkt in Magicline (Studio) gebuchtes Modul kennt die App nicht – dessen
Kündigung läuft dann über Magicline bzw. den automatischen Studio‑Fallback.

### 3. Umgebungsvariable setzen

```
ML_PREMIUM_MODULE_ID=<Modul-ID aus Magicline>
```

In Vercel unter *Project → Settings → Environment Variables* eintragen und neu deployen.

## Wie es funktioniert

- **Buchen (in der App):** `POST /api/member/modules { action:'book', moduleId }` bucht das
  Modul über die Self‑Service‑API. Bei Erfolg wird das Premium **sofort freigeschaltet**
  (`grantFromBooking`) und in den Entitlement‑Datensatz mit `source:'magicline'`
  geschrieben. So muss keine einzige Premium‑Gate‑Stelle geändert werden.
- **Kündigen (in der App):** `POST /api/member/modules { action:'cancel-premium' }`. Die
  **Modul‑Vertrags‑ID kommt server‑autoritativ** aus dem Entitlement (nicht vom Client),
  Kündigungsgrund + nächstmögliches Datum werden bestimmt, dann `ordinary-cancelation`.
  Premium läuft bis zum Modul‑Ende weiter (`until`), danach automatisch aus.
- **Studio‑Änderungen:** Bucht/kündigt das Studio das Modul direkt in Magicline, gleicht
  `reconcile()` den Status beim nächsten Laden des Ernährungsmoduls ab (30‑Min‑Cache).
- **Fallback:** Klappt die API nicht sauber (403/Fehler), wird der Wunsch als
  Inbox‑Vorgang + Studio‑Mail gesichert – er geht nie verloren.

Alle Magicline‑Zugriffe sind 403‑/fehler‑sicher: ohne Scope/ohne Modul passiert nichts
Schlimmes, der Studio‑Fallback bleibt bestehen.

## Test‑Checkliste

1. `ML_PREMIUM_MODULE_ID` gesetzt + Scopes aktiv + Modul mit SEPA‑Preis angelegt.
2. In der App: Ernährung → Premium‑CTA → *Premium hinzubuchen* → Premium ist aktiv.
3. Ernährung → Meine Daten → Premium‑Karte zeigt „Teil deiner Mitgliedschaft".
4. *Premium kündigen* → Zugang bleibt bis Modul‑Ende, danach aus. Mitgliedschaft läuft weiter.
5. In Magicline prüfen: Modul gebucht bzw. gekündigt, SEPA‑Abbuchung auf dem Vertrag.
