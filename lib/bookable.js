'use strict';

/**
 * Buchbare Terminarten des Studios – Stoffwechselberatung, Einweisung,
 * Trainingsplanung und was sonst in Magicline angelegt ist.
 *
 * Das ist etwas ANDERES als das Probetraining. Das läuft über die öffentliche
 * Connect-API und legt einen Lead an; jeder darf es buchen. Diese Termine hier
 * gehören zu einem bestehenden Kunden und laufen über die authentifizierte
 * Open API – ohne `customerId` geht gar nichts. Wer sie am Telefon buchen will,
 * muss also erst zugeordnet werden.
 *
 * Zwei Eigenheiten der API, die den Zuschnitt bestimmen:
 *   • `daysAhead` ist auf 6 begrenzt. Ein größerer Zeitraum entsteht nur aus
 *     mehreren Fenstern – die holen wir parallel, sonst reicht die Zeit im
 *     Gespräch nicht.
 *   • Die Terminarten ändern sich praktisch nie. Sie werden deshalb eine Stunde
 *     zwischengespeichert; sonst kostet jede Frage „was bietet ihr an?" einen
 *     zusätzlichen Aufruf mitten im Satz.
 */

const M = require('./members');

const WINDOW = 6;              // Vorgabe der API
const TYPES_TTL = 3600000;     // 1 Stunde

let _types = null, _typesAt = 0;

/**
 * Alle buchbaren Terminarten. Liefert im Fehlerfall eine leere Liste – der
 * Anrufer bekommt dann „das kann ich gerade nicht sagen", keinen Absturz.
 * @returns {Promise<Array<{id:string,title:string,duration:number|null,category:string}>>}
 */
async function listTypes(force) {
  if (!force && _types && (Date.now() - _typesAt) < TYPES_TTL) return _types;
  let r = null;
  try { r = await M.ml('GET', '/appointments/bookable?sliceSize=100'); } catch (e) { return _types || []; }
  const arr = (r && r.json && Array.isArray(r.json.result)) ? r.json.result
    : (r && Array.isArray(r.json) ? r.json : []);
  const out = arr.map(function (a) {
    return {
      id: a.id != null ? String(a.id) : null,
      title: String(a.title || 'Termin').trim(),
      duration: a.duration || null,
      category: String(a.category || '').trim(),
    };
  }).filter(function (t) { return t.id; });
  if (out.length) { _types = out; _typesAt = Date.now(); }
  return out.length ? out : (_types || []);
}

