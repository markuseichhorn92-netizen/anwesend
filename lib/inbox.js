'use strict';

/**
 * Postfach / Vorgänge-Store (Mitglieder-Nachrichtensystem).
 * Persistenz über Upstash KV (lib/store.js). Jeder Vorgang = ein Fall mit
 * Status + Nachrichten-Thread. Mitglieder können antworten; das Team
 * beantwortet Vorgänge im Team-Backend (siehe api/team/*) – kanalbewusst
 * (Portal / E-Mail / WhatsApp) über lib/studioReply.applyOwnerReply.
 *
 * Keys (pro Mitglied, memberId = Session-Kunden-ID):
 *   pf:idx:<m>      LIST der Vorgang-IDs (neueste zuerst)
 *   pf:v:<m>:<id>   JSON des Vorgangs (inkl. messages[])
 *   pf:seq:<m>      INCR-Zähler für IDs/Referenznummern
 *
 * Globaler Team-Index (über ALLE Mitglieder, fürs Team-Backend):
 *   pf:all          ZSET, score = updatedAt, member = "<memberId>:<vorgangId>"
 */

const { redisPipeline, hasStore } = require('./store');

const TTL = 60 * 60 * 24 * 365;   // 1 Jahr
const MAX_LIST = 100;
const ALL_KEY = 'pf:all';
const ALL_CAP = 1000;             // globalen Index begrenzen (neueste behalten)

const idxKey = (m) => 'pf:idx:' + m;
const vKey = (m, id) => 'pf:v:' + m + ':' + id;
const seqKey = (m) => 'pf:seq:' + m;

// Typ -> Referenz-Präfix (z. B. #K-1042)
const PREFIX = {
  kuendigung: 'K', widerruf: 'W', adresse: 'D', iban: 'B',
  kontakt: 'A', termin: 'T', pause: 'P', willkommen: '0',
  angebot: 'R', whatsapp: 'C', allgemein: 'M',
};

// Team-Vorgänge, die NICHT in den globalen Posteingang gehören (reine System-/Begrüßungsfälle).
const TEAM_HIDDEN_TYPES = { willkommen: true };

const TEAM_STATUSES = ['neu', 'bearbeitung', 'wartet', 'abgeschlossen'];
const PRIORITIES = ['hoch', 'mittel', 'niedrig'];

// Push ans Studio-Team (eigene App) über einen Vorgang, der Aufmerksamkeit braucht
// (neue Mitglieder-Anfrage oder Mitglieder-Antwort). Best effort; „schläft" ohne
// Push-Konfiguration und bricht nie den eigentlichen Ablauf ab.
async function pushTeam(memberId, v, kind) {
  try {
    const Push = require('./push');
    if (!Push.hasPush) return;
    const who = (v && v.member && v.member.name) || 'Ein Mitglied';
    const subj = (v && v.subject) || 'Neuer Vorgang';
    const via = (v && v.channel === 'whatsapp') ? ' (WhatsApp)' : ((v && v.channel === 'email') ? ' (E-Mail)' : '');
    const body = (kind === 'reply')
      ? (who + ' hat geantwortet: ' + subj + via)
      : (who + via + ': ' + subj);
    await Push.sendToTeam({
      title: 'Neue Nachricht im Postfach',
      body: body,
      url: 'https://mitglieder.fit-inn-trier.de/team',
      data: { kind: 'inbox', memberId: String(memberId || ''), vorgangId: String((v && v.id) || '') },
    });
  } catch (e) { /* Team-Push ist optional */ }
}

function memberKey(m, id) { return String(m) + ':' + String(id); }
function splitMemberKey(s) {
  const str = String(s); const i = str.indexOf(':');
  return i < 0 ? null : [str.slice(0, i), str.slice(i + 1)];
}

async function nextSeq(m) {
  if (!hasStore) return Math.floor(Math.random() * 9000) + 1000;
  const r = await redisPipeline([['INCR', seqKey(m)], ['EXPIRE', seqKey(m), String(TTL)]]);
  return Number(r && r[0]) || 1;
}

/**
 * Legt einen neuen Vorgang an.
 * opts: { type, subject, status?, systemText?, teamText?, needsAction?,
 *         channel?, phone?, priority?, assignee?, member?, teamStatus?, teamUnread? }
 * Liefert den Vorgang oder null (kein Store/keine memberId).
 */
