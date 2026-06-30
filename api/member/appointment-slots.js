'use strict';

/**
 * GET /api/member/appointment-slots?id=<bookableAppointmentId>&days=<n>
 *   (Authorization: Bearer <token>)
 * Freie Slots einer Termin-Art (BOOKABLE_APPOINTMENTS_READ).
 *
 * Magicline begrenzt daysAhead auf max. 6. Um einen größeren Zeitraum
 * abzudecken, fragen wir mehrere 6-Tage-Fenster (slotWindowStartDate) parallel
 * ab und führen die Ergebnisse zusammen.
 */

const M = require('../../lib/members');

const WINDOW = 6; // max. daysAhead laut API

function ymd(d) {
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  let id = '', days = 21;
  try { const u = new URL(req.url, 'http://x'); id = u.searchParams.get('id') || ''; days = parseInt(u.searchParams.get('days') || '21', 10); } catch (e) {}
  if (!/^\d+$/.test(String(id))) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad_id' })); }
  if (!(days > 0)) days = 21; if (days > 42) days = 42;

  // Fenster-Startdaten erzeugen (heute, +6, +12, …)
  const starts = [];
  const today = new Date();
  for (let off = 0; off < days; off += WINDOW) {
    const d = new Date(today.getTime());
    d.setDate(d.getDate() + off);
    starts.push(ymd(d));
  }

  const cid = encodeURIComponent(sess.id);
  const base = '/appointments/bookable/' + encodeURIComponent(id) + '/slots';

  try {
    const results = await Promise.all(starts.map(function (startDate) {
      const path = base + '?daysAhead=' + WINDOW + '&slotWindowStartDate=' + startDate + '&customerId=' + cid;
      return M.ml('GET', path).then(function (r) { return Array.isArray(r.json) ? r.json : []; }).catch(function () { return []; });
    }));

    // Zusammenführen, nach Startzeit deduplizieren und sortieren.
    const seen = {};
    const slots = [];
    results.forEach(function (arr) {
      arr.forEach(function (s) {
        if (!s || !s.startDateTime || seen[s.startDateTime]) return;
        seen[s.startDateTime] = 1;
        const ins = Array.isArray(s.instructors) ? s.instructors : [];
        const first = ins[0] || null;
        slots.push({
          start: s.startDateTime,
          end: s.endDateTime || null,
          instructorIds: ins.map((i) => i.id).filter((x) => x != null),
          instructor: first ? (first.publicName || ((first.firstName || '') + ' ' + (first.lastName || '')).trim()) : '',
        });
      });
    });
    slots.sort(function (a, b) { return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0); });

    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, slots: slots }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, slots: [] }));
  }
};
