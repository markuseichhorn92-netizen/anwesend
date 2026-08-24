# MCP-Zugang für Support-Fragen

Damit eine Claude-Code-Sitzung Fragen wie *„hat Frau X gekündigt, und ist der
Vorgang durchgelaufen?"* selbst nachschlagen kann, statt sie durchzureichen.

**Endpunkt:** `POST https://mitglieder.fit-inn-trier.de/api/mcp`

---

## Was das ist – und was es ausdrücklich nicht ist

Hier fließen **Mitgliederdaten in eine KI-Sitzung**. Das ist der Grund, warum
dieser Zugang eng geschnitten ist und eng bleiben soll:

| | |
|---|---|
| **Lesen** | ja |
| **Schreiben** | nein. Kein Kündigen, kein Ändern, kein Senden. Es gibt schlicht kein solches Werkzeug. |
| **Gesundheitsdaten** | nein. Ernährung, Vitalwerte, InBody, Coach-Verläufe, Trainingspläne bleiben außen vor – Art. 9 DSGVO, das hat in einer Fehlersuche nichts verloren. |
| **Verzeichnis** | nein. Es gibt keine „alle Mitglieder"-Abfrage. Gesucht wird gezielt, höchstens 10 Treffer. |

Der Zugang hängt an einem **eigenen Token** (`MCP_TOKEN`), nicht am
Team-Passwort: er lässt sich einzeln zurückziehen, ohne das Team auszusperren.
Ohne Token ist der Endpunkt komplett aus (`503`).

**Jeder Zugriff hinterlässt eine Logzeile** – Werkzeug und Trefferzahl, keine
Namen:

```
mcp_zugriff {"tool":"mitglied_suchen","treffer":1}
```

Dass jemand nachsehen kann, ist nur vertretbar, solange es nachvollziehbar
bleibt. Die Zeile bitte nicht wegoptimieren.

---

## Einrichten

**1. Token erzeugen und in Vercel hinterlegen** (Projekt `anwesend` →
Settings → Environment Variables, **Production ankreuzen**):

```
MCP_TOKEN=<openssl rand -hex 32>
```

Danach **neu deployen** – Vercel übernimmt Variablen nur in ein neues
Deployment. Kontrolle über `GET /api/health`: die `deployment`-Kennung muss
sich geändert haben.

**2. In Claude Code hinzufügen:**

```bash
claude mcp add --transport http fitinn \
  https://mitglieder.fit-inn-trier.de/api/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

Für eine Sitzung im Web/Remote wird der Server über die Verbindungen des
Kontos hinterlegt, nicht lokal – dieselbe URL, derselbe Header.

**3. Prüfen:**

```bash
# ohne Token: 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  https://mitglieder.fit-inn-trier.de/api/mcp

# mit Token: Handschlag samt Werkzeugliste
curl -s -X POST -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  https://mitglieder.fit-inn-trier.de/api/mcp
```

| Antwort | Bedeutung |
|---|---|
| `503 not_configured` | `MCP_TOKEN` fehlt oder steckt im falschen Environment |
| `401 unauthorized` | Token falsch |
| Werkzeugliste | fertig |

---

## Die vier Werkzeuge

| Werkzeug | Wofür |
|---|---|
| `mitglied_suchen(suche)` | Name, E-Mail oder Mitgliedsnummer → Name, Mitgliedsnummer, interne ID (max. 10). Ohne Suchbegriff kommt nichts. |
| `mitglied_vertrag(id)` | Tarif, Beginn, Laufzeitende, Status, **Kündigungsdatum**, nächstmöglicher Termin |
| `mitglied_vorgaenge(id, art?)` | Vorgänge des Mitglieds: Art, Betreff, Status, Datum, Referenz. `art:"kuendigung"` filtert. |
| `vorgang_lesen(id, vorgangId)` | Der Verlauf eines Vorgangs – was genau wann passiert ist |

Die Trefferliste der Suche enthält bewusst **keine** E-Mail und keine
Telefonnummer: zum Weiterarbeiten reicht die ID.

### Typischer Ablauf

> „Hat Martha Regine Degens gekündigt?"

1. `mitglied_suchen("Degens")` → ID
2. `mitglied_vertrag(id)` → steht ein Kündigungsdatum drin?
3. `mitglied_vorgaenge(id, "kuendigung")` → kam sie über die App?
4. `vorgang_lesen(id, vorgangId)` → was ist im Verlauf passiert?

Schritt 2 und 3 zusammen beantworten auch den unangenehmen Fall: **Vorgang da,
aber kein Kündigungsdatum im Vertrag** – dann ist die Kündigung im
Mitgliederbereich eingegangen, aber nicht in Magicline angekommen.

---

## Bevor das dauerhaft läuft

Zwei Dinge gehören geklärt, und zwar von einem Menschen, nicht von mir:

- **Verzeichnis der Verarbeitungstätigkeiten (VVT).** Dieser Zugang ist eine
  neue Verarbeitung: Mitgliederdaten werden an einen KI-Dienstleister
  übermittelt. Er gehört in eure `docs/VVT-TOM.md` – mit Zweck (Support und
  Fehlersuche), Datenarten, Empfänger und Löschfristen.
- **AVV mit dem KI-Anbieter.** Steht ohnehin auf eurer offenen Liste; hier wird
  sie konkret.

Und eine praktische Regel: **Token zurückziehen, wenn er nicht gebraucht wird.**
Ihn zu entfernen ist eine Zeile in Vercel plus ein Redeploy – ein stehender
Zugang, den niemand nutzt, ist reines Risiko.

---

## Etwas erweitern?

Kann man – aber bitte bewusst. Die vier Werkzeuge decken den Fall ab, für den
der Zugang gedacht ist. Jedes weitere Werkzeug vergrößert, was eine KI-Sitzung
über eure Mitglieder erfährt. Insbesondere gilt: **Gesundheitsdaten und
schreibende Aktionen gehören hier nicht hinein**, auch nicht „nur kurz zum
Testen". Der Test `tests/mcp.test.js` hält beides fest und fällt durch, wenn es
jemand doch versucht.
