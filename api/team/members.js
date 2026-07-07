'use strict';

/**
 * Team-Backend: Mitglieder.
 *   GET                 -> { ok, members:[…] }   Verzeichnis (alle, mit denen wir Vorgänge haben)
 *   GET ?q=<suche>      -> { ok, results:[…] }   Magicline-Suche (E-Mail / Nummer / Name)
 *   GET ?id=<memberId>  -> { ok, profile:{…} }   Vollprofil (Stammdaten, Vertrag, Termine, Historie)
 *
 * Hinweis: Ein vollständiges Mitglieder-Verzeichnis aus Magicline bräuchte den
 * Scope MEMBER_LIST_READ (bewusst nicht angefragt). Daher: Verzeichnis = Mitglieder
 * mit Vorgängen + gezielte Suche über CUSTOMER_READ.
 */

const TA = require('../../lib/teamAuth');
const Inbox = require('../../lib/inbox');
const M = require('../../lib/members');
const View = require('../../lib/teamView');
const MLAccount = require('../../lib/mlAccount');
const Handled = require('../../lib/handled');

const ENRICH_CAP = 16;

function isCancelledAppt(a) {
  if (!a) return true;
  if (a.cancelled === true || a.canceled === true || a.deleted === true) return true;
  if (a.active === false) return true;
  const s = [a.status, a.appointmentStatus, a.bookingStatus, a.state].filter(Boolean).join(' ').toUpperCase();
  return /CANCEL|STORN|DELET|ABGESAGT|ABGELEHNT|NO_?SHOW|DECLIN/.test(s);
}

function mapSearch(c) {
  const name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim();
  const id = c.id != null ? String(c.id) : (c.customerId != null ? String(c.customerId) : null);
  return { id, name: name || 'Mitglied', nr: c.customerNumber || null, initials: View.initials(name || 'Mitglied'),
    email: c.email || null, phone: c.phonePrivate || c.phoneMobile || null };
}

// Magicline-Suche: E-Mail / Mitgliedsnummer / Name.
async function searchMembers(q) {
  q = String(q || '').trim();
  if (!q) return [];
  if (q.indexOf('@') >= 0) {
    try { const r = await M.ml('POST', '/customers/search', { email: q }); return Array.isArray(r.json) ? r.json : []; } catch (e) { return []; }
  }
  if (/^[0-9]{3,}$/.test(q)) {
    try { const r = await M.ml('GET', '/customers/by?customerNumber=' + encodeURIComponent(q)); if (r.status === 200 && r.json) return [r.json]; } catch (e) {}
    try { const r = await M.ml('POST', '/customers/search', { phoneNumber: q }); if (Array.isArray(r.json) && r.json.length) return r.json; } catch (e) {}
    return [];
  }
  const parts = q.split(/\s+/).filter(Boolean);
  const body = parts.length >= 2 ? { firstName: parts[0], lastName: parts.slice(1).join(' ') } : { lastName: parts[0] };
  try {
    let r = await M.ml('POST', '/customers/search', body);
    let arr = Array.isArray(r.json) ? r.json : [];
    if (!arr.length && parts.length === 1) { r = await M.ml('POST', '/customers/search', { firstName: parts[0] }); arr = Array.isArray(r.json) ? r.json : []; }
    return arr;
  } catch (e) { return []; }
}

// „BENEFIT_KEY" -> „Benefit key" (Fallback-Anzeigename, wenn die API nur den Key liefert).
function niceKey(k) {
  const s = String(k || '').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// Benefit-Eintrag robust normalisieren (Feldnamen der API können variieren).
function mapBenefit(b) {
  if (b == null) return null;
  if (typeof b === 'string') return { name: b, valid: true };
  const name = b.name || b.description || b.title || niceKey(b.key || b.benefitKey);
  if (!name) return null;
  return { name: String(name), valid: b.valid !== false };
}

// Benefits des Kunden (Scope CUSTOMER_BENEFIT_READ) – degradiert bei 403/404 zu available:false.
async function customerBenefits(id) {
  try {
    const r = await M.ml('GET', '/customers/' + encodeURIComponent(id) + '/benefits');
    if (r.status !== 200) return { available: false };
    const arr = Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.result) ? r.json.result : []);
    return { available: true, items: arr.map(mapBenefit).filter(Boolean) };
  } catch (e) { return { available: false }; }
}

