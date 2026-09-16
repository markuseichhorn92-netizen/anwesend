# FINN · Architektur der Multi-Agent-Plattform

## Leitsätze

1. **Bestand schützen.** Kein Magicline-Aufruf, kein Webhook, keine Auth wird
   ersetzt. FINN ist eine Schicht *über* `lib/members.js`, `lib/ml*.js`,
   `lib/connect.js`, `lib/inbox.js`, `lib/ai.js`.
2. **Agenten rufen nie HTTP.** Sie bekommen Tools aus `lib/finn/tools.js`; die
   Tools rufen `lib/finn/magicline.js`; das ruft die bestehenden Wrapper.
3. **Kein Scope wird angenommen.** `lib/finn/capabilities.js` merkt sich 403er
   je Scope; Tools ohne Scope werden nicht angeboten, und wenn doch ein 403
   kommt, gibt es eine ehrliche Antwort plus Team-Übergabe.
4. **Rechtlich/finanziell relevante Aktionen nur nach Bestätigung.** Risiko
   `HIGH` (Kündigung, Widerruf, Pause, Modul, Zahlung, Datenschutz) und
   `MEDIUM` (Termin buchen/stornieren, Kontaktdaten) laufen durch die
   Confirmation Engine; `LOW` (Lesen) direkt.
5. **Identität nur über Sessions.** Mitglied = Bearer-Session, WhatsApp =
   verifizierte Nummer, Team = Team-Session mit Capabilities. Kein Name im Chat
   identifiziert jemanden.
6. **Fail-closed.** Ohne KI-Anbieter, ohne Guardrail (Prod), ohne KV für
   Bestätigungen: FINN antwortet ehrlich und übergibt – kein Guardrail-freier Pfad.

## Modulübersicht (`lib/finn/`)

| Modul | Aufgabe |
|---|---|
| `kv.js` | Kleiner KV-Adapter über `lib/store.redisPipeline`; in Nicht-Produktion In-Memory-Fallback (Tests). In Produktion ohne KV: fail-closed für Bestätigungen. |
| `capabilities.js` | `can(scope)`, `noteForbidden(scope)`, `noteOk(scope)`, `status()`. Quelle: `ML_SCOPES` (deklariert), 403-Gedächtnis (`finncap:<SCOPE>`, 6 h), `MEMBER_LIST_READ` nie angenommen. |
| `mock.js` | Fixtures für `MAGICLINE_MODE=mock`. Kein Netz. Sichtbar markiert (`via:'mock'`). |
| `magicline.js` | **Tool-Layer / Service-Schicht.** Domänen `customer`, `contract`, `pause`, `modules`, `account`, `appointments`, `checkins`, `documents`, `access`, `comm`, `studio`, `leads`. Einheitliches Ergebnis `{ ok, forbidden, status, data, error, via, scope }`. Meldet 403 an `capabilities`. |
| `tools.js` | Tool-Registry: Name, Beschreibung, JSON-Schema, `risk`, `scopes`, `agents`, `run(ctx,args)`, optional `preview(ctx,args)` und `validate(ctx,args,result)`. `toolsFor(agent, ctx)`, `execute(ctx, name, args, {confirmed})`. |
| `confirm.js` | Confirmation Engine: `propose` → `finnact:<id>` (10 min), `confirm(ctx,id)` prüft Bindung (Mitglied, Kanal), führt aus, validiert, auditiert; `decline`. |
| `audit.js` | Audit-Log ohne Freitext-PII: `{ at, traceId, agent, tool, risk, actor, channel, status, via, code }`. Liste global + je Mitglied. |
| `timeline.js` | Agent-/CRM-Timeline je Kunde (`finntl:<cid>`): Ereignisse aus Webhooks, Tool-Aktionen, Übergaben. |
| `knowledge.js` | Wissensquellen mit Attribution: `lib/help.js`, `lib/articles.listPublished`, Öffnungszeiten, Feature-Regeln. `search(q, k)`, `contextFor(q)`. Live-Daten schlagen Wissensbasis (Prompt-Regel + Reihenfolge). |
| `memory.js` | Kurzzeit-Konversationszustand je Konversation (`finnconv:<channel>:<id>`, 12 h): Agent, offene Bestätigung, Themen. Langzeit: `lib/finnMemory.js` (Opt-in) unverändert. |
| `directory.js` | `MemberDirectoryProvider`-Interface. `KnownCustomerProvider` (Vorgänge/Tags/Leads im eigenen KV + gezielte Magicline-Suche für das Team). `MagiclineMemberDirectoryProvider` nur aktiv mit `MEMBER_LIST_READ`. |
| `models.js` | Provider-Abstraktion + Modell-Routing: `route` → kleines Modell, `chat` → Standard, `analysis` → Analyse-Modell. Delegiert an `lib/ai.messagesRaw` (Bedrock/EU, Guardrails). |
| `agents.js` | 13 Agenten: Name, Zweck, Systemtext, erlaubte Tools, Intent-Muster, Eskalationsregeln. |
| `router.js` | Intent-Erkennung: regelbasiert (deterministisch, testbar); optional Modell-Klassifikation bei Unsicherheit. Eskalationsregeln aus `lib/waAssistant.SENSITIVE`. |
| `runtime.js` | Ein Agent-Lauf: System-Prompt (Sicherheit, Persona, Wissen, Live-Kontext), Tool-Schleife (max. 6 Schritte), `LOW` sofort, `MEDIUM/HIGH` → Vorschlag, Ergebnis `{ text, link, confirm, handoff, agent, trace }`. |
| `orchestrator.js` | Einstieg `handle(ctx, message)`: Sicherheitsprüfung, Rate-Limit, Routing, Lauf, Übergabe, Metriken, Audit. Bestätigungen: `confirm(ctx, id)`, `decline(ctx, id)`. |
| `handoff.js` | Übergabe an Menschen: Vorgang mit Kontextpaket (Zusammenfassung, Agentenpfad, versuchte Tools, Grund), `notifyStudio`, Timeline. |
| `channels.js` | Gemeinsames Nachrichtenformat und Adapter-Helfer für Web/App, WhatsApp (Buttons), E-Mail (Entwurf), Team. |
| `metrics.js` | Zähler über `lib/opsStat` (`finn.turn`, `finn.tool.<name>`, `finn.confirm.*`, `finn.handoff`, `finn.error.*`), Latenz-Buckets, Trace-Ids. |

