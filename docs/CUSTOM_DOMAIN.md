# Eigene Subdomain einrichten: `mitglieder.fit-inn-trier.de`

Ziel: Den Mitgliederbereich (und das Widget) unter einer eigenen Subdomain
ausliefern statt unter `anwesend.vercel.app`.

**Wichtigster Nebeneffekt:** Die Online-Kündigung läuft über die Magicline
Connect API, die einen gültigen **reCAPTCHA-Token** verlangt. Der reCAPTCHA-
Schlüssel gehört Magicline und ist für `fit-inn-trier.de` freigeschaltet
(darüber kündigt die Hauptwebsite). Google reCAPTCHA deckt **First-Level-
Subdomains automatisch** mit ab – `mitglieder.fit-inn-trier.de` ist damit
voraussichtlich **ohne weitere Magicline-Anfrage** gültig.
(`anwesend.vercel.app` ist es nicht → dort schlägt reCAPTCHA fehl.)

---

## Schritt 1 – Domain in Vercel hinzufügen
1. Vercel → Projekt **anwesend** → **Settings → Domains**.
2. `mitglieder.fit-inn-trier.de` eintragen → **Add**.
3. Vercel zeigt den nötigen DNS-Eintrag an (i. d. R. ein **CNAME**).

## Schritt 2 – DNS-Eintrag setzen (beim Domain-/DNS-Anbieter von fit-inn-trier.de)
Lege den von Vercel angezeigten Eintrag an, üblicherweise:

```
Typ:   CNAME
Name:  mitglieder            (bzw. mitglieder.fit-inn-trier.de)
Wert:  cname.vercel-dns.com  (GENAU den Wert nehmen, den Vercel anzeigt)
TTL:   3600 / Auto
```

> Falls dein DNS-Anbieter auf der Subdomain kein CNAME erlaubt, zeigt Vercel
> alternativ A/AAAA-Records an – dann diese verwenden.

## Schritt 3 – SSL abwarten
Nach dem DNS-Eintrag stellt Vercel automatisch ein Let's-Encrypt-Zertifikat
aus (wenige Minuten). In **Settings → Domains** sollte `mitglieder.fit-inn-trier.de`
auf **Valid / Production** stehen.

## Schritt 4 – Testen
1. `https://mitglieder.fit-inn-trier.de/mitglieder` öffnen, einloggen.
2. Kündigungs-Funnel bis zum Ende klicken.
3. Erwartung (Diagnose-Box, solange aktiv):
   - `hadToken: true`, `tokenLen` > 0  → reCAPTCHA liefert jetzt einen Token
   - `attemptedDirect: true`, `path: "direct"`, `connectStatus: 200`
   - Meldung: **„Kündigung wurde verbindlich eingereicht – zum …"**

> ⚠️ **Achtung – echte Kündigung!** Sobald reCAPTCHA greift, wird die Kündigung
> **wirklich in Magicline eingetragen**. Zum Testen ein **Test-Mitglied** nutzen
> oder die Kündigung danach im Magicline-Backend wieder zurücknehmen.

## Falls reCAPTCHA trotzdem „Ungültige Domain" zeigt
Dann hat Magicline nur eine spezifische Host-Variante (z. B. `www.fit-inn-trier.de`)
statt der Apex-Domain hinterlegt. Kurze Anfrage an Magicline:

> Betreff: Connect API – reCAPTCHA-Domain ergänzen
> Bitte fügt für unseren Connect-API-/reCAPTCHA-Schlüssel (Tenant `fit-inn-trier`,
> Studio 1210005460) die Domain **`mitglieder.fit-inn-trier.de`** hinzu. Danke!

---

## Code-Hinweise (für Entwickler)
- Die App ist **host-agnostisch**: alle Frontend→Backend-Calls sind relativ
  (`/api/...`), die Member-Session ist ein Bearer-Token im `sessionStorage`
  (keine Cookie-Domain-Bindung), CORS steht auf `*`. Ein Hostwechsel erfordert
  **keine** Code-Änderung. (Auditiert, 0 Blocker.)
- `sessionStorage` ist pro Origin → auf der neuen Domain ist ein **erneuter
  Login** nötig (erwartetes Verhalten).
- Die Connect-Basis-URL ist über `ML_CONNECT_BASE` konfigurierbar
  (Default `https://<ML_TENANT>.api.magicline.com/connect/v1`).
- `anwesend.vercel.app` bleibt parallel erreichbar. Der 15-Minuten-Cron
  (`.github/workflows/record.yml`) ruft weiterhin `anwesend.vercel.app/api/record`
  – das funktioniert unverändert; optional später auf die Subdomain umstellen.
