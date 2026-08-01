'use strict';
// Lead-Pipeline (lib/leadflow) – recordLead-Idempotenz & Anreicherung:
// per Telefonnummer UND per Magicline-customerId (kein Dublettenanlegen bei
// Webhook-Retries, Verknüpfung bestehender WhatsApp-Leads). In-Memory-KV mit ZSET.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => { const p = path.resolve(ROOT, rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

// In-Memory-Store: Strings + ein simpler ZSET (Map member->score).
const KV = new Map(), ZSETS = new Map();
inject('lib/store.js', {
  hasStore: true,
  redisPipeline: async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), k = String(c[1]);
    if (op === 'GET') return KV.has(k) ? KV.get(k) : null;
    if (op === 'SET') { KV.set(k, typeof c[2] === 'string' ? c[2] : String(c[2])); return 'OK'; }
    if (op === 'DEL') { KV.delete(k); ZSETS.delete(k); return 1; }
    if (op === 'INCR') { const n = (parseInt(KV.get(k), 10) || 0) + 1; KV.set(k, String(n)); return n; }
    if (op === 'EXPIRE') return 1;
    if (op === 'ZADD') { if (!ZSETS.has(k)) ZSETS.set(k, new Map()); ZSETS.get(k).set(String(c[3]), Number(c[2])); return 1; }
    if (op === 'ZREVRANGE') {
      const m = ZSETS.get(k); if (!m) return [];
      const arr = Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
      const s = parseInt(c[2], 10) || 0, e = parseInt(c[3], 10);
      return arr.slice(s, e < 0 ? undefined : e + 1);
    }
    if (op === 'ZREMRANGEBYRANK') return 0;   // Kappung im Test irrelevant
    return null;
  }),
});
// leadflow benötigt diese Module beim Laden – für recordLead/listLeads ungenutzt.
inject('lib/members.js', {});
inject('lib/inbox.js', {});
inject('lib/whatsapp.js', { hasWhatsApp: false });
inject('lib/teamView.js', { initials: (n) => String(n || '').slice(0, 2).toUpperCase() });

const L = require(path.join(ROOT, 'lib/leadflow.js'));

async function run() {
  let pass = true; const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // 1. Magicline-Lead anlegen (nur customerId, kein Telefon).
  const a = await L.recordLead({ customerId: 'c1', name: 'Max Muster', email: 'max@x.de', source: 'magicline' });
  ok('1. Lead angelegt (source magicline)', a && a.source === 'magicline' && a.customerId === 'c1' && a.name === 'Max Muster');
  ok('2. Liste hat 1 Lead', (await L.listLeads()).length === 1);

  // 3. Gleicher customerId erneut (Webhook-Retry) -> KEINE Dublette.
  await L.recordLead({ customerId: 'c1', name: 'Max Muster', source: 'magicline' });
  ok('3. Retry legt keine Dublette an', (await L.listLeads()).length === 1);

  // 4. WhatsApp-Lead per Telefon anlegen, danach mit customerId anreichern.
  const w = await L.recordLead({ phone: '491701234567', name: 'Erika Beispiel', source: 'whatsapp' });
  ok('4. WhatsApp-Lead angelegt', w && w.phone === '+491701234567' && !w.customerId);
  const w2 = await L.recordLead({ phone: '491701234567', customerId: 'c9' });
  ok('5. customerId nachträglich verknüpft (kein neuer Lead)', w2 && w2.id === w.id && w2.customerId === 'c9' && (await L.listLeads()).length === 2);

  // 6. Danach nur per customerId gefunden (cust-Map gesetzt) -> weiter keine Dublette.
  const w3 = await L.recordLead({ customerId: 'c9', email: 'erika@x.de' });
  ok('6. per customerId gefunden + angereichert', w3 && w3.id === w.id && w3.email === 'erika@x.de' && (await L.listLeads()).length === 2);

  console.log(pass ? 'LEADFLOW PASS' : 'LEADFLOW FAIL');
  process.exit(pass ? 0 : 1);
}
run().catch((e) => { console.error('FAIL', e); process.exit(1); });
