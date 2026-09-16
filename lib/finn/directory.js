'use strict';

/**
 * FINN – MemberDirectoryProvider.
 * -----------------------------------------------------------------------------
 * Schnittstelle:
 *   { name, canList():Promise<bool>, search(q):Promise<[{id,name,nr,email?,phone?}]>, byId(id) }
 *
 * KnownCustomerProvider (JETZT): Personen, die das System bereits kennt –
 * Vorgänge im Postfach (lib/inbox.listAll), Leads (lib/leadflow), neue Mitglieder
 * (lib/newMembers) – plus die gezielte Magicline-Suche über CUSTOMER_READ
 * (E-Mail / Mitgliedsnummer / Name), genau wie api/team/members.js sie heute macht.
 * Es entsteht KEINE Vollliste.
 *
 * MagiclineMemberDirectoryProvider (SPÄTER): nur aktiv, wenn MEMBER_LIST_READ
 * deklariert und nicht als verboten gemerkt ist. Der Endpunkt ist absichtlich
 * NICHT implementiert (kein erfundener Pfad); `search` meldet `not_available`.
 *
 * Wichtig: Die Directory ist ausschließlich für den TEAM-Kanal. Im Mitglieder-
 * kanal identifiziert nur die Session – nie ein Name.
 */

const Cap = require('./capabilities');

function mapSearch(c) {
  const name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim();
  const id = c.id != null ? String(c.id) : (c.customerId != null ? String(c.customerId) : null);
  return { id: id, name: name || 'Mitglied', nr: c.customerNumber || null, email: c.email || null, phone: c.phonePrivate || c.phoneMobile || null, source: 'magicline' };
}

const KnownCustomerProvider = {
  name: 'known',
  async canList() { return false; },
  async search(q) {
    q = String(q || '').trim();
    if (q.length < 2) return [];
    const out = [];
    // 1) bekannte Vorgänge (eigener KV) – kein Magicline-Aufruf
    try {
      const Inbox = require('../inbox');
      const all = await Inbox.listAll({ limit: 400 });
      const nq = q.toLowerCase();
      const seen = {};
      (all || []).forEach((v) => {
        const m = v && v.member; const id = v && (v.memberId != null ? v.memberId : (v.key ? String(v.key).split(':')[0] : null));
        if (!m || !id || seen[id]) return;
        const hay = [m.name, m.nr, m.email, m.phone].filter(Boolean).join(' ').toLowerCase();
        if (hay.indexOf(nq) >= 0) { seen[id] = 1; out.push({ id: String(id), name: m.name || 'Mitglied', nr: m.nr || null, email: m.email || null, phone: m.phone || null, source: 'vorgang' }); }
      });
    } catch (e) {}
    // 2) gezielte Magicline-Suche (CUSTOMER_READ) – wie api/team/members.js
    if (await Cap.can('CUSTOMER_READ')) {
      try {
        const M = require('../members');
        let arr = [];
        if (q.indexOf('@') >= 0) arr = await M.searchByEmail(q);
        else if (/^[0-9]{3,}$/.test(q)) { const r = await M.ml('GET', '/customers/by?customerNumber=' + encodeURIComponent(q)); if (r.status === 200 && r.json) arr = [r.json]; await Cap.record('CUSTOMER_READ', r); }
        else {
          const parts = q.split(/\s+/).filter(Boolean);
          const body = parts.length >= 2 ? { firstName: parts[0], lastName: parts.slice(1).join(' ') } : { lastName: parts[0] };
          const r = await M.ml('POST', '/customers/search', body); await Cap.record('CUSTOMER_READ', r);
          arr = Array.isArray(r.json) ? r.json : [];
        }
        (arr || []).slice(0, 10).forEach((c) => { const m = mapSearch(c); if (m.id && !out.some((x) => x.id === m.id)) out.push(m); });
      } catch (e) {}
    }
    return out.slice(0, 10);
  },
  async byId(id) {
    try { const M = require('../members'); const m = await M.getMember(id); return m ? mapSearch(m) : null; } catch (e) { return null; }
  },
};

const MagiclineMemberDirectoryProvider = {
  name: 'magicline',
  async canList() { return Cap.can('MEMBER_LIST_READ'); },
  async search() {
    // Bewusst nicht implementiert: der Listen-Endpunkt wird erst mit dem Scope
    // (und seiner Dokumentation) ergänzt. Bis dahin: nicht verfügbar.
    return Object.assign([], { notAvailable: true });
  },
  async byId(id) { return KnownCustomerProvider.byId(id); },
};

async function provider() {
  return (await MagiclineMemberDirectoryProvider.canList()) ? MagiclineMemberDirectoryProvider : KnownCustomerProvider;
}

module.exports = { KnownCustomerProvider, MagiclineMemberDirectoryProvider, provider, mapSearch };