// Vergleichbar machen: Gross/Klein, Umlaute, Bindestriche, Leerzeichen.
// Aus der Spracherkennung kommt „Stoffwechsel Beratung" genauso wie
// „Stoffwechselberatung".
function norm(v) {
  return String(v == null ? '' : v).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Gesprochenen Wunsch auf eine Terminart abbilden.
 *
 * Bewusst NICHT „irgendwas, das ungefähr passt": Bleiben mehrere Arten gleich
 * gut übrig, gibt es keinen Treffer. Dann fragt der Assistent lieber nach, statt
 * eine Stoffwechselberatung zu buchen, wo eine Einweisung gemeint war.
 *
 * @returns {{type:object|null, kandidaten:Array}}
 */
function matchType(types, wunsch) {
  const list = Array.isArray(types) ? types : [];
  const w = norm(wunsch);
  if (!w) return { type: null, kandidaten: list };

  // 1. Die ID direkt – falls der Assistent sie aus einer früheren Antwort hat.
  const byId = list.filter(function (t) { return String(t.id) === String(wunsch).trim(); });
  if (byId.length === 1) return { type: byId[0], kandidaten: [] };

  // 2. Genau derselbe Name.
  const exakt = list.filter(function (t) { return norm(t.title) === w; });
  if (exakt.length === 1) return { type: exakt[0], kandidaten: [] };

  // 3. Der eine steckt im anderen („Stoffwechsel" in „Stoffwechselberatung").
  const teil = list.filter(function (t) {
    const n = norm(t.title);
    return n.indexOf(w) >= 0 || w.indexOf(n) >= 0;
  });
  if (teil.length === 1) return { type: teil[0], kandidaten: [] };
  if (teil.length > 1) return { type: null, kandidaten: teil };

  // 4. Gemeinsame Wortanfänge – „Trainings Planung" trifft „Trainingsplanung".
  const worte = String(wunsch).toLowerCase().split(/[^a-zA-ZäöüßÄÖÜ0-9]+/)
    .map(norm).filter(function (x) { return x.length >= 4; });
  if (worte.length) {
    const treffer = list.filter(function (t) {
      const n = norm(t.title);
      return worte.some(function (x) { return n.indexOf(x) >= 0; });
    });
    if (treffer.length === 1) return { type: treffer[0], kandidaten: [] };
    if (treffer.length > 1) return { type: null, kandidaten: treffer };
  }

  // 5. Andersherum: wie viele Wörter des TITELS stecken im Gesagten?
  //
  // Nötig, weil im Deutschen zusammengeschrieben wird, was das Studio getrennt
  // benannt hat. „Stoffwechselberatung" ist ein einziges Wort und trifft deshalb
  // oben nichts – obwohl „Beratung Stoffwechsel-Coaching" gemeint ist. Von der
  // Titelseite aus gesehen stecken darin zwei der drei Wörter.
  const punkte = list.map(function (t) {
    const teile = String(t.title).toLowerCase().split(/[^a-zA-ZäöüßÄÖÜ0-9]+/)
      .map(norm).filter(function (x) { return x.length >= 4; });
    const n = teile.filter(function (x) { return w.indexOf(x) >= 0; }).length;
    return { t: t, n: n };
  }).filter(function (x) { return x.n > 0; });
  if (punkte.length) {
    const best = Math.max.apply(null, punkte.map(function (x) { return x.n; }));
    const oben = punkte.filter(function (x) { return x.n === best; });
    // Nur bei einem eindeutigen Sieger. Gleichstand heißt Rückfrage.
    if (oben.length === 1) return { type: oben[0].t, kandidaten: [] };
    return { type: null, kandidaten: oben.map(function (x) { return x.t; }) };
  }
  return { type: null, kandidaten: list };
}

function ymdAddLocal(ymd, days) {
  const d = new Date(String(ymd) + 'T12:00:00Z');
  if (isNaN(d.getTime())) return String(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Freie Slots einer Terminart ab einem Tag.
 *
 * `daysAhead` ist auf 6 begrenzt, deshalb mehrere Fenster – parallel, weil im
 * Gespräch jede Sekunde hörbar ist.
 *
 * @returns {Promise<Array<{start:string,end:string|null,instructorIds:Array,instructor:string}>>}
 */
async function freeSlots(typeId, customerId, startYMD, days) {
  const id = String(typeId == null ? '' : typeId);
  if (!/^\d+$/.test(id)) return [];
  let spanne = parseInt(days, 10);
  if (!(spanne > 0)) spanne = 21;
  if (spanne > 42) spanne = 42;

  const starts = [];
  for (let off = 0; off < spanne; off += WINDOW) starts.push(ymdAddLocal(startYMD, off));

  const base = '/appointments/bookable/' + encodeURIComponent(id) + '/slots';
  const cid = customerId != null ? ('&customerId=' + encodeURIComponent(customerId)) : '';
  let ergebnisse = [];
  try {
    ergebnisse = await Promise.all(starts.map(function (s) {
      return M.ml('GET', base + '?daysAhead=' + WINDOW + '&slotWindowStartDate=' + s + cid)
        .then(function (r) { return Array.isArray(r.json) ? r.json : []; })
        .catch(function () { return []; });
    }));
  } catch (e) { return []; }

  const seen = {};
  const out = [];
  const jetzt = Date.now();
  ergebnisse.forEach(function (arr) {
    arr.forEach(function (s) {
      if (!s || !s.startDateTime || seen[s.startDateTime]) return;
      const t = Date.parse(s.startDateTime);
      if (isNaN(t) || t <= jetzt) return;          // Vergangenes nie anbieten
      seen[s.startDateTime] = 1;
      const ins = Array.isArray(s.instructors) ? s.instructors : [];
      const erster = ins[0] || null;
      out.push({
        start: s.startDateTime,
        end: s.endDateTime || null,
        instructorIds: ins.map(function (i) { return i.id; }).filter(function (x) { return x != null; }),
        instructor: erster ? (erster.publicName || ((erster.firstName || '') + ' ' + (erster.lastName || '')).trim()) : '',
      });
    });
  });
  out.sort(function (a, b) { return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0); });
  return out;
}

/**
 * Termin buchen. `slot` stammt aus freeSlots – Ende und Trainer kommen also von
 * dort und nicht aus dem Gespräch. Was ein Sprachmodell nicht selbst ausrechnen
 * muss, kann es auch nicht falsch ausrechnen.
 */
async function book(customerId, typeId, slot) {
  const payload = {
    customerId: Number(customerId),
    bookableAppointmentId: Number(typeId),
    startDateTime: String(slot.start),
    endDateTime: String(slot.end || slot.start),
  };
  if (Array.isArray(slot.instructorIds) && slot.instructorIds.length) {
    const ids = slot.instructorIds.map(Number).filter(function (n) { return !isNaN(n); });
    if (ids.length) payload.instructorIds = ids;
  }
  let r = null;
  try { r = await M.ml('POST', '/appointments/booking/book', payload); } catch (e) { r = null; }
  return {
    ok: !!(r && r.status >= 200 && r.status < 300),
    status: (r && r.status) || null,
    bookingStatus: (r && r.json && r.json.bookingStatus) || null,
    text: String((r && (r.text || (r.json && JSON.stringify(r.json)))) || '').slice(0, 300),
  };
}

module.exports = { listTypes, matchType, freeSlots, book, norm, WINDOW };
