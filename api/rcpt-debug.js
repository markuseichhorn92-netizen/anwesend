'use strict';

/**
 * TEMPORÄR – Diagnose für Zustell-/Lesestatus. Zeigt für die neuesten Vorgänge
 * NUR technische Felder der Team-Nachrichten (Zeitstempel, Status, Kanal) –
 * KEIN Text, KEINE Namen, KEINE IDs. Wird nach der Prüfung wieder entfernt.
 */

const Inbox = require('../lib/inbox');
const WA = require('../lib/whatsapp');
const { hasMail } = require('../lib/mail');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const out = [];
  try {
    const all = await Inbox.listAll({ limit: 30 });
    for (const v of (all || [])) {
      const tms = (v.messages || []).filter((m) => m && m.from === 'team');
      if (!tms.length) continue;
      out.push({
        channel: v.channel || null,
        hasPhone: !!v.phone,
        teamMsgs: tms.length,
        withStatus: tms.filter((m) => m.st).length,
        recent: tms.slice(-3).map((m) => ({ at: m.at || 0, st: m.st || null, ch: m.ch || null })),
      });
    }
  } catch (e) {}

  res.statusCode = 200;
  return res.end(JSON.stringify({
    ok: true,
    config: { hasWhatsApp: WA.hasWhatsApp, hasTwilio: WA.hasTwilio, hasMeta: WA.hasMeta, hasMail: !!hasMail },
    vorgaenge: out.slice(0, 30),
  }, null, 2));
};
