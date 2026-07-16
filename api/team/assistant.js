'use strict';

/**
 * Studio-Assistent (Team-Bereich).   Authorization: Bearer <team-token>  (nur Admin)
 *
 *   POST { messages:[{role,content}] }            -> Chat: KI plant, nutzt Tools.
 *        Antwort: { ok, kind:'message', text }                 – reine Auskunft
 *              |  { ok, kind:'confirm', text, action:{tool,args,preview} }
 *                 – eine nach-außen wirkende Aktion wartet auf Bestätigung.
 *   POST { confirm:{ tool, args } }               -> führt die bestätigte Aktion aus.
 *        Antwort: { ok, kind:'done', text }
 *
 * Der Assistent ruft AUSSCHLIESSLICH die bereits vorhandenen Team-Endpunkte auf
 * (mit dem Token des angemeldeten Admins) – gleiche Rechte, Rate-Limits und Logik
 * wie die normale Oberfläche. Lesen passiert automatisch; alles was Nachrichten,
 * Termine, Tags, Notizen oder Geld betrifft, wird dem Menschen zuerst als Vorschau
 * gezeigt und erst nach Klick ausgeführt.
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const AI = require('../../lib/ai');
const R = require('../../lib/retention');

// ── interner Aufruf der bestehenden Team-Endpunkte (Token weiterreichen) ──
function apiBase(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return proto + '://' + host;
}
async function callApi(req, method, path, body) {
  try {
    const r = await fetch(apiBase(req) + path, {
      method: method,
      headers: { 'Authorization': req.headers.authorization || '', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text().catch(function () { return ''; });
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json: json || {} };
  } catch (e) { return { status: 0, json: { ok: false, error: String(e && e.message) } }; }
}
function q(v) { return encodeURIComponent(String(v == null ? '' : v)); }

// ── Werkzeuge (Anthropic-Tool-Schemata) ──
const READ_TOOLS = {
  find_members: {
    description: 'Sucht Mitglieder per Name oder Mitgliedsnummer. Nutze das, um die richtige Person (mit ihrer id) zu finden, bevor du etwas für sie tust.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Name oder Mitgliedsnummer' } }, required: ['query'] },
  },
  member_overview: {
    description: 'Details zu einem Mitglied: Vertrag, Beitragskonto, nächste Termine, Kontaktwege. Braucht die Mitglieds-id (aus find_members).',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' } }, required: ['memberId'] },
  },
  list_dues: {
    description: 'Liste der Mitglieder mit offenen Beiträgen (Mahnwesen), inkl. offenem Betrag und Mahnstufe.',
    input_schema: { type: 'object', properties: {} },
  },
  list_inactive: {
    description: 'Mitglieder mit erhöhtem Abwanderungsrisiko / die länger nicht da waren (Churn-Radar).',
    input_schema: { type: 'object', properties: {} },
  },
  list_conversations: {
    description: 'Offene Vorgänge/Anfragen im Postfach (Übersicht).',
    input_schema: { type: 'object', properties: {} },
  },
  member_appointments: {
    description: 'Kommende Termine eines Mitglieds (inkl. bookingId zum Absagen). Braucht die Mitglieds-id.',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' } }, required: ['memberId'] },
  },
  list_bookable_types: {
    description: 'Verfügbare Terminarten, die man buchen kann (mit id, Titel, Dauer).',
    input_schema: { type: 'object', properties: {} },
  },
  find_slots: {
    description: 'Freie Termin-Slots für eine Terminart und ein Mitglied (liefert start, end, instructorIds für book_appointment).',
    input_schema: { type: 'object', properties: { bookableAppointmentId: { type: 'string' }, memberId: { type: 'string' }, days: { type: 'integer', description: 'Zeitraum in Tagen, Standard 28' } }, required: ['bookableAppointmentId', 'memberId'] },
  },
  get_conversation: {
    description: 'Liest einen einzelnen Postfach-Vorgang (Betreff, Status, Verlauf), um ihn zu beantworten oder zusammenzufassen. Braucht memberId und vorgangId (aus list_conversations).',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, vorgangId: { type: 'string' } }, required: ['memberId', 'vorgangId'] },
  },
  list_todos: {
    description: 'Liste der internen Team-Aufgaben (mit id, Text, Status) – etwa um eine Aufgabe als erledigt zu markieren oder zu löschen.',
    input_schema: { type: 'object', properties: {} },
  },
  get_winback_frame: {
    description: 'Zeigt den aktuellen Rückhol-Rahmen: erlaubte Höchstwerte für Angebote (Rabatt %, freie Wochen, Aktivierungsgebühr-Erlass, Pause) und ob die Rückholung aktiv ist.',
    input_schema: { type: 'object', properties: {} },
  },
};
const WRITE_TOOLS = {
  send_message: {
    description: 'Sendet dem Mitglied eine Direktnachricht (Postfach + je nach Kontaktweg Push/E-Mail/WhatsApp). Für Erinnerungen, Infos, Zahlungserinnerungen an EINE Person.',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, memberName: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['memberId', 'body'] },
  },
  broadcast: {
    description: 'Rundnachricht an ein ganzes Segment. Segmente: "app" (alle App-Nutzer), "inactive" (aktive Mitglieder, ≥14 Tage nicht da), "risk" (Abwanderungsrisiko), "former" (ehemalige/gekündigte). Für Massen-Aktionen statt vieler Einzelnachrichten.',
    input_schema: { type: 'object', properties: { segment: { type: 'string', enum: ['app', 'inactive', 'risk', 'former'] }, title: { type: 'string' }, body: { type: 'string' } }, required: ['segment', 'title', 'body'] },
  },
  add_tags: {
    description: 'Fügt einem Mitglied ein oder mehrere Tags/Etiketten hinzu (bestehende bleiben erhalten).',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, memberName: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['memberId', 'tags'] },
  },
  log_note: {
    description: 'Vermerkt eine interne Notiz / Rückhol-Aktion in der Kundenhistorie des Mitglieds.',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, memberName: { type: 'string' }, note: { type: 'string' } }, required: ['memberId', 'note'] },
  },
  book_appointment: {
    description: 'Bucht einen Termin für ein Mitglied. Werte aus list_bookable_types (bookableAppointmentId, title) und find_slots (start, end, instructorIds) verwenden.',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, memberName: { type: 'string' }, bookableAppointmentId: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, instructorIds: { type: 'array', items: { type: 'string' } } }, required: ['memberId', 'bookableAppointmentId', 'start'] },
  },
  cancel_appointment: {
    description: 'Sagt einen gebuchten Termin ab. Braucht die bookingId (aus member_appointments).',
    input_schema: { type: 'object', properties: { bookingId: { type: 'string' }, memberName: { type: 'string' }, summary: { type: 'string', description: 'kurze Beschreibung des Termins für die Vorschau' } }, required: ['bookingId'] },
  },
  create_todo: {
    description: 'Legt eine interne Aufgabe fürs Team an (To-do).',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, assignee: { type: 'string', description: 'optional: Mitarbeiter-id' }, due: { type: 'string', description: 'optional: Datum JJJJ-MM-TT' } }, required: ['text'] },
  },
  reply_conversation: {
    description: 'Antwortet dem Mitglied INNERHALB eines bestehenden Postfach-Vorgangs (kanalbewusst: Portal/E-Mail/WhatsApp). Nimm das, wenn eine vorhandene Anfrage im Postfach beantwortet werden soll (nicht send_message).',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, vorgangId: { type: 'string' }, memberName: { type: 'string' }, subject: { type: 'string' }, text: { type: 'string' } }, required: ['memberId', 'vorgangId', 'text'] },
  },
  close_conversation: {
    description: 'Schließt/archiviert einen Postfach-Vorgang (Status „abgeschlossen"). Ein echtes Löschen von Vorgängen gibt es bewusst nicht – Schließen ist der Weg, eine erledigte Anfrage aus der offenen Liste zu nehmen.',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, vorgangId: { type: 'string' }, memberName: { type: 'string' }, subject: { type: 'string' } }, required: ['memberId', 'vorgangId'] },
  },
  reopen_conversation: {
    description: 'Öffnet einen abgeschlossenen Vorgang wieder.',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, vorgangId: { type: 'string' }, memberName: { type: 'string' }, subject: { type: 'string' } }, required: ['memberId', 'vorgangId'] },
  },
  set_conversation_status: {
    description: 'Setzt den Status eines Vorgangs: neu, bearbeitung, wartet oder abgeschlossen.',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, vorgangId: { type: 'string' }, value: { type: 'string', enum: ['neu', 'bearbeitung', 'wartet', 'abgeschlossen'] }, subject: { type: 'string' } }, required: ['memberId', 'vorgangId', 'value'] },
  },
  set_conversation_priority: {
    description: 'Setzt die Priorität eines Vorgangs: hoch, mittel oder niedrig.',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, vorgangId: { type: 'string' }, value: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] }, subject: { type: 'string' } }, required: ['memberId', 'vorgangId', 'value'] },
  },
  conversation_note: {
    description: 'Fügt einem Vorgang eine interne Notiz hinzu (nur fürs Team sichtbar, geht NICHT ans Mitglied).',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, vorgangId: { type: 'string' }, text: { type: 'string' }, subject: { type: 'string' } }, required: ['memberId', 'vorgangId', 'text'] },
  },
  complete_todo: {
    description: 'Markiert eine interne Aufgabe als erledigt. Braucht die todoId (aus list_todos).',
    input_schema: { type: 'object', properties: { todoId: { type: 'string' }, text: { type: 'string' } }, required: ['todoId'] },
  },
  delete_todo: {
    description: 'Löscht eine interne Aufgabe. Braucht die todoId (aus list_todos).',
    input_schema: { type: 'object', properties: { todoId: { type: 'string' }, text: { type: 'string' } }, required: ['todoId'] },
  },
  send_winback_offer: {
    description: 'Erstellt ein rechtssicheres Rückhol-Angebot für ein Mitglied und schickt ihm eine Nachricht mit persönlichem Annahme-Link. Die Werte MÜSSEN im Rückhol-Rahmen liegen, sonst wird es abgelehnt. Nimm das, um ein Angebot verbindlich zu machen (nicht send_message).',
    input_schema: { type: 'object', properties: { memberId: { type: 'string' }, memberName: { type: 'string' }, message: { type: 'string', description: 'persönlicher Anschreibe-/Verhandlungstext' }, discountPct: { type: 'integer' }, discountWeeks: { type: 'integer' }, freeWeeks: { type: 'integer' }, waiveActivation: { type: 'boolean' }, pauseWeeks: { type: 'integer' } }, required: ['memberId'] },
  },
};
function toolSpecs() {
  const out = [];
  Object.keys(READ_TOOLS).forEach(function (n) { out.push(Object.assign({ name: n }, READ_TOOLS[n])); });
  Object.keys(WRITE_TOOLS).forEach(function (n) { out.push(Object.assign({ name: n }, WRITE_TOOLS[n])); });
  return out;
}

// ── Lesen: Endpunkt aufrufen, kompaktes Ergebnis für die KI zurückgeben ──
function trimProfile(p) {
  if (!p || typeof p !== 'object') return p;
  const c = p.contract || {};
  const a = p.account || {};
  return {
    id: p.id, name: p.name, nr: p.nr,
    hasEmail: !!p.email, hasPhone: !!p.phone,
    contract: { rate: c.rateName || null, active: c.active !== false, cancelled: !!c.cancelled, endDate: c.endDate || null, cancellationDate: c.cancellationDate || null },
    account: a && a.available === false ? { available: false } : { openTotal: a.openTotal || 0, openCount: a.openCount || 0, dunningLevel: a.dunningLevel || null, inDebtCollection: !!a.inDebtCollection },
    appointments: Array.isArray(p.appointments) ? p.appointments.slice(0, 6) : [],
  };
}
async function executeRead(req, name, input) {
  input = input || {};
  if (name === 'find_members') {
    const r = await callApi(req, 'GET', '/api/team/members?q=' + q(input.query));
    return { results: (r.json.results || []).slice(0, 12) };
  }
  if (name === 'member_overview') {
    const r = await callApi(req, 'GET', '/api/team/members?id=' + q(input.memberId));
    return r.json.ok ? { profile: trimProfile(r.json.profile) } : { error: 'not_found' };
  }
  if (name === 'list_dues') {
    const r = await callApi(req, 'GET', '/api/team/dues');
    if (r.status === 403) return { error: 'forbidden' };
    return { members: (r.json.members || []).slice(0, 40), capped: !!r.json.capped };
  }
  if (name === 'list_inactive') {
    const r = await callApi(req, 'GET', '/api/team/churn');
    return { members: (r.json.members || []).slice(0, 40), capped: !!r.json.capped };
  }
  if (name === 'list_conversations') {
    const r = await callApi(req, 'GET', '/api/team/conversations');
    return { conversations: (r.json.conversations || []).slice(0, 30), counts: r.json.counts || {} };
  }
  if (name === 'member_appointments') {
    const r = await callApi(req, 'GET', '/api/team/appointments?memberId=' + q(input.memberId));
    return { appointments: r.json.appointments || [] };
  }
  if (name === 'list_bookable_types') {
    const r = await callApi(req, 'GET', '/api/team/appointments?bookable=1');
    return { available: !!r.json.available, types: r.json.types || [] };
  }
  if (name === 'find_slots') {
    const r = await callApi(req, 'GET', '/api/team/appointments?slotsFor=' + q(input.bookableAppointmentId) + '&memberId=' + q(input.memberId) + '&days=' + q(input.days || 28));
    return { slots: (r.json.slots || []).slice(0, 20) };
  }
  if (name === 'get_conversation') {
    const r = await callApi(req, 'GET', '/api/team/conversation?m=' + q(input.memberId) + '&id=' + q(input.vorgangId));
    if (!r.json.ok) return { error: 'not_found' };
    const c = r.json.conversation || {};
    return { conversation: {
      subject: c.subject, status: c.teamStatus, priority: c.priority,
      member: (c.member && c.member.name) || null,
      messages: (c.messages || []).slice(-8).map(function (mm) { return { from: mm.from, text: String(mm.text || '').slice(0, 400) }; }),
      notes: (c.notes || []).slice(-4).map(function (nn) { return { author: nn.author, text: String(nn.text || '').slice(0, 300) }; }),
    } };
  }
  if (name === 'list_todos') {
    const r = await callApi(req, 'GET', '/api/team/todos');
    return { todos: (r.json.todos || []).slice(0, 50) };
  }
  if (name === 'get_winback_frame') {
    try { return { frame: await R.getFrame() }; } catch (e) { return { frame: null }; }
  }
  return { error: 'unknown_read_tool' };
}

// ── Vorschau für eine Schreib-Aktion (für die Bestätigungs-Karte) ──
const SEGMENT_LABEL = { app: 'alle App-Nutzer', inactive: 'inaktive Mitglieder (≥14 Tage nicht da)', risk: 'Mitglieder mit Abwanderungsrisiko', former: 'ehemalige Mitglieder' };
async function previewWrite(req, name, args) {
  args = args || {};
  const who = args.memberName ? String(args.memberName) : 'das Mitglied';
  if (name === 'send_message') {
    return 'Direktnachricht an ' + who + (args.title ? ' · Betreff: „' + args.title + '"' : '') + '\n\n„' + String(args.body || '') + '"';
  }
  if (name === 'broadcast') {
    let count = null;
    try { const r = await callApi(req, 'GET', '/api/team/broadcast?segment=' + q(args.segment)); if (r.json && typeof r.json.count === 'number') count = r.json.count; } catch (e) {}
    return 'Rundnachricht an ' + (SEGMENT_LABEL[args.segment] || args.segment) + (count != null ? ' (' + count + ' Empfänger)' : '') + '\nBetreff: „' + String(args.title || '') + '"\n\n„' + String(args.body || '') + '"';
  }
  if (name === 'add_tags') return 'Tags zu ' + who + ' hinzufügen: ' + (Array.isArray(args.tags) ? args.tags.join(', ') : '');
  if (name === 'log_note') return 'Notiz in der Kundenhistorie von ' + who + ':\n\n„' + String(args.note || '') + '"';
  if (name === 'book_appointment') {
    const when = args.start ? fmtWhen(args.start) : '(Zeit offen)';
    return 'Termin buchen für ' + who + ': ' + (args.title || 'Termin') + '\n' + when;
  }
  if (name === 'cancel_appointment') return 'Termin absagen' + (args.memberName ? ' für ' + args.memberName : '') + ': ' + (args.summary || ('Buchung ' + args.bookingId));
  if (name === 'create_todo') return 'Neue interne Aufgabe: „' + String(args.text || '') + '"' + (args.due ? ' (bis ' + args.due + ')' : '');
  if (name === 'reply_conversation') return 'Antwort im Vorgang' + (args.subject ? ' „' + args.subject + '"' : '') + (args.memberName ? ' an ' + args.memberName : '') + ':\n\n„' + String(args.text || '') + '"';
  if (name === 'close_conversation') return 'Vorgang abschließen' + (args.subject ? ': „' + args.subject + '"' : '') + (args.memberName ? ' (' + args.memberName + ')' : '');
  if (name === 'reopen_conversation') return 'Vorgang wieder öffnen' + (args.subject ? ': „' + args.subject + '"' : '');
  if (name === 'set_conversation_status') return 'Status setzen auf „' + args.value + '"' + (args.subject ? ' – Vorgang „' + args.subject + '"' : '');
  if (name === 'set_conversation_priority') return 'Priorität setzen auf „' + args.value + '"' + (args.subject ? ' – Vorgang „' + args.subject + '"' : '');
  if (name === 'conversation_note') return 'Interne Notiz zum Vorgang' + (args.subject ? ' „' + args.subject + '"' : '') + ' (nur fürs Team):\n\n„' + String(args.text || '') + '"';
  if (name === 'complete_todo') return 'Aufgabe als erledigt markieren' + (args.text ? ': „' + args.text + '"' : '');
  if (name === 'delete_todo') return 'Aufgabe löschen' + (args.text ? ': „' + args.text + '"' : '');
  if (name === 'send_winback_offer') {
    const details = { discountPct: args.discountPct, discountWeeks: args.discountWeeks, freeWeeks: args.freeWeeks, waiveActivation: args.waiveActivation, pauseWeeks: args.pauseWeeks };
    let within = '';
    try { const f = await R.getFrame(); const chk = R.validateOffer(details, f); within = chk.ok ? '\n\n✓ Im Rahmen.' : '\n\n⚠️ ÜBER DEM RAHMEN: ' + chk.violations.join(' '); } catch (e) {}
    const desc = R.describeOffer(details);
    return 'Rückhol-Angebot an ' + who + ': ' + (desc || '(kein Inhalt)') + '\nMit persönlichem, rechtssicherem Annahme-Link.' + (args.message ? '\n\nAnschreiben: „' + String(args.message) + '"' : '') + within;
  }
  return 'Aktion: ' + name;
}
function fmtWhen(iso) {
  try {
    const d = new Date(iso); if (isNaN(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(d) + ' Uhr';
  } catch (e) { return String(iso); }
}

// ── Ausführen einer bestätigten Schreib-Aktion ──
async function executeWrite(req, name, args) {
  args = args || {};
  const who = args.memberName ? String(args.memberName) : 'das Mitglied';
  try {
    if (name === 'send_message') {
      const r = await callApi(req, 'POST', '/api/team/message', { memberId: args.memberId, title: args.title || '', body: args.body || '' });
      if (r.json && r.json.ok) return { ok: true, kind: 'done', text: 'Nachricht an ' + who + ' gesendet' + (Array.isArray(r.json.via) && r.json.via.length ? ' (' + r.json.via.join(', ') + ').' : '.') };
      return { ok: false, kind: 'done', text: (r.json && r.json.message) || 'Nachricht konnte nicht gesendet werden.' };
    }
    if (name === 'broadcast') {
      const r = await callApi(req, 'POST', '/api/team/broadcast', { segment: args.segment, title: args.title || '', body: args.body || '' });
      if (r.status === 403) return { ok: false, kind: 'done', text: 'Rundnachrichten sind nur für Admins möglich.' };
      if (r.json && r.json.ok) return { ok: true, kind: 'done', text: 'Rundnachricht verschickt an ' + (r.json.recipients || 0) + ' Empfänger (Push ' + (r.json.pushSent || 0) + ', E-Mail ' + (r.json.mailSent || 0) + ', WhatsApp ' + (r.json.waSent || 0) + ').' };
      return { ok: false, kind: 'done', text: (r.json && r.json.message) || 'Rundnachricht fehlgeschlagen.' };
    }
    if (name === 'add_tags') {
      const cur = await callApi(req, 'GET', '/api/team/tags?memberId=' + q(args.memberId));
      const existing = (cur.json && Array.isArray(cur.json.tags)) ? cur.json.tags : [];
      const add = Array.isArray(args.tags) ? args.tags : [];
      const merged = existing.slice();
      add.forEach(function (t) { t = String(t || '').trim(); if (t && merged.indexOf(t) < 0) merged.push(t); });
      const r = await callApi(req, 'POST', '/api/team/tags', { memberId: args.memberId, tags: merged });
      if (r.json && r.json.ok) return { ok: true, kind: 'done', text: 'Tags aktualisiert für ' + who + ': ' + (r.json.tags || []).join(', ') + '.' };
      return { ok: false, kind: 'done', text: 'Tags konnten nicht gesetzt werden.' };
    }
    if (name === 'log_note') {
      const r = await callApi(req, 'POST', '/api/team/winback', { id: args.memberId, note: args.note });
      if (r.json && r.json.ok) return { ok: true, kind: 'done', text: 'Notiz in der Historie von ' + who + ' vermerkt.' };
      return { ok: false, kind: 'done', text: (r.json && r.json.message) || 'Notiz konnte nicht gespeichert werden.' };
    }
    if (name === 'book_appointment') {
      const r = await callApi(req, 'POST', '/api/team/appointments', { action: 'book', memberId: args.memberId, bookableAppointmentId: args.bookableAppointmentId, title: args.title || '', start: args.start, end: args.end, instructorIds: args.instructorIds || [] });
      if (r.json && r.json.ok) return { ok: true, kind: 'done', text: (r.json.message || 'Termin gebucht') + ' für ' + who + '.' };
      return { ok: false, kind: 'done', text: (r.json && r.json.message) || 'Termin konnte nicht gebucht werden.' };
    }
    if (name === 'cancel_appointment') {
      const r = await callApi(req, 'POST', '/api/team/appointments', { action: 'cancel', bookingId: args.bookingId });
      if (r.json && r.json.ok) return { ok: true, kind: 'done', text: r.json.message || 'Termin abgesagt.' };
      return { ok: false, kind: 'done', text: (r.json && r.json.message) || 'Termin konnte nicht abgesagt werden.' };
    }
    if (name === 'create_todo') {
      const r = await callApi(req, 'POST', '/api/team/todos', { action: 'add', text: args.text, assignee: args.assignee || '', due: args.due || '' });
      if (r.json && r.json.ok) return { ok: true, kind: 'done', text: 'Aufgabe angelegt: „' + String(args.text || '') + '".' };
      return { ok: false, kind: 'done', text: 'Aufgabe konnte nicht angelegt werden.' };
    }
    // ── Postfach-Vorgänge (Anfragen) ──
    if (name === 'reply_conversation' || name === 'close_conversation' || name === 'reopen_conversation' || name === 'set_conversation_status' || name === 'set_conversation_priority' || name === 'conversation_note') {
      const map = { reply_conversation: 'reply', close_conversation: 'close', reopen_conversation: 'reopen', set_conversation_status: 'status', set_conversation_priority: 'priority', conversation_note: 'note' };
      const payload = { m: args.memberId, id: args.vorgangId, action: map[name] };
      if (name === 'reply_conversation') payload.text = args.text;
      if (name === 'conversation_note') payload.text = args.text;
      if (name === 'set_conversation_status' || name === 'set_conversation_priority') payload.value = args.value;
      const r = await callApi(req, 'POST', '/api/team/conversation', payload);
      if (r.json && r.json.ok) {
        const done = {
          reply_conversation: 'Antwort im Vorgang gesendet' + (args.memberName ? ' an ' + args.memberName : '') + '.',
          close_conversation: 'Vorgang abgeschlossen.',
          reopen_conversation: 'Vorgang wieder geöffnet.',
          set_conversation_status: 'Status auf „' + args.value + '" gesetzt.',
          set_conversation_priority: 'Priorität auf „' + args.value + '" gesetzt.',
          conversation_note: 'Interne Notiz zum Vorgang gespeichert.',
        };
        return { ok: true, kind: 'done', text: done[name] };
      }
      return { ok: false, kind: 'done', text: (r.json && r.json.message) || 'Aktion am Vorgang fehlgeschlagen.' };
    }
    if (name === 'complete_todo') {
      const r = await callApi(req, 'POST', '/api/team/todos', { action: 'update', id: args.todoId, done: true });
      if (r.json && r.json.ok) return { ok: true, kind: 'done', text: 'Aufgabe als erledigt markiert.' };
      return { ok: false, kind: 'done', text: 'Aufgabe konnte nicht aktualisiert werden.' };
    }
    if (name === 'delete_todo') {
      const r = await callApi(req, 'POST', '/api/team/todos', { action: 'delete', id: args.todoId });
      if (r.json && r.json.ok) return { ok: true, kind: 'done', text: 'Aufgabe gelöscht.' };
      return { ok: false, kind: 'done', text: 'Aufgabe konnte nicht gelöscht werden.' };
    }
    if (name === 'send_winback_offer') {
      const r = await callApi(req, 'POST', '/api/team/retention', { action: 'create-offer', memberId: args.memberId, memberName: args.memberName || '', message: args.message || '', details: { discountPct: args.discountPct, discountWeeks: args.discountWeeks, freeWeeks: args.freeWeeks, waiveActivation: args.waiveActivation, pauseWeeks: args.pauseWeeks } });
      if (r.json && r.json.ok) return { ok: true, kind: 'done', text: 'Angebot an ' + who + ' verschickt (' + ((r.json.offer && r.json.offer.summary) || '') + '). Das Mitglied kann es über den Annahme-Link verbindlich annehmen; bei Annahme entsteht automatisch eine Aufgabe „in Magicline umsetzen".' };
      if (r.json && r.json.error === 'out_of_frame') return { ok: false, kind: 'done', text: 'Angebot NICHT verschickt – es liegt über dem Rahmen: ' + ((r.json.violations || []).join(' ')) };
      return { ok: false, kind: 'done', text: (r.json && r.json.message) || 'Angebot konnte nicht erstellt werden.' };
    }
  } catch (e) { return { ok: false, kind: 'done', text: 'Aktion fehlgeschlagen.' }; }
  return { ok: false, kind: 'done', text: 'Unbekannte Aktion.' };
}

function frameLines(frame) {
  if (!frame || !frame.active) {
    return ['Rückholung/Angebote: Der Angebots-Rahmen ist NICHT aktiviert. Du darfst KEINE Rabatte oder Angebote zusagen. Wenn jemand ein Rückhol-Angebot will, sag, dass der Rahmen erst in den Einstellungen (Rückholung) aktiviert werden muss.'];
  }
  const parts = [];
  if (frame.maxDiscountPct) parts.push('Rabatt bis ' + frame.maxDiscountPct + '%' + (frame.maxDiscountWeeks ? ' für max ' + frame.maxDiscountWeeks + ' Wochen' : ''));
  if (frame.maxFreeWeeks) parts.push('bis ' + frame.maxFreeWeeks + ' Wochen gratis');
  if (frame.waiveActivation) parts.push('Aktivierungsgebühr (39 €) darf erlassen werden');
  if (frame.maxPauseWeeks) parts.push('Beitragspause bis ' + frame.maxPauseWeeks + ' Wochen');
  return [
    'RÜCKHOL-RAHMEN (HARTE OBERGRENZE – NIE überschreiten): ' + (parts.length ? parts.join('; ') : 'keine Hebel freigegeben') + '.',
    (frame.notes ? 'Zusätzliche Leitplanken des Inhabers: ' + frame.notes : ''),
    'Verhandle sparsam: Starte mit dem kleinsten sinnvollen Angebot und erhöhe nur, wenn nötig – nie über den Rahmen. Ein formelles Angebot machst du mit send_winback_offer (erzeugt einen rechtssicheren Annahme-Link). Will der Kunde MEHR als der Rahmen erlaubt oder kommt ein Abschluss zustande, führe es NICHT selbst aus – fasse zusammen und übergib an den Menschen.',
    (frame.autopilot ? 'Auto-Pilot ist AN: Der Inhaber erlaubt Antworten innerhalb des Rahmens.' : 'Auto-Pilot ist AUS: Jede Nachricht wird vom Menschen freigegeben.'),
  ].filter(Boolean);
}
function buildSystem(sess, frame) {
  let today = '';
  try { today = new Intl.DateTimeFormat('de-DE', { dateStyle: 'full', timeZone: 'Europe/Berlin' }).format(new Date()); } catch (e) {}
  return [
    'Du bist der Studio-Assistent im Team-Bereich von Fit-Inn Trier (familiengeführtes Fitnessstudio, Auf Hirtenberg 8, 54296 Trier).',
    'Du hilfst dem Team, Aufgaben zu erledigen: Postfach & Kommunikation, Mitglieder-Verwaltung, Termine sowie Finanzen/Mahnwesen.',
    'Du arbeitest für: ' + (sess.user || 'das Team') + '. Heute ist ' + (today || 'heute') + '.',
    'Antworte kurz, klar und professionell auf Deutsch, per "du". Keine Markdown-Überschriften.',
    'Nutze die bereitgestellten Werkzeuge, statt zu raten. Suche Mitglieder immer erst mit find_members und arbeite mit der zurückgegebenen id.',
    'Aktionen, die nach außen wirken (Nachricht senden, Rundnachricht, Termin buchen/absagen, Tags, Notizen), rufst du einfach als Werkzeug auf – das System zeigt sie dem Menschen zuerst als Vorschau und führt sie erst nach dessen Bestätigung aus. Erfinde keine Bestätigung und behaupte nicht, etwas sei schon erledigt.',
    'Bei einer Aktion für viele Empfänger bevorzuge broadcast mit passendem Segment statt vieler Einzelnachrichten.',
    'Postfach-Vorgänge: Um eine Anfrage zu beantworten, nutze reply_conversation (nicht send_message) – das antwortet im richtigen Vorgang und Kanal. Zum Erledigen einer Anfrage close_conversation (Schließen/Archivieren). Ein echtes Löschen von Vorgängen gibt es nicht; wenn jemand „löschen" sagt, kläre kurz und schließe den Vorgang. Vorgänge findest du über list_conversations (liefert memberId und id=vorgangId).',
    'Aufgaben: Zum Abhaken oder Löschen erst list_todos aufrufen, um die richtige todoId zu bekommen.',
    'Wenn eine Anfrage unklar ist (welches Mitglied? welcher Vorgang? welcher Text?), frag kurz nach, statt zu raten.',
    'Gib niemals Bank-/IBAN-Daten aus. Behandle Mitgliederdaten vertraulich.',
    'Formuliere Nachrichten an Mitglieder freundlich, motivierend und im Fit-Inn-Ton (per "du"), sofern der Nutzer keinen eigenen Text vorgibt.',
  ].concat(frameLines(frame)).join('\n');
}

// ── Tool-Schleife ──
async function runLoop(req, sess, msgs) {
  let frame = null; try { frame = await R.getFrame(); } catch (e) {}
  const system = buildSystem(sess, frame);
  const convo = msgs.slice();
  for (let step = 0; step < 6; step++) {
    const r = await AI.messagesRaw({ system: system, messages: convo, tools: toolSpecs(), maxTokens: 1300 });
    if (!r.ok) return { ok: false, kind: 'message', text: 'Der Assistent kommt gerade nicht weiter. Bitte gleich noch einmal.' };
    const content = r.content;
    const textOut = content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
    const toolUses = content.filter(function (b) { return b.type === 'tool_use'; });
    if (!toolUses.length) return { ok: true, kind: 'message', text: textOut || 'Alles klar.' };

    // Eine Schreib-Aktion? -> anhalten und zur Bestätigung vorschlagen.
    const firstWrite = toolUses.find(function (t) { return WRITE_TOOLS[t.name]; });
    if (firstWrite) {
      const preview = await previewWrite(req, firstWrite.name, firstWrite.input || {});
      return { ok: true, kind: 'confirm', text: textOut, action: { tool: firstWrite.name, args: firstWrite.input || {}, preview: preview } };
    }
    // Nur Lese-Tools -> alle ausführen, Ergebnisse zurückspielen, weiter.
    const results = [];
    for (const t of toolUses) {
      const rr = READ_TOOLS[t.name] ? await executeRead(req, t.name, t.input || {}) : { error: 'unknown_tool' };
      results.push({ type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(rr).slice(0, 7000) });
    }
    convo.push({ role: 'assistant', content: content });
    convo.push({ role: 'user', content: results });
  }
  return { ok: true, kind: 'message', text: 'Das war mir zu verschachtelt – magst du die Aufgabe etwas kleiner formulieren?' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (!Cap.requireCap(sess, 'admin.manage', res)) return;
  if (!TA.isAdmin(sess)) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'forbidden', message: 'Der Assistent ist nur für Admins verfügbar.' })); }
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }
  if (!AI.hasAI) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'no_ai', message: 'Der Assistent ist gerade nicht verfügbar (kein KI-Schlüssel hinterlegt).' })); }

  const body = await M.readBody(req);

  // Bestätigte Aktion ausführen.
  if (body && body.confirm && body.confirm.tool && WRITE_TOOLS[body.confirm.tool]) {
    const out = await executeWrite(req, body.confirm.tool, body.confirm.args || {});
    res.statusCode = 200; return res.end(JSON.stringify(out));
  }

  const history = Array.isArray(body.messages) ? body.messages : [];
  const msgs = history
    .map(function (m) { return { role: m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').slice(0, 4000) }; })
    .filter(function (m) { return m.content; })
    .slice(-16);
  if (!msgs.length) { res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: 'empty' })); }

  if (!(await M.rateLimit('team-assist:' + (sess.user || 'x'), 80, 3600))) {
    res.statusCode = 200; return res.end(JSON.stringify({ ok: false, kind: 'message', text: 'Kurz durchatmen – das waren viele Anfragen auf einmal. Gleich nochmal.' }));
  }

  const result = await runLoop(req, sess, msgs);
  res.statusCode = 200;
  return res.end(JSON.stringify(result));
};
