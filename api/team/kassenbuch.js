'use strict';

/**
 * Team-Backend: Kassenbuch (Studio-Barkasse) – nur Admin (admin.manage, Finanzen).
 *   GET                          -> aktueller/letzter Monat + berechnete Werte + Preise + Monatsliste
 *   GET ?month=YYYY-MM           -> diesen Monat laden (mit Berechnung)
 *   GET ?month=YYYY-MM&pdf=1     -> gespeichertes PDF (nur abgeschlossene Monate), { ok, pdf }
 *   POST { action:'save', month, data }   -> Monat speichern (nur wenn nicht abgeschlossen)
 *   POST { action:'prices', prices }      -> Standard-Preisliste setzen
 *   POST { action:'check', month }        -> FINN prüft Plausibilität + Steuerliches
 *   POST { action:'close', month, pdf }   -> Monat abschließen (sperren) + PDF-Beleg ablegen
 *   POST { action:'reopen', month }       -> Abschluss zurücknehmen (Korrektur)
 *   POST { action:'beleg-scan', image }        -> FINN liest einen Kassenbon/Rechnung aus (Foto/PDF)
 *   POST { action:'beleg-save', month, day, image } -> gescannten Beleg zu einem Tag ablegen
 *   POST { action:'beleg-get',  month, day }   -> hinterlegten Beleg abrufen
 *   POST { action:'beleg-del',  month, day }   -> hinterlegten Beleg löschen
 */

const TA = require('../../lib/teamAuth');
const Cap = require('../../lib/capabilities');
const M = require('../../lib/members');
const KB = require('../../lib/kassenbuch');
const SEED = require('../../lib/kassenbuchSeed');
const AI = require('../../lib/ai');