## Datenfluss (Mitglied, Web-Chat)

```
mitglieder.html ──POST /api/member/finn {message|action}──▶ api/member/finn.js
  Session (Bearer) ─▶ ctx {actor:{kind:'member', id}, channel:'web', securityScope:'member'}
  ─▶ orchestrator.handle
       ├─ AISecurity.assessText (Injection) ─▶ Ablehnung
       ├─ router.route(message) ─▶ Agent
       ├─ runtime.run(agent)  ─▶ models.chat ─▶ AI.messagesRaw (Bedrock + Guardrail)
       │      └─ tool_use ─▶ tools.execute
       │             ├─ LOW  ─▶ magicline.<domain>.<fn> ─▶ lib/ml*.js ─▶ Magicline
       │             └─ MEDIUM/HIGH ─▶ confirm.propose ─▶ {confirm:{id,preview,risk}}
       └─ Ergebnis {text, link?, confirm?, handoff?}
  Bestätigung: POST {action:'confirm', id} ─▶ confirm.confirm ─▶ tools.execute(confirmed)
               ─▶ validate (Zustand nachlesen) ─▶ audit ─▶ timeline
```

WhatsApp: `lib/waAssistant.handleInbound` ruft mit `FINN_AGENTS=1` zuerst
`channels.whatsapp` → Orchestrator; Bestätigungen kommen als Buttons
(`finn:ok:<id>` / `finn:no:<id>`) bzw. als Text „ja/nein" zurück.
E-Mail: eingehende Mitgliedsantworten erzeugen mit `FINN_EMAIL_DRAFT=1` einen
**Entwurf** als Team-Notiz – kein automatischer Versand.
Team: `api/team/finn.js` liefert Integrationsstatus, Event-Log, Audit, Timeline;
der Team-Assistent (`api/team/assistant.js`) bleibt.

## Schalter

| Variable | Wirkung |
|---|---|
| `FINN_AGENTS=1` | Orchestrator in `api/member/coach.js` und WhatsApp aktiv. Ohne: alles wie bisher; `api/member/finn.js` ist trotzdem nutzbar. |
| `MAGICLINE_MODE=mock` | Tool-Layer nutzt Fixtures, kein Netz. In Produktion ignoriert (Warnung im Health). |
| `ML_SCOPES` | Deklarierte Scopes (kommagetrennt). Nicht deklarierte gelten als `unknown`, nicht als vorhanden. |
| `FINN_AUTOMATIONS` | Automationen (`timeline`, `retention`, `vorgang`). Standard `timeline,retention`. |
| `FINN_LLM_ROUTER=1` | Modell-Klassifikation bei unsicherem Intent. Standard aus (regelbasiert). |
| `FINN_EMAIL_DRAFT=1` | Antwortentwurf bei eingehenden Mitglieder-Mails. |

## Sicherheit

- Prompt-Injection: `lib/aiSecurity.assessText` vor jedem Lauf; Tool-Ergebnisse
  als unvertrauenswürdig gekapselt (`hardenPayload`, bestehend).
- Rate-Limits je Kanal/Aktor (`M.rateLimit`), Tool-Ausführung je Aktor gedeckelt.
- Per-Agent-Tool-Permissions (Registry). Team-Endpunkte: `requireTeam` + `requireCap`.
- Kein API-Key im Frontend; keine Fehlerdetails an Kunden (`safeMessage`).
- Audit ohne Freitext, Logs ohne Prompt-/Gesundheitsinhalte.
- Mock-Modus in Produktion unwirksam.

## Reihenfolge der Umsetzung

Phase 1–2 (Analyse, Doku) → 3–4 (Tool-Layer, Capabilities, Mock) → 5–8
(Agenten, Orchestrator, Bestätigung, Audit) → 9–10 (Event Bus, Automationen) →
11–14 (Wissen, CRM, Kanäle, Team-Backend) → 15–17 (Tests, Observability,
Security-Review). Jede Phase: `npm run check` grün, eigener Commit.