async function addVorgang(memberId, opts) {
  if (!hasStore || !memberId || !opts) return null;
  const m = String(memberId);
  const seq = await nextSeq(m);
  const id = String(seq);
  const now = Date.now();
  const ref = '#' + (PREFIX[opts.type] || 'M') + '-' + String(1000 + seq);
  const messages = [];
  if (opts.systemText) messages.push({ from: 'system', text: String(opts.systemText), at: now });
  if (opts.teamText) messages.push({ from: 'team', text: String(opts.teamText), at: now + 1, needsAction: !!opts.needsAction });
  const closed = opts.status === 'abgeschlossen';
  const v = {
    id, type: opts.type || 'allgemein', subject: opts.subject || 'Vorgang',
    status: opts.status || 'bearbeitung', ref,
    channel: opts.channel || 'portal',        // 'portal' | 'whatsapp' | 'email'
    phone: opts.phone || null,                 // WhatsApp-Nummer des Mitglieds (für Antworten)
    // ── Team-Backend-Metadaten ──
    teamStatus: opts.teamStatus || (closed ? 'abgeschlossen' : 'neu'),
    teamUnread: opts.teamUnread != null ? !!opts.teamUnread : !closed,
    priority: PRIORITIES.indexOf(opts.priority) >= 0 ? opts.priority : 'mittel',
    assignee: opts.assignee || null,
    notes: [],
    member: opts.member || null,               // Snapshot {name,nr,initials,email,phone}
    createdAt: now, updatedAt: now, unread: true, messages,
  };
  const cmds = [
    ['SET', vKey(m, id), JSON.stringify(v), 'EX', String(TTL)],
    ['LPUSH', idxKey(m), id],
    ['LTRIM', idxKey(m), '0', String(MAX_LIST - 1)],
    ['EXPIRE', idxKey(m), String(TTL)],
  ];
  if (!TEAM_HIDDEN_TYPES[v.type]) {
    cmds.push(['ZADD', ALL_KEY, String(now), memberKey(m, id)]);
    cmds.push(['ZREMRANGEBYRANK', ALL_KEY, '0', String(-(ALL_CAP + 1))]);
  }
  try {
    await redisPipeline(cmds);
  } catch (e) { return null; }
  // Team benachrichtigen, wenn der Vorgang Aufmerksamkeit braucht (nicht bei reinen
  // System-Bestätigungen: dort setzt der Aufrufer notifyTeam:false) und im Posteingang landet.
  if (v.teamUnread && !TEAM_HIDDEN_TYPES[v.type] && opts.notifyTeam !== false) {
    await pushTeam(m, v, 'new');
  }
  return v;
}