// Zusatzfelder (Scope ADDITIONAL_INFORMATION_READ): Die Zuweisungen samt Wert liegen
// bereits im Kundenobjekt (additionalInformationFieldAssignments); die Felddefinitionen
// liefern Typ + Listen-Optionen, um IDs in lesbare Werte zu übersetzen.
async function additionalInfoOf(m) {
  try {
    const assigns = (m && Array.isArray(m.additionalInformationFieldAssignments)) ? m.additionalInformationFieldAssignments : [];
    if (!assigns.length) return { available: false };
    const defs = {};
    try {
      const r = await M.ml('GET', '/customers/additional-information-fields');
      if (r.status === 200) {
        const list = Array.isArray(r.json) ? r.json : (r.json && Array.isArray(r.json.result) ? r.json.result : []);
        list.forEach((f) => { if (f && f.id != null) defs[String(f.id)] = f; });
      }
    } catch (e) {}
    const fields = assigns.map((a) => {
      if (!a) return null;
      const def = defs[String(a.additionalInformationFieldId)] || null;
      const name = String(a.name || (def && def.name) || '').trim();
      let value = a.value != null ? String(a.value).trim() : '';
      if (def && def.type === 'LIST' && Array.isArray(def.listItems)) {
        const item = def.listItems.find((li) => li && String(li.id) === value);
        if (item && item.name) value = String(item.name);
      } else if (def && def.type === 'BOOLEAN') {
        value = value === 'true' ? 'Ja' : 'Nein';
      }
      return (name && value) ? { name, value } : null;
    }).filter(Boolean);
    return fields.length ? { available: true, fields } : { available: false };
  } catch (e) { return { available: false }; }
}

// ── Körpermaße / Fortschritt (Scope CUSTOMER_MEASUREMENT_READ) ──
// ANNAHME: Magicline liefert die erfassten Messwerte unter
// GET /customers/{id}/measurements. Endpunkt UND Feldstruktur sind nicht sicher
// dokumentiert, daher robust normalisieren: verschiedene Container- (Array/result/
// measurements/items/content) und Datums-/Werte-Schreibweisen werden abgedeckt.
// 403/404/Fehler/leere/unbekannte Form -> { available:false } -> UI blendet die Karte aus.
const MEAS_MAX = 8;

// Anzeigename + Einheit für gängige Messwert-Typen (Fallback: niceKey + keine Einheit).
const MEAS_META = {
  WEIGHT: { label: 'Gewicht', unit: 'kg' }, BODY_WEIGHT: { label: 'Gewicht', unit: 'kg' },
  BODY_FAT: { label: 'Körperfett', unit: '%' }, BODYFAT: { label: 'Körperfett', unit: '%' },
  BODY_FAT_PERCENTAGE: { label: 'Körperfett', unit: '%' }, FAT: { label: 'Körperfett', unit: '%' },
  MUSCLE: { label: 'Muskelmasse', unit: 'kg' }, MUSCLE_MASS: { label: 'Muskelmasse', unit: 'kg' },
  BMI: { label: 'BMI', unit: '' }, HEIGHT: { label: 'Größe', unit: 'cm' },
  BODY_WATER: { label: 'Wasser', unit: '%' }, WATER: { label: 'Wasser', unit: '%' },
  WAIST: { label: 'Taille', unit: 'cm' }, HIP: { label: 'Hüfte', unit: 'cm' },
  CHEST: { label: 'Brust', unit: 'cm' }, ARM: { label: 'Arm', unit: 'cm' },
  BICEPS: { label: 'Bizeps', unit: 'cm' }, THIGH: { label: 'Oberschenkel', unit: 'cm' },
  CALF: { label: 'Wade', unit: 'cm' }, NECK: { label: 'Nacken', unit: 'cm' },
  RESTING_HEART_RATE: { label: 'Ruhepuls', unit: 'bpm' },
};

// Datumsfeld einer Messung robust bestimmen (diverse Schreibweisen, sonst ISO-artiges Feld).
function measDate(o) {
  const keys = ['measurementDateTime', 'measurementDate', 'recordedDateTime', 'recordedDate', 'recordedAt', 'dateTime', 'date', 'createdDateTime', 'createdDate', 'created', 'timestamp'];
  for (const k of keys) { if (o[k]) return String(o[k]); }
  for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v; }
  return null;
}

