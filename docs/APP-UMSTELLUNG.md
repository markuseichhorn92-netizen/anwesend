# Umstellung auf die neue Mitglieder-App (Checkliste)

Stand: 29. September 2026. Die Mitglieder-App (`mitglieder.html`, native Hülle in
`nativeapp/`) geht an einen externen Anbieter. Der Team-Bereich bleibt. Entscheidung des
Betreibers: Die Verwaltung der **jetzigen** App bleibt, solange sie läuft, und wird erst
am Umstellungstag entfernt.

## Vorher lösen (sonst bricht etwas)

| Was hängt heute an der App | Folge ohne App | Lösung vor dem Umstellungstag |
|---|---|---|
| **Journeys-Takt** – der Durchlauf startet auch aus App-Verkehr (`lib/journeys/autotick.js` in `api/member/checkins`, `api/member/account`) | Erinnerungen und Tag-X-Nachrichten kämen nur noch sporadisch | **Vercel-Cron alle 5 Minuten** (Pro-Tarif, `CRON_SECRET`) – siehe `docs/finn/journeys.md`. Der Magicline-Webhook stößt weiter an. |
| **WhatsApp-Einwilligung** über die App-Karte „WhatsApp von Fit-Inn" (`api/member/whatsapp.js`) | Mitglieder können nicht mehr in der App zustimmen | Bleibt über Willkommens-Mail (START-Code-Link), Probetraining-Formular, Lead-Gespräch, Einladung. Prüfen, ob die neue App einen Link auf `wa.me/…?text=START` bekommen soll. |
| **Posteingang, Kanal „Portal"** – Team-Antworten landen im App-Postfach | Mitglied sieht Antworten nicht mehr | Antworten auf E-Mail/WhatsApp umstellen (Vorgänge mit Kanal `portal` beim Antworten umleiten). |
| **Team-Push** – Team-Geräte bekommen Push nur in der nativen Hülle (`assets/native.js`, `api/team/push.js`) | Keine Push-Hinweise fürs Team | Team-Benachrichtigung per Mail (`notifyStudio`) reicht, oder eigene Team-App-Hülle. |
| **FINN-Wissen** aus den Hilfe-Artikeln (`lib/finn/knowledge.js`) – der WhatsApp-Lead-Agent nennt Preise nur daraus | – | **Hilfe-Artikel bleiben** (als Wissensbasis für FINN), auch wenn die App sie nicht mehr zeigt. |

## Am Umstellungstag entfernen (Team-Bereich)

- **App-Feedback** (`feedback`-Seite, `api/team/feedback.js`, `api/member/feedback.js`, Kampagne in `api/member/me.js`)
- **App-Tester** (`tester`-Seite, `api/team/testers.js`, `api/testers/join.js`, `tester.html`)
- **Community-Moderation** (`community`-Seite, `api/team/social-mod.js`; `api/member/social.js`, Workflow-Teil `social-remind` in `record.yml`)
- **Profil-Knöpfe** „Als Mitglied einloggen" (`api/team/impersonate.js`), „Zugangs-Info senden" (`api/team/access-info.js`), „Aktions-Link senden" (`api/team/action-link.js`, `api/member/action-login.js`)
- **Nachrichten:** Push-Kanal der Rundnachricht/Direktnachricht, WhatsApp-Login-Code-Diagnose (`api/team/wa-diagnose.js`)
- **Seitenleiste:** Link „Zur Mitglieder-App"
- **Statistiken:** Artikel-Aufrufe/Top-Artikel (die Aufrufe kamen aus der App)

Vorher in Statistiken → „Zuletzt benutzt" nachsehen, ob noch etwas davon benutzt wurde.

## Datenschutz beim Abschalten

- Mitglieder müssen ihre App-Daten weiter exportieren/löschen können (Art. 15/17) –
  entweder bis zur Löschung über den Self-Service der alten App oder auf Anfrage durch
  das Team. Danach Löschfristen aus `docs/VVT-TOM.md` anwenden.
- Einwilligungsnachweise (`lib/privacy`) bleiben ihre Aufbewahrungsfrist lang bestehen.
- Den neuen Anbieter als Auftragsverarbeiter bzw. Verantwortlichen einordnen
  (`docs/DIENSTLEISTER-AVV.md`).
