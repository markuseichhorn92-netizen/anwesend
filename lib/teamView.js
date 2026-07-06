'use strict';

/**
 * Aufbereitung von Vorgängen fürs Team-Backend (Mapping + Member-Snapshot).
 * Hält die API-Endpunkte schlank; Label-/Farb-Logik liegt im Frontend
 * (team-backend.html), hier nur die Datenform.
 */

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '–';
  const a = parts[0][0] || '';
  const b = parts.length > 1 ? (parts[parts.length - 1][0] || '') : '';
  return (a + b).toUpperCase();
}

// Aus einem Magicline-Kunden (getMember) einen schlanken Snapshot bauen.
function snapshotFromMember(m) {
  if (!m) return null;
  const name = ((m.firstName || '') + ' ' + (m.lastName || '')).trim();
  return {
    name: name || 'Mitglied',
    nr: m.customerNumber || null,
    initials: initials(name || 'Mitglied'),
    email: m.email || null,
    phone: m.phonePrivate || m.phoneMobile || m.phoneBusiness || null,
  };
}

// Anzeige-Member für einen Vorgang (Snapshot oder Fallback).
function memberOf(v) {
  if (v.member && v.member.name) return v.member;
  const phone = v.phone ? ('+' + String(v.phone).replace(/[^\d]/g, '')) : null;
  const name = phone || ('Mitglied ' + (v._memberId || ''));
  return { name, nr: null, initials: phone ? initials('') : 'M', email: null, phone: v.phone || null };
}

// Listeneintrag (leichtgewichtig, für die Konversationsliste).
function listItem(v) {
  const msgs = v.messages || [];
  const last = msgs[msgs.length - 1] || {};
  return {
    key: (v._memberId || '') + ':' + v.id,
    memberId: v._memberId || null,
    id: v.id,
    type: v.type || 'allgemein',
    subject: v.subject || 'Vorgang',
    ref: v.ref || '',
    channel: v.channel || 'portal',
    teamStatus: v.teamStatus || 'neu',
    priority: v.priority || 'mittel',
    assignee: v.assignee || null,
    teamUnread: !!v.teamUnread,
    updatedAt: v.updatedAt || 0,
    createdAt: v.createdAt || 0,
    member: memberOf(v),
    lastText: String(last.text || '').slice(0, 180),
    lastFrom: last.from || 'system',
    msgCount: msgs.length,
  };
}

// Voller Vorgang (für die Thread-Ansicht inkl. Nachrichten + Notizen).
function fullConversation(v, memberId) {
  return {
    key: (memberId != null ? memberId : v._memberId || '') + ':' + v.id,
    memberId: memberId != null ? String(memberId) : (v._memberId || null),
    id: v.id,
    type: v.type || 'allgemein',
    subject: v.subject || 'Vorgang',
    ref: v.ref || '',
    channel: v.channel || 'portal',
    teamStatus: v.teamStatus || 'neu',
    priority: v.priority || 'mittel',
    assignee: v.assignee || null,
    teamUnread: !!v.teamUnread,
    createdAt: v.createdAt || 0,
    updatedAt: v.updatedAt || 0,
    member: memberOf(v),
    messages: (v.messages || []).map((m) => ({
      from: m.from, text: m.text, at: m.at || 0,
      author: m.author || null, needsAction: !!m.needsAction,
      st: m.st || null, ch: m.ch || null,   // Zustell-/Lesestatus + Kanal (nur Team-Nachrichten)
    })),
    notes: (v.notes || []).map((n) => ({ author: n.author || 'Team', text: n.text, at: n.at || 0 })),
  };
}

module.exports = { initials, snapshotFromMember, memberOf, listItem, fullConversation };
