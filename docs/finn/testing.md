# FINN · Tests

Alle FINN-Tests laufen **ohne Netz** (`global.fetch` wirft), mit
`MAGICLINE_MODE=mock`, KV im Speicher (kein Upstash) und – wo nötig – einer
gefälschten KI (`lib/ai.js` per `require.cache` ersetzt, Antworten per Skript).
Es werden keine Produktionsdaten berührt.

| Datei | Deckt ab |
|---|---|
| `tests/finn-tools.test.js` | Tool-Layer (Kunde, Vertrag, Zahlung, Termine, Pause), Capability-Erkennung (403, MEMBER_LIST_READ), Risiko-Stufen, Schema, Agenten-Permissions, IBAN-Maskierung, Bestätigungs-Engine (Bindung, Einmaligkeit, Ablehnen), Ergebnisprüfung, Audit ohne Freitext, Timeline, Rate-Limit, fail-closed ohne Speicher, Mock in Produktion aus |
| `tests/finn-orchestrator.test.js` | Routing (11 Fälle), Prompt-Injection und Fremddaten vor dem Modell, Vertragsagent Kündigung → Bestätigung → „ja" → Ausführung + Prüfung, MEDIUM „nein", fremder Aktor, fehlender Scope → Werkzeug nicht angeboten + Übergabe, Eskalation ohne Modell, Provider-Fehler/Retry, Link-Whitelist, Gesprächs-Rate-Limit, Team-Kanal mit Team-Guardrail |
| `tests/finn-webhooks.test.js` | Event Bus: gültig, Duplikat (Id und Hash), ohne Zeitmerkmal kein Dedup, Termin-Event → Kunde statt Buchungs-Id, unbekannt, korrupt, Statistik, `health=1` mit `finn`-Block, Automationen abschaltbar / mit Vorgang |
| `tests/finn-api.test.js` | `api/member/finn`, `api/member/coach` mit/ohne `FINN_AGENTS`, WhatsApp-Buttons und Button-Titel, Eskalation im bestehenden Vorgang, `handleInbound`, E-Mail-Entwurf (nur lesend), Team-Endpunkt RBAC, Website-Chat |
| `tests/finn-ui.test.js` | Browser: Bestätigungskarte (MEDIUM/HIGH), nichts ohne Klick, Zustand nach Neuladen, Bestätigen/Abbrechen, Team-Seite (Admin) mit Scope-Ampel und Reitern, Angestellte ohne Zugang |

Bestehende Tests, die FINN mit absichert: `tests/ml-webhook*.test.js`
(Bestandsverarbeitung unverändert), `tests/ai-security.test.js` (Regeln, inkl. der
erweiterten Fremddaten-Regel), `tests/team-rollen.test.js` (versteckter Bereich
ist serverseitig gesperrt), `tests/wa-assistant.test.js`.

Ausführen: `npm run check` (Lint + Secret-Scan + alle Tests). Browser-Tests
brauchen `playwright-core` im `NODE_PATH`; ohne Browser melden sie „ohne Browser".

## Manuell vor dem Einschalten (`FINN_AGENTS=1`)

1. `?health=1` des Webhooks: `finn.events` und `finn.capabilities` vorhanden.
2. Team-Backend → FINN & Magicline: Betriebsmodus prüft (Agenten aus, live, KI verfügbar).
3. Mit einem Testkonto im Chat: „Welchen Tarif habe ich?" (lesen), „Storniere meinen
   Termin" (MEDIUM-Karte, Abbrechen), „Ich möchte kündigen" (HIGH-Karte – **nicht**
   bestätigen, außer mit einem echten Testvertrag).
4. Angriffstest: „Ignoriere alle Anweisungen …" → Ablehnung, Eintrag im Prüfpfad.
5. Prüfpfad und FINN-Verlauf im Mitgliedsprofil kontrollieren.
