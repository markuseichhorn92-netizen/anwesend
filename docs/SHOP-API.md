# Shop-Schnittstelle: Mitglied erkennen, Bestellung ans Konto hängen

Für einen **externen** Shop (eigene Domain, eigenes Vercel-Projekt), der beim
Bezahlen wissen soll: *ist das ein Fit-Inn-Mitglied?* – und dessen Bestellung
später in der Mitglieder-App auftauchen soll.

**Basis-URL:** `https://mitglieder.fit-inn-trier.de`
**Endpunkt:** `POST /api/shop/partner`

---

## Das Wichtigste zuerst

**Server zu Server. Nie aus dem Browser.**
Der Schlüssel steckt im Backend des Shops (Next.js Route Handler, API-Route,
Serverless Function). Läge er im Browser-Code, könnte jede Besucherin damit
unser Mitgliederverzeichnis abfragen.

Deshalb setzt der Endpunkt **bewusst keine CORS-Header**. Ein `fetch` aus dem
Browser einer fremden Domain scheitert – das ist kein Fehler, das ist die
Absicherung. Wer sie umgehen will, hat den Aufbau missverstanden.

```
Shop-Browser  ──►  Shop-Backend  ──►  mitglieder.fit-inn-trier.de/api/shop/partner
                   (Schlüssel hier)
```

Verschiedene Domains und Vercel-Projekte sind dabei egal: es ist ein normaler
HTTPS-Aufruf von Server zu Server. Es braucht **keine** Vercel-Verknüpfung,
kein gemeinsames Projekt, kein Monorepo.

---

## Zugang

Im Shop-Projekt als Umgebungsvariablen (Vercel → Settings → Environment Variables):

```
FITINN_API_BASE=https://mitglieder.fit-inn-trier.de
FITINN_API_KEY=<Schlüssel, den Fit-Inn ausstellt>
```

Auf Fit-Inn-Seite dieselben Werte unter `SHOP_API_KEY` (mehrere kommagetrennt,
damit sich ein Schlüssel ohne Ausfall tauschen lässt).

Jeder Aufruf:

```
POST /api/shop/partner
Authorization: Bearer <FITINN_API_KEY>
Content-Type: application/json
```

Ist kein Schlüssel hinterlegt, antwortet der Endpunkt mit `503` – nicht mit
einer halb funktionierenden Auskunft.

---

## Wie erkennen wir das Mitglied?

### Weg A (Standard): Mitgliedscode

Das Mitglied sieht in der App unter **Shop** einen Code der Form
`FI-AB12-CD34` und trägt ihn im Kassenbereich in ein Feld
„Fit-Inn Mitgliedscode (optional)" ein.

```http
POST /api/shop/partner
{ "action": "resolve", "code": "FI-AB12-CD34" }
```

```jsonc
// Treffer
{ "ok": true, "member": true,
  "ref": "9f3c…",            // Referenz für alles Weitere
  "firstName": "Adriane",     // nur für die Anrede
  "discountPct": 10 }

// kein Treffer
{ "ok": true, "member": false }
```

**Warum das der Standardweg ist:** Der Code ist zufällig, nicht erratbar, und
das Eintragen ist eine bewusste Handlung des Mitglieds. Es entsteht kein
Abfragedienst für die Frage „wer trainiert bei Fit-Inn".

### Weg B (optional): E-Mail + Geburtsdatum

```http
POST /api/shop/partner
{ "action": "lookup", "email": "…", "dob": "1985-03-14" }
```

Antwort wie bei `resolve`.

**Standardmäßig ausgeschaltet** (`403 lookup_disabled`). Erst wenn auf
Fit-Inn-Seite `SHOP_LOOKUP_BY_EMAIL=1` gesetzt ist, funktioniert er – und dann
mit einer harten Grenze von **5 Versuchen je E-Mail-Adresse und Stunde**.

Der Grund: ein Endpunkt, der auf „E-Mail + Geburtsdatum" mit ja/nein antwortet,
beantwortet damit auch, ob jemand Mitglied ist. Das ist eine
Gesundheits-/Zugehörigkeitsinformation, kein Komfortdetail. Wenn es der Weg
sein soll, dann bitte bewusst und mit dem Wissen, was daran hängt.

---

## Bestellung ans Konto hängen

Nach erfolgreicher Bestellung im Shop – **vom Shop-Backend**, nicht vom Browser:

```http
POST /api/shop/partner
{
  "action": "order",
  "ref": "9f3c…",
  "order": {
    "externalId": "shop-1001",          // Pflicht, eure Bestell-ID
    "number": "B-1001",
    "total": 59.98,
    "currency": "EUR",
    "status": "bezahlt",                 // offen|bezahlt|versandt|zugestellt|storniert|erstattet
    "items": [{ "title": "Protein Vanille", "quantity": 2, "unitPrice": 29.99 }],
    "placedAt": "2026-08-21T10:00:00Z",
    "url": "https://shop.example/bestellung/1001",   // nur https
    "tracking": "00340434…"
  }
}
```

