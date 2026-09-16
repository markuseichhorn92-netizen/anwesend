# FINN · Agenten

Registry: `lib/finn/agents.js`. Routing: `lib/finn/router.js`. Jeder Agent bekommt
nur die Werkzeuge, die in seiner Liste stehen **und** die das Werkzeug selbst für
ihn freigibt (`agents` in `lib/finn/tools.js`) – beides muss passen.

| Agent | Zweck | Aktoren | Werkzeuge (Auszug) |
|---|---|---|---|
| `concierge` | Einstieg, allgemeine Fragen, Orientierung | Mitglied, Team | get_profile, get_contract, list_appointments, get_utilization |
| `member` | Stammdaten, Kontakt, Adresse, Einwilligungen | Mitglied, Team | update_contact (M), update_address (M), set_comm_prefs (M), list_checkins |
| `contract` | Vertrag, Kündigung, Widerruf, Pause, Module | Mitglied, Team | cancel_contract (H), withdraw_cancellation (H), withdraw_contract (H), create_pause (H), book_module (H), cancel_module (H) |
| `payment` | Beitragskonto, Mahnungen, Bankverbindung | Mitglied, Team | get_account, update_payment (H) |
| `appointment` | Terminarten, Slots, buchen, stornieren | Mitglied, Team | find_appointment_slots, book_appointment (M), cancel_appointment (M) |
| `access` | Check-in, Zugangsmedium | Mitglied, Team | list_access_media, block_access_medium (H), checkin_now (M), unblock (Team, H) |
| `document` | Vertragskopie, Nachweise | Mitglied, Team | list_documents |
| `studio` | Öffnungszeiten, Auslastung, Angebot | alle | get_studio_hours, get_utilization |
| `lead` | Interessenten, Probetraining | Website, Team | list_appointment_types, create_lead (M) |
| `support` | App-Probleme, Beschwerden | alle | get_profile, Übergabe |
| `crm` | Kundenkontext fürs Team | Team | get_profile, get_contract, get_account, list_appointments, list_checkins |
| `retention` | Kündigungsabsicht, Inaktivität | Mitglied, Team | get_contract, list_checkins, withdraw_cancellation (H) |
| `handoff` | Übergabe an Menschen | alle | handoff_to_team |

(M) = MEDIUM, (H) = HIGH – nur nach Bestätigung. Alle Agenten haben `search_knowledge`,
`get_studio_hours` und `handoff_to_team`.

## Routing

Regelbasiert, deterministisch, testbar (`tests/finn-orchestrator.test.js`):

1. **Eskalation** (Beschwerde, Anwalt, Inkasso, Rückerstattung, Notfall, „Mitarbeiter
   sprechen") → `handoff` ohne Modellaufruf, Übergabe mit Kontextpaket.
2. **Fachmuster** (Vertrag, Zahlung, Termin, Zugang, Dokument, Stammdaten, Studio,
   Support, Lead). „Überlege zu kündigen / zu teuer" → `retention`, „kündigen" → `contract`.
3. **Kontext**: kurze Folgeantworten („ja", „2", „morgen 10 Uhr") bleiben beim letzten Agenten.
4. **Standard**: `concierge` (Mitglied/Team), `lead` (Website).

`FINN_LLM_ROUTER=1` fragt bei niedriger Sicherheit ein kleines Modell mit erzwungenem
Tool-Aufruf – ohne Werkzeuge, ohne Kundendaten.

## Ablauf eines Laufs (`lib/finn/runtime.js`)

System-Prompt = Marke/Antwortregeln + Agent + Live-Daten (Magicline, maßgeblich) +
Opt-in-Gedächtnis + Wissensauszüge. Tool-Schleife max. 6 Schritte. LOW-Werkzeuge
laufen sofort; MEDIUM/HIGH erzeugen einen Vorschlag (`lib/finn/confirm.js`) und
beenden den Lauf. Den Bestätigungstext formuliert die Runtime, nicht das Modell.
App-Links nur über die Whitelist aus `api/member/coach.js` (`SCREENS`).

## Persona und Antwortregeln

Freundlich, klar, „du", kurz; keine erfundenen Daten, Preise oder Fristen; Live-Daten
vor Wissensbasis; nie behaupten, etwas sei erledigt; bei fehlendem Recht ehrlich
sagen und Übergabe anbieten; Gesundheitsangaben nur aufgreifen, wenn die Person sie
nennt – keine Diagnosen.