function j(res, code, obj) { res.statusCode = code; return res.end(JSON.stringify(obj)); }
function curMonthKey() { const d = new Date(); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

async function monthPayload(key) {
  const stored = await KB.getMonth(key);
  const prices = await KB.getPrices();
  let base, carried = null;
  const seedM = SEED.SEED_2026.find((s) => s.key === key);
  if (stored) {
    base = stored;
  } else if (seedM) {
    // Altbestands-Monat, der noch nicht gespeichert ist: direkt aus dem Seed zeigen.
    base = SEED.seedRecord(seedM);
  } else {
    // Noch nicht erfasster Monat: Anfangsbestand + Blatt-Nr. aus dem Vormonat vorbelegen.
    let sug = await KB.suggestOpening(key);
    // Fallback auf die hinterlegten Altbestände (Seed), falls noch kein Monat gespeichert ist –
    // so ist der laufende Monat sofort vorbelegt (z. B. Juli aus Juni), auch ohne vorherigen Import.
    if (!sug.carried) {
      const prev = SEED.SEED_2026.filter((s) => s.key < key).sort((a, b) => (a.key < b.key ? -1 : 1)).pop();
      if (prev) sug = { carried: true, anfangsbestand: prev.endbestand, blattNr: KB.nextBlattNr(prev.blattNr), fromMonth: prev.key };
    }
    base = { key: key, year: parseInt(key.slice(0, 4), 10), month: parseInt(key.slice(5, 7), 10),
      blattNr: sug.blattNr || '', anfangsbestand: sug.anfangsbestand || 0, gezaehlterEndbestand: '', prices: prices, days: {} };
    if (sug.carried) carried = { anfangsbestand: sug.anfangsbestand, blattNr: sug.blattNr, fromMonth: sug.fromMonth };
  }
  const totals = KB.computeMonth(base);
  let belege = []; try { belege = await KB.listBelege(key); } catch (e) {}
  return {
    key: key, year: base.year, month: base.month, belege: belege,
    blattNr: base.blattNr || '', anfangsbestand: base.anfangsbestand || 0,
    gezaehlterEndbestand: (base.gezaehlterEndbestand == null ? '' : base.gezaehlterEndbestand),
    prices: totals.prices, days: base.days || {},
    closed: !!base.closed, closedAt: base.closedAt || null, closedBy: base.closedBy || null,
    updatedAt: base.updatedAt || null, check: base.check || null, exists: !!stored,
    imported: !!base.imported, source: base.source || null,
    carried: carried, totals: totals,
  };
}

// Wie viele Altbestands-Monate (Seed) sind noch NICHT hinterlegt?
async function seedPendingCount() {
  if (!KB.hasStore) return 0;
  let n = 0;
  for (const s of SEED.SEED_2026) { try { if (!(await KB.getMonth(s.key))) n++; } catch (e) {} }
  return n;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');

  const sess = await TA.requireTeam(req);
  if (!sess) return j(res, 401, { ok: false, error: 'unauthorized' });
  if (!Cap.requireCap(sess, 'admin.manage', res)) return;

  const url = (() => { try { return new URL(req.url, 'http://x'); } catch (e) { return { searchParams: new Map() }; } })();
  const qMonth = (url.searchParams.get && url.searchParams.get('month')) || '';
  const wantPdf = (url.searchParams.get && url.searchParams.get('pdf')) || '';

  if (req.method === 'GET') {
    if (qMonth && wantPdf) {
      if (!KB.isMonthKey(qMonth)) return j(res, 400, { ok: false, error: 'bad_month' });
      const pdf = await KB.getPdf(qMonth);
      return j(res, 200, { ok: true, month: qMonth, pdf: pdf || null });
    }
    const key = KB.isMonthKey(qMonth) ? qMonth : curMonthKey();
    // Selbstheilung: abweichende Archiv-Monate einmalig auf die geprüften Seed-Werte bringen.
    try { await KB.reconcileSeed(); } catch (e) {}
    let list = []; try { list = await KB.listMonths(); } catch (e) {}
    let seedPending = 0; try { seedPending = await seedPendingCount(); } catch (e) {}
    const payload = await monthPayload(key);
    return j(res, 200, { ok: true, hasStore: KB.hasStore, current: payload, months: list, seedPending: seedPending });
  }

  if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'method_not_allowed' });

  let body = {}; try { body = await M.readBody(req); } catch (e) { body = {}; }
  const action = String((body && body.action) || '');
  const month = String((body && body.month) || '');

  if (action === 'prices') {
    const p = await KB.setPrices(body.prices || {});
    return j(res, 200, { ok: true, prices: p });
  }

  if (action === 'importSeed') {
    if (!KB.hasStore) return j(res, 200, { ok: false, disabled: true, message: 'Kassenbuch-Speicher nicht verfügbar.' });
    let imported = 0, skipped = 0;
    for (const s of SEED.SEED_2026) {
      try { const r = await KB.importMonth(SEED.seedRecord(s)); if (r && r.ok) imported++; else skipped++; } catch (e) { skipped++; }
    }
    // Aktuelle Preisliste setzen, falls noch keine hinterlegt ist (Kaffee 2,00 seit Juni).
    try { const cur = await KB.getPrices(); if (!cur || Number(cur.kaffee) === Number(KB.DEFAULT_PRICES.kaffee)) await KB.setPrices(SEED.SEED_PRICES); } catch (e) {}
    let list = []; try { list = await KB.listMonths(); } catch (e) {}
    return j(res, 200, { ok: true, imported: imported, skipped: skipped, months: list, message: imported ? (imported + ' Kassenbücher übernommen.') : 'Alle Altbestände waren bereits hinterlegt.' });
  }

  // Beleg (Kassenbon/Rechnung) per Foto oder PDF von FINN auslesen lassen (kein Speichern).
  if (action === 'beleg-scan') {
    const img = String((body && body.image) || '');
    const mm = img.match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,(.+)$/);
    if (!mm) return j(res, 200, { ok: false, message: 'Kein gültiges Bild/PDF.' });
    if (img.length > 2.4e6) return j(res, 200, { ok: false, message: 'Datei zu groß – bitte ein kleineres Foto.' });
    const today = new Date().toISOString().slice(0, 10);
    let r; try { r = await AI.kassenbuchScanBeleg(mm[2], mm[1], { today: today }); } catch (e) { r = { ok: false }; }
    if (!r || !r.ok) return j(res, 200, { ok: false, message: (r && r.error === 'no_ai_key') ? 'FINN ist gerade nicht verfügbar.' : 'Der Beleg konnte nicht gelesen werden – bitte Werte von Hand eintragen.' });
    return j(res, 200, { ok: true, scan: { kind: r.kind, date: r.date, amount: r.amount, vendor: r.vendor, note: r.note, confidence: r.confidence } });
  }

  if (!KB.isMonthKey(month)) return j(res, 400, { ok: false, error: 'bad_month' });

  // Gescannten/hochgeladenen Beleg zu einem Tag ablegen / abrufen / löschen.
  if (action === 'beleg-save') {
    if (!KB.hasStore) return j(res, 200, { ok: false, disabled: true, message: 'Kassenbuch-Speicher nicht verfügbar.' });
    const r = await KB.saveBeleg(month, body.day, String((body && body.image) || ''));
    if (!r.ok) return j(res, 200, { ok: false, message: r.error === 'too_large' ? 'Beleg zu groß – bitte kleineres Foto.' : 'Beleg konnte nicht gespeichert werden.' });
    let belege = []; try { belege = await KB.listBelege(month); } catch (e) {}
    return j(res, 200, { ok: true, belege: belege });
  }
  if (action === 'beleg-get') {
    const img = await KB.getBeleg(month, body.day);
    return j(res, 200, { ok: true, image: img || null });
  }
  if (action === 'beleg-del') {
    await KB.delBeleg(month, body.day);
    let belege = []; try { belege = await KB.listBelege(month); } catch (e) {}
    return j(res, 200, { ok: true, belege: belege });
  }

  // Anfangsbestand/Blatt-Nr. aus dem Vormonat vorschlagen – auch für einen bereits
  // gespeicherten Monat (z. B. wenn der Vormonat nachträglich korrigiert wurde).
  // Gleiche Logik + Seed-Fallback wie beim ersten Öffnen (monthPayload).
  if (action === 'suggest') {
    let sug = await KB.suggestOpening(month);
    if (!sug.carried) {
      const prev = SEED.SEED_2026.filter((s) => s.key < month).sort((a, b) => (a.key < b.key ? -1 : 1)).pop();
      if (prev) sug = { carried: true, anfangsbestand: prev.endbestand, blattNr: KB.nextBlattNr(prev.blattNr), fromMonth: prev.key };
    }
    return j(res, 200, { ok: true, suggest: sug });
  }

  if (action === 'save') {
    if (!KB.hasStore) return j(res, 200, { ok: false, disabled: true, message: 'Kassenbuch-Speicher nicht verfügbar.' });
    const r = await KB.saveMonth(month, body.data || {});
    if (!r.ok) return j(res, 200, { ok: false, error: r.error, message: r.error === 'closed' ? 'Dieser Monat ist abgeschlossen und kann nicht geändert werden.' : 'Konnte nicht gespeichert werden.' });
    const payload = await monthPayload(month);
    return j(res, 200, { ok: true, current: payload });
  }

  if (action === 'check') {
    const stored = await KB.getMonth(month);
    const prices = await KB.getPrices();
    const base = stored || { key: month, year: parseInt(month.slice(0, 4), 10), month: parseInt(month.slice(5, 7), 10), anfangsbestand: 0, prices: prices, days: {} };
    const totals = KB.computeMonth(base);
    if (!totals.entriesCount) return j(res, 200, { ok: false, message: 'Für diesen Monat sind noch keine Buchungen erfasst.' });
    const text = KB.toPromptText(base, totals);
    let r; try { r = await AI.kassenbuchCheck({ text: text }); } catch (e) { r = { ok: false, error: 'ai_failed' }; }
    if (!r || !r.ok) return j(res, 200, { ok: false, message: (r && r.error === 'no_ai_key') ? 'FINN ist gerade nicht verfügbar.' : 'Die Prüfung hat nicht geklappt – bitte später erneut.' });
    const findings = r.findings || [];
    try { await KB.saveCheck(month, { findings: findings, text: r.raw || '' }); } catch (e) {}
    return j(res, 200, { ok: true, findings: findings, raw: r.raw || '', checkedAt: new Date().toISOString() });
  }

  if (action === 'close') {
    if (!KB.hasStore) return j(res, 200, { ok: false, disabled: true, message: 'Kassenbuch-Speicher nicht verfügbar.' });
    const name = (sess && (sess.name || sess.user)) || '';
    const r = await KB.closeMonth(month, String(body.pdf || ''), name);
    if (!r.ok) return j(res, 200, { ok: false, error: r.error, message: r.error === 'already_closed' ? 'Der Monat ist bereits abgeschlossen.' : 'Abschluss nicht möglich (Monat zuerst speichern).' });
    const payload = await monthPayload(month);
    return j(res, 200, { ok: true, current: payload });
  }

  if (action === 'reopen') {
    if (!KB.hasStore) return j(res, 200, { ok: false, disabled: true });
    await KB.reopenMonth(month);
    const payload = await monthPayload(month);
    return j(res, 200, { ok: true, current: payload });
  }

  return j(res, 400, { ok: false, error: 'unknown_action' });
};