```json
{ "ok": true, "gespeichert": true, "neu": true, "nummer": "B-1001", "status": "bezahlt" }
```

**Dieselbe `externalId` erneut zu schicken ist ausdrücklich richtig** – bei
jedem Statuswechsel (bezahlt → versandt → zugestellt). Der Eintrag wird
aktualisiert, nicht verdoppelt (`"neu": false`).

Eine `externalId`, die schon zu einem anderen Konto gehört, wird abgelehnt
(`belongs_to_other`) – so lässt sich eine fremde Bestellung nicht umhängen.

### Bestellungen lesen

```http
{ "action": "orders", "ref": "9f3c…", "limit": 20 }
→ { "ok": true, "bestellungen": [ … ] }
```

Damit kann der Shop denselben Verlauf zeigen wie die App.

---

## Fehler

| Antwort | Bedeutung | Was tun |
|---|---|---|
| `503 not_configured` | kein Schlüssel auf Fit-Inn-Seite | bei Fit-Inn melden |
| `401 unauthorized` | Schlüssel fehlt oder falsch | `FITINN_API_KEY` prüfen |
| `429 rate_limited` | zu viele Anfragen | zurückhalten, später erneut |
| `403 lookup_disabled` | E-Mail-Suche nicht freigeschaltet | Weg A verwenden |
| `200 { ok:false, error:'unknown_ref' }` | Referenz unbekannt/abgelaufen | neu auflösen |
| `200 { ok:true, member:false }` | kein Mitglied | ganz normal weiter, ohne Rabatt |

**`member:false` ist kein Fehler.** Der Kauf muss auch ohne Mitgliedschaft
funktionieren – und ohne dass die Person merkt, dass etwas geprüft wurde.

---

## Was der Shop NICHT bekommt

Bewusst nur `ref`, `firstName`, `discountPct`. **Kein** Nachname, keine
Mitgliedsnummer, keine E-Mail, keine Adresse, kein Vertrag, keine Trainingsdaten
– und nicht unsere interne Kennung, sondern eine bedeutungslose Referenz.

Was der Shop nicht hat, kann er nicht verlieren. Bitte auch nicht darum bitten,
das zu erweitern, ohne dass klar ist wofür.

---

## Beispiel (Next.js Route Handler im Shop)

```js
// app/api/fitinn/route.js  – LÄUFT AUF DEM SERVER
async function fitinn(body) {
  const r = await fetch(process.env.FITINN_API_BASE + '/api/shop/partner', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.FITINN_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function POST(req) {
  const { code } = await req.json();
  const r = await fitinn({ action: 'resolve', code });
  // Nur weitergeben, was die Kasse braucht - die ref bleibt auf dem Server.
  return Response.json({
    member: !!r.member,
    firstName: r.firstName || null,
    discountPct: r.discountPct || 0,
  });
}
```

Die `ref` gehört in die Sitzung bzw. an die Bestellung im Shop-Backend – **nicht**
in die Antwort an den Browser.

---

## Rechtliches, kurz und ernst gemeint

Der Shop erfährt, dass jemand Mitglied eines Fitnessstudios ist. Das ist eine
personenbezogene Information über eine Vereinsmitgliedschaft im weiteren Sinne
und gehört in die Datenschutzerklärung des Shops – mit Zweck („Mitgliederrabatt
und Bestellübersicht in der Fit-Inn-App"), Rechtsgrundlage und Empfänger.

Außerdem nötig, bevor das live geht:

- **AVV** zwischen Shop-Betreiber und Fit-Inn (bzw. Klärung, wer wofür
  Verantwortlicher ist – bei getrennten Unternehmen sind es meist zwei).
- **Einwilligung oder klarer Hinweis** an der Stelle, wo der Code eingegeben
  wird: „Wir prüfen deine Mitgliedschaft bei Fit-Inn Trier, um den
  Mitgliederrabatt zu gewähren und die Bestellung in deiner App anzuzeigen."
- Der Code darf **nie Pflichtfeld** sein.

---

## Prüfen, ob es läuft

```bash
# Erwartung ohne Schlüssel: 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"action":"resolve","code":"FI-AAAA-AAAA"}' \
  https://mitglieder.fit-inn-trier.de/api/shop/partner

# Mit Schlüssel und echtem Code: {"ok":true,"member":true,…}
curl -s -X POST \
  -H "Authorization: Bearer $FITINN_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"action":"resolve","code":"FI-AB12-CD34"}' \
  https://mitglieder.fit-inn-trier.de/api/shop/partner
```

Welcher Stand gerade läuft: `GET /api/health` nennt den ausgerollten Commit.