// Einen Wert-Eintrag ({type/name/label, value, unit}) auf { label, value, unit } normalisieren.
function measValue(v) {
  if (v == null || typeof v !== 'object') return null;
  const rawKey = v.type || v.key || v.measurementType || v.code || v.name || v.label || '';
  const meta = MEAS_META[String(rawKey).toUpperCase().replace(/[\s-]+/g, '_')] || null;
  const label = v.label || v.name || (meta && meta.label) || niceKey(rawKey);
  let value = v.value != null ? v.value : (v.amount != null ? v.amount : (v.measurementValue != null ? v.measurementValue : null));
  if (value == null || value === '' || !label) return null;
  if (typeof value === 'number') value = Math.round(value * 100) / 100;
  const unit = v.unit || v.unitOfMeasure || v.uom || (meta && meta.unit) || '';
  return { label: String(label), value: String(value), unit: String(unit || '') };
}

// Fällt eine Messung „flach" aus (Werte als Felder statt Werte-Array), Skalarfelder ernten.
function measValuesFromFlat(o) {
  const skip = /(^id$|customer|member|date|time|created|updated|studio|note|comment|source|deleted|^_|type$|unit)/i;
  const out = [];
  for (const k of Object.keys(o)) {
    if (skip.test(k)) continue;
    const val = o[k];
    if (val == null || val === '') continue;
    if (typeof val === 'number' || (typeof val === 'string' && /^-?\d+([.,]\d+)?$/.test(val.trim()))) {
      const mv = measValue({ type: k, value: val });
      if (mv) out.push(mv);
    } else if (val && typeof val === 'object' && !Array.isArray(val) && (val.value != null || val.amount != null)) {
      const mv = measValue(Object.assign({ type: k }, val));
      if (mv) out.push(mv);
    }
  }
  return out;
}

async function measurementsOf(id) {
  try {
    const r = await M.ml('GET', '/customers/' + encodeURIComponent(id) + '/measurements');
    if (!r || r.status !== 200 || !r.json) return { available: false };
    const j = r.json;
    const list = Array.isArray(j) ? j
      : (Array.isArray(j.result) ? j.result
      : (Array.isArray(j.measurements) ? j.measurements
      : (Array.isArray(j.items) ? j.items
      : (Array.isArray(j.content) ? j.content : null))));
    if (!Array.isArray(list)) return { available: false };
    const items = list.map((row) => {
      if (!row || typeof row !== 'object') return null;
      const arr = Array.isArray(row.values) ? row.values
        : (Array.isArray(row.measurements) ? row.measurements
        : (Array.isArray(row.items) ? row.items
        : (Array.isArray(row.entries) ? row.entries
        : (Array.isArray(row.results) ? row.results : null))));
      const values = arr ? arr.map(measValue).filter(Boolean) : measValuesFromFlat(row);
      if (!values.length) return null;
      return { date: measDate(row), values };
    }).filter(Boolean);
    if (!items.length) return { available: false };
    items.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return (Number.isFinite(db) ? db : 0) - (Number.isFinite(da) ? da : 0);   // neueste zuerst
    });
    return { available: true, items: items.slice(0, MEAS_MAX) };
  } catch (e) { return { available: false }; }
}

// Verzeichnis aus den Vorgängen (Mitglieder, mit denen wir Kontakt hatten).
async function directory() {
  const all = await Inbox.listAll({ limit: 400 });
  // fehlende Snapshots gekappt nachladen + persistieren
  const need = []; const seen = {};
  for (const v of all) { const mid = v._memberId; if (mid && !seen[mid] && (!v.member || !v.member.name)) { seen[mid] = 1; need.push(mid); } }
  const snaps = {};
  await Promise.all(need.slice(0, ENRICH_CAP).map(async (mid) => {
    try { const mm = await M.getMember(mid); const s = View.snapshotFromMember(mm); if (s) snaps[mid] = s; } catch (e) {}
  }));
  const persists = [];
  for (const v of all) { if ((!v.member || !v.member.name) && snaps[v._memberId]) { v.member = snaps[v._memberId]; persists.push(Inbox.setMemberSnapshot(v._memberId, v.id, snaps[v._memberId]).catch(() => {})); } }
  if (persists.length) { try { await Promise.all(persists); } catch (e) {} }

  const by = {};
  for (const v of all) {
    const mid = v._memberId; if (!mid) continue;
    const g = by[mid] || (by[mid] = { memberId: mid, member: null, open: 0, total: 0, last: 0 });
    g.total++; if (v.teamStatus !== 'abgeschlossen') g.open++;
    if ((v.updatedAt || 0) > g.last) g.last = v.updatedAt || 0;
    if (!g.member && v.member && v.member.name) g.member = v.member;
  }
  return Object.keys(by).map((mid) => {
    const g = by[mid]; const mem = g.member || { name: 'Mitglied ' + mid, nr: null, initials: 'M' };
    return { memberId: mid, name: mem.name, nr: mem.nr || null, initials: mem.initials || 'M', openCount: g.open, total: g.total, lastActivity: g.last };
  }).sort((a, b) => b.lastActivity - a.lastActivity);
}