async function list(memberId) {
  if (!hasStore || !memberId) return [];
  const m = String(memberId);
  let ids;
  try { [ids] = await redisPipeline([['LRANGE', idxKey(m), '0', String(MAX_LIST - 1)]]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  let res;
  try { res = await redisPipeline(ids.map((id) => ['GET', vKey(m, id)])); }
  catch (e) { return []; }
  const out = [];
  (res || []).forEach((s) => { if (s) { try { out.push(JSON.parse(s)); } catch (e) {} } });
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

async function get(memberId, id) {
  if (!hasStore || !memberId || !id) return null;
  let s;
  try { [s] = await redisPipeline([['GET', vKey(String(memberId), String(id))]]); }
  catch (e) { return null; }
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

async function save(memberId, v) {
  const m = String(memberId);
  const cmds = [['SET', vKey(m, v.id), JSON.stringify(v), 'EX', String(TTL)]];
  if (!TEAM_HIDDEN_TYPES[v.type]) {
    cmds.push(['ZADD', ALL_KEY, String(v.updatedAt || Date.now()), memberKey(m, v.id)]);
  }
  try { await redisPipeline(cmds); } catch (e) {}
  return v;
}

async function markRead(memberId, id) {
  const v = await get(memberId, id);
  if (!v) return null;
  if (v.unread) { v.unread = false; await save(memberId, v); }
  return v;
}

// Bild-Anhang eines Mitglieds prüfen. Bewusst eng: nur Bilder, nur data:-URLs mit
// erlaubtem Typ, harte Größengrenze. Der Typ wird aus dem data:-Präfix gelesen und NICHT
// dem Client geglaubt; alles andere wird verworfen (kein Fehler, nur kein Anhang).
const ATT_MAX = 700000;   // ~700 KB base64 – reicht für ein komprimiertes Handyfoto
const ATT_PER_VORGANG = 6;
function cleanAttachment(att) {
  if (!att) return null;
  const data = String(att.data || '');
  const m = data.match(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/);
  if (!m) return null;
  if (data.length > ATT_MAX) return null;
  return { kind: 'image', mime: 'image/' + m[1], name: String(att.name || 'Bild').slice(0, 60), data: data };
}

// opts.notifyTeam === false: Nachricht still ins Postfach hängen, OHNE das Team zu
// alarmieren (kein Push, nicht als „neu"/ungelesen markiert). Genutzt von der
// WhatsApp-KI: Nachrichten, die FINN selbst erledigt, sollen das Team nicht fluten –
// nur bei Eskalation wird das Team benachrichtigt.
async function reply(memberId, id, text, attachment, opts) {
  opts = opts || {};
  const notifyTeam = opts.notifyTeam !== false;
  const v = await get(memberId, id);
  if (!v) return null;
  const now = Date.now();
  v.messages = v.messages || [];
  v.messages.forEach((mm) => { if (mm.needsAction) mm.needsAction = false; });
  const msg = { from: 'member', text: String(text || '').slice(0, 4000), at: now };
  // Anhang nur, solange der Vorgang nicht zumüllt (KV-Datensatz bleibt handhabbar).
  const att = cleanAttachment(attachment);
  const used = v.messages.filter((mm) => mm && mm.att).length;
  if (att && used < ATT_PER_VORGANG) msg.att = att;
  v.messages.push(msg);
  if (v.status === 'aktion') v.status = 'bearbeitung';
  // Mitglied hat geantwortet -> Team muss ran (außer FINN erledigt es still).
  if (notifyTeam) { v.teamStatus = 'neu'; v.teamUnread = true; }
  v.updatedAt = now; v.unread = false;
  await save(memberId, v);
  if (notifyTeam && !TEAM_HIDDEN_TYPES[v.type]) await pushTeam(memberId, v, 'reply');
  return v;
}

// Antwort des Studios/Teams an den Vorgang hängen (serverseitig, ohne Member-Session).
// Erscheint im Postfach als „Team"-Bubble, setzt den Vorgang auf ungelesen + beantwortet.
// opts: { status?, author?, teamStatus?, needsAction? }
async function teamReply(memberId, id, text, opts) {
  opts = opts || {};
  const v = await get(memberId, id);
  if (!v) return null;
  const now = Date.now();
  v.messages = v.messages || [];
  v.messages.forEach((mm) => { if (mm.needsAction) mm.needsAction = false; });
  const msg = { from: 'team', text: String(text || '').slice(0, 4000), at: now, needsAction: !!opts.needsAction };
  if (opts.author) msg.author = String(opts.author).slice(0, 80);
  v.messages.push(msg);
  v.status = opts.status || 'beantwortet';
  // Team hat geantwortet -> wartet auf Mitglied; aus Team-Sicht gelesen.
  v.teamStatus = opts.teamStatus || 'wartet';
  v.teamUnread = false;
  v.updatedAt = now; v.unread = true;
  await save(memberId, v);
  // Push ans Mitglied (best effort; respektiert dessen Einstellungen, „schläft" ohne Firebase).
  try {
    const Push = require('./push');
    // Bewusst OHNE Betreff: Vorgangs-Betreffe können Vertrags-/Gesundheitsdetails
    // enthalten („Kündigung bestätigt", „Beitragspause") – die gehören nicht auf
    // den Sperrbildschirm. Der Inhalt wartet in der App hinter der Anmeldung.
    await Push.notifyMember(memberId, 'pushPostfach', {
      title: 'Neue Nachricht vom Fit-Inn',
      body: 'Das Team hat dir geantwortet – öffne dein Postfach.',
      url: 'https://mitglieder.fit-inn-trier.de/',
    });
  } catch (e) {}
  return v;
}

async function resolve(memberId, id) {
  const v = await get(memberId, id);
  if (!v) return null;
  v.status = 'abgeschlossen';
  v.teamStatus = 'abgeschlossen';
  v.teamUnread = false;
  v.updatedAt = Date.now();
  await save(memberId, v);
  return v;
}

async function unreadCount(memberId) {
  const l = await list(memberId);
  return l.filter((v) => v.unread).length;
}

// Vorgang einem ANDEREN Kunden zuordnen (falsche Auto-Zuordnung korrigieren oder
// Lead -> echtes Mitglied verknüpfen). Der Vorgang wird unter der Ziel-ID NEU
// angelegt (frische Vorgangs-ID); Verlauf, Kanal + Telefonnummer wandern mit. Der
// Wechsel wird als interne Team-Notiz dokumentiert (NICHT fürs Mitglied sichtbar –
// daher Notiz statt System-Nachricht, sonst läge ein fremder Name im Postfach).
// Der alte Vorgang wird beim Quell-Kunden entfernt (inkl. globalem Index).
async function reassign(fromMemberId, id, toMemberId, snapshot) {
  if (!hasStore || !fromMemberId || !id || !toMemberId) return null;
  const from = String(fromMemberId), to = String(toMemberId);
  const v = await get(from, id);
  if (!v) return null;
  if (from === to) return v;                       // schon dort -> nichts zu tun
  const seq = await nextSeq(to);
  const newId = String(seq);
  const now = Date.now();
  const ref = '#' + (PREFIX[v.type] || 'M') + '-' + String(1000 + seq);
  const fromName = (v.member && v.member.name) || ('Kunde ' + from);
  const moved = Object.assign({}, v, {
    id: newId, ref,
    member: snapshot || v.member || null,
    updatedAt: now,
    teamStatus: v.teamStatus === 'abgeschlossen' ? 'bearbeitung' : (v.teamStatus || 'neu'),
    teamUnread: true,
  });
  moved.notes = (v.notes || []).slice();
  moved.notes.push({ author: 'System', text: 'Vorgang von „' + fromName + '" übertragen (Zuordnung korrigiert).', at: now });
  delete moved._memberId;
  const cmds = [
    ['SET', vKey(to, newId), JSON.stringify(moved), 'EX', String(TTL)],
    ['LPUSH', idxKey(to), newId],
    ['LTRIM', idxKey(to), '0', String(MAX_LIST - 1)],
    ['EXPIRE', idxKey(to), String(TTL)],
  ];
  if (!TEAM_HIDDEN_TYPES[moved.type]) cmds.push(['ZADD', ALL_KEY, String(now), memberKey(to, newId)]);
  cmds.push(['ZREM', ALL_KEY, memberKey(from, id)]);   // alten Eintrag aus Team-Index
  cmds.push(['LREM', idxKey(from), '0', String(id)]);  // ... und aus der Mitglieds-Liste
  cmds.push(['DEL', vKey(from, id)]);                  // ... sowie den alten Wert löschen
  try { await redisPipeline(cmds); } catch (e) { return null; }
  moved._memberId = to;
  return moved;
}

// Zwei Vorgänge zusammenführen: alle Nachrichten + Notizen von (fromM,fromId)
// in (toM,toId) übernehmen (chronologisch, dedupliziert), Kanal/Telefon ergänzen
// und den Quell-Vorgang löschen (Liste + globaler Index + Wert). Liefert den
// zusammengeführten Ziel-Vorgang (inkl. _memberId) oder null. Wirft nie.
async function merge(fromM, fromId, toM, toId) {
  if (!hasStore || !fromM || !fromId || !toM || !toId) return null;
  if (String(fromM) === String(toM) && String(fromId) === String(toId)) return await get(toM, toId);
  const from = await get(fromM, fromId);
  const to = await get(toM, toId);
  if (!from || !to) return null;
  const now = Date.now();

  // Nachrichten mischen, chronologisch sortieren, über at|from|text-Präfix deduplizieren.
  const seen = {};
  const merged = [];
  (to.messages || []).concat(from.messages || [])
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .forEach((mm) => {
      if (!mm) return;
      const k = (mm.at || 0) + '|' + (mm.from || '') + '|' + String(mm.text || '').slice(0, 80);
      if (seen[k]) return; seen[k] = 1; merged.push(mm);
    });
  to.messages = merged.slice(-200);

  to.notes = (to.notes || []).concat(from.notes || []);
  to.notes.push({ author: 'System', text: 'Vorgang ' + (from.ref || ('#' + from.id)) + ' hierher zusammengeführt.', at: now });
  if (!to.phone && from.phone) to.phone = from.phone;
  if ((!to.channel || to.channel === 'portal') && from.channel && from.channel !== 'portal') to.channel = from.channel;
  to.teamUnread = true;
  to.updatedAt = now;
  await save(toM, to);

  // Quell-Vorgang entfernen (aus Team-Index, Mitglieds-Liste und als Wert).
  try {
    await redisPipeline([
      ['ZREM', ALL_KEY, memberKey(String(fromM), String(fromId))],
      ['LREM', idxKey(String(fromM)), '0', String(fromId)],
      ['DEL', vKey(String(fromM), String(fromId))],
    ]);
  } catch (e) {}
  to._memberId = String(toM);
  return to;
}

// ───────────────────────── Team-Backend ─────────────────────────

// Globalen Index lesen (neueste zuerst) und Vorgänge laden.
// Liefert Vorgänge inkl. v._memberId, System-/Begrüßungsfälle ausgenommen.
async function listAll(opts) {
  opts = opts || {};
  if (!hasStore) return [];
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 300, 1), ALL_CAP);
  let ids;
  try { [ids] = await redisPipeline([['ZREVRANGE', ALL_KEY, '0', String(limit - 1)]]); }
  catch (e) { return []; }
  if (!Array.isArray(ids) || !ids.length) return [];
  const pairs = ids.map(splitMemberKey).filter(Boolean);
  let res;
  try { res = await redisPipeline(pairs.map((p) => ['GET', vKey(p[0], p[1])])); }
  catch (e) { return []; }
  const out = [];
  (res || []).forEach((s, i) => {
    if (!s) return;
    try { const v = JSON.parse(s); if (TEAM_HIDDEN_TYPES[v.type]) return; v._memberId = pairs[i][0]; out.push(v); }
    catch (e) {}
  });
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

// Team-Metadaten setzen: teamStatus / priority / assignee.
async function setMeta(memberId, id, patch) {
  patch = patch || {};
  const v = await get(memberId, id);
  if (!v) return null;
  if (patch.teamStatus && TEAM_STATUSES.indexOf(patch.teamStatus) >= 0) {
    v.teamStatus = patch.teamStatus;
    if (patch.teamStatus === 'abgeschlossen') { v.status = 'abgeschlossen'; v.teamUnread = false; }
    else if (v.status === 'abgeschlossen') v.status = 'bearbeitung';
  }
  if (patch.priority && PRIORITIES.indexOf(patch.priority) >= 0) v.priority = patch.priority;
  if ('assignee' in patch) v.assignee = patch.assignee || null;
  v.updatedAt = Date.now();
  await save(memberId, v);
  return v;
}

// Interne Team-Notiz (nur Team, geht NICHT an das Mitglied).
async function addNote(memberId, id, note) {
  note = note || {};
  const text = String(note.text || '').slice(0, 2000).trim();
  if (!text) return null;
  const v = await get(memberId, id);
  if (!v) return null;
  v.notes = v.notes || [];
  v.notes.push({ author: String(note.author || 'Team').slice(0, 80), text, at: Date.now() });
  v.updatedAt = Date.now();
  await save(memberId, v);
  return v;
}

// Aus Team-Sicht als gelesen markieren (Öffnen des Vorgangs).
async function markTeamRead(memberId, id) {
  const v = await get(memberId, id);
  if (!v) return null;
  if (v.teamUnread) { v.teamUnread = false; await save(memberId, v); }
  return v;
}

// Einen bereits vorhandenen Vorgang nachträglich fürs Team markieren (als „neu"/
// ungelesen + Team-Push). Genutzt, wenn die WhatsApp-KI an einen Menschen übergibt,
// obwohl die auslösende Nachricht zuvor still (ohne Team-Alarm) protokolliert wurde.
async function alertTeam(memberId, id) {
  const v = await get(memberId, id);
  if (!v) return null;
  v.teamStatus = 'neu'; v.teamUnread = true; v.updatedAt = Date.now();
  await save(memberId, v);
  if (!TEAM_HIDDEN_TYPES[v.type]) await pushTeam(memberId, v, 'reply');
  return v;
}

// Member-Snapshot (Name/Nr/Initialen/…) am Vorgang hinterlegen (Lazy-Enrichment).
async function setMemberSnapshot(memberId, id, snap) {
  if (!snap) return null;
  const v = await get(memberId, id);
  if (!v) return null;
  v.member = snap;
  await save(memberId, v);
  return v;
}

module.exports = {
  addVorgang, list, get, save, markRead, reply, teamReply, resolve, unreadCount, reassign, merge,
  listAll, setMeta, addNote, markTeamRead, alertTeam, setMemberSnapshot,
  hasStore, PREFIX, TEAM_STATUSES, PRIORITIES,
};
