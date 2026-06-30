'use strict';

/**
 * GET /api/member/appointment-slots?id=<bookableAppointmentId>&days=<n>
 *   (Authorization: Bearer <token>)
 * Freie Slots einer Termin-Art (BOOKABLE_APPOINTMENTS_READ).
 */

const M = require('../../lib/members');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const sess = await M.getSession(M.bearer(req));
  if (!sess) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }

  let id = '', days = '21';
  try { const u = new URL(req.url, 'http://x'); id = u.searchParams.get('id') || ''; days = u.searchParams.get('days') || '21'; } catch (e) {}
  if (!/^\d+$/.test(String(id))) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad_id' })); }
  if (!/^\d{1,3}$/.test(String(days))) days = '21';

  try {
    const path = '/appointments/bookable/' + encodeURIComponent(id) + '/slots'
      + '?daysAhead=' + encodeURIComponent(days)
      + '&customerId=' + encodeURIComponent(sess.id);
    const r = await M.ml('GET', path);
    const arr = Array.isArray(r.json) ? r.json : [];
    const slots = arr.filter((s) => s && s.startDateTime).map((s) => {
      const ins = Array.isArray(s.instructors) ? s.instructors : [];
      const first = ins[0] || null;
      return {
        start: s.startDateTime,
        end: s.endDateTime || null,
        instructorIds: ins.map((i) => i.id).filter((x) => x != null),
        instructor: first ? (first.publicName || ((first.firstName || '') + ' ' + (first.lastName || '')).trim()) : '',
      };
    });
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, slots: slots }));
  } catch (e) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: false, slots: [] }));
  }
};