// Vollprofil eines Mitglieds.
async function profile(id) {
  const m = await M.getMember(id);
  if (!m) return null;
  const p = M.publicProfile(m) || {};
  let contract = null; try { contract = await M.getContract(id); } catch (e) {}
  let appointments = [];
  try {
    const r = await M.ml('GET', '/appointments/booking?customerId=' + encodeURIComponent(id));
    const list = Array.isArray(r.json) ? r.json : [];
    appointments = list.filter((a) => !isCancelledAppt(a))
      .map((a) => ({ bookingId: a.bookingId != null ? a.bookingId : (a.id != null ? a.id : (a.appointmentId != null ? a.appointmentId : null)), title: a.title || a.name || 'Termin', start: a.startDateTime || null, end: a.endDateTime || null }))
      .filter((a) => a.start).sort((x, y) => new Date(x.start) - new Date(y.start));
  } catch (e) {}
  let history = [];
  try {
    const hs = await Inbox.list(id);
    history = (hs || []).filter((v) => v.type !== 'willkommen').map((v) => ({
      key: id + ':' + v.id, id: v.id, type: v.type, subject: v.subject, ref: v.ref,
      teamStatus: v.teamStatus || 'neu', updatedAt: v.updatedAt || 0,
    }));
  } catch (e) {}
  // Zahlstatus (Scope CUSTOMER_ACCOUNT_READ) – degradiert bei 403 zu available:false.
  let account = { available: false };
  try { account = await MLAccount.accountSummary(id); } catch (e) {}
  // Benefits (CUSTOMER_BENEFIT_READ) + Zusatzfelder (ADDITIONAL_INFORMATION_READ) –
  // beide degradieren zu available:false, die UI blendet die Karten dann aus.
  let benefits = { available: false };
  try { benefits = await customerBenefits(id); } catch (e) {}
  let additionalInfo = { available: false };
  try { additionalInfo = await additionalInfoOf(m); } catch (e) {}
  // Körpermaße/Fortschritt (CUSTOMER_MEASUREMENT_READ) – degradiert zu available:false.
  let measurements = { available: false };
  try { measurements = await measurementsOf(id); } catch (e) {}
  // Automatisch gelöste Anfragen dieses Kunden (KI/System/Team) – best effort.
  let handled = { ai: 0, system: 0, team: 0 };
  try { handled = await Handled.forMember(id); } catch (e) {}
  const name = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
  const addr = [((p.street || '') + (p.houseNumber ? (' ' + p.houseNumber) : '')).trim(), ((p.zipCode || '') + ' ' + (p.city || '')).trim()].filter((s) => s).join(', ');
  return {
    id: String(id), name: name || 'Mitglied', initials: View.initials(name || 'Mitglied'),
    nr: p.customerNumber || null, email: p.email || null, phone: p.phonePrivate || null,
    birthday: p.dateOfBirth || null, address: addr || null, ibanMasked: p.ibanMasked || null,
    street: p.street || '', houseNumber: p.houseNumber || '', zipCode: p.zipCode || '', city: p.city || '',
    contract: contract, appointments: appointments, history: history, account: account,
    benefits: benefits, additionalInfo: additionalInfo, measurements: measurements,
    handled: handled,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const sess = await TA.requireTeam(req);
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' })); }

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  const q = url.searchParams.get('q');

  if (id) {
    const p = await profile(id);
    if (!p) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'not_found' })); }
    // Angestellte (Trainer) sehen keine Finanz-/Bankdaten: IBAN und Zahlstatus
    // werden serverseitig entfernt – nicht nur in der UI ausgeblendet.
    if (!TA.isAdmin(sess)) {
      p.ibanMasked = null;
      p.account = { available: false, restricted: true };
    }
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, profile: p }));
  }
  if (q != null && q.trim()) {
    const r = await searchMembers(q);
    res.statusCode = 200; return res.end(JSON.stringify({ ok: true, results: r.map(mapSearch).filter((x) => x.id) }));
  }
  if (!Inbox.hasStore) { res.statusCode = 200; return res.end(JSON.stringify({ ok: true, members: [] })); }
  const members = await directory();
  res.statusCode = 200; return res.end(JSON.stringify({ ok: true, members }));
};
