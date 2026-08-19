'use strict';
// Schichtplaner: Verfügbarkeit, Urlaub und Ausschreibungen.
//
// Bald arbeiten Angestellte mit eigenen Konten im Team-Bereich. Ab da ist jede
// dieser drei Sachen eine Entscheidung mit Folgen: wer wann arbeitet, wer frei
// bekommt, wer eine Schicht zugesagt bekommt. Deshalb prueft dieser Test nicht
// nur, ob gespeichert wird, sondern vor allem WER was darf - und zwar am
// Endpunkt, nicht in der Oberflaeche. Verstecken ist keine Sperre.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const inject = (rel, exports) => {
  const p = path.resolve(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exports };
};

async function run() {
  let pass = true;
  const ok = (l, c, extra) => { if (!c) pass = false; console.log((c ? 'OK  ' : 'FAIL') + ' ' + l + (c ? '' : ' -- ' + (extra || ''))); };

  // ── Speicher im Arbeitsspeicher ──
  const kv = new Map(), sets = new Map();
  const redisPipeline = async (cmds) => cmds.map((c) => {
    const op = String(c[0]).toUpperCase(), k = String(c[1]);
    if (op === 'GET') return kv.has(k) ? kv.get(k) : null;
    if (op === 'SET') { kv.set(k, c[2]); return 'OK'; }
    if (op === 'DEL') { kv.delete(k); return 1; }
    if (op === 'INCR') { const n = (parseInt(kv.get(k), 10) || 0) + 1; kv.set(k, String(n)); return n; }
    if (op === 'SADD') { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(String(c[2])); return 1; }
    if (op === 'SREM') { if (sets.has(k)) sets.get(k).delete(String(c[2])); return 1; }
    if (op === 'SMEMBERS') return sets.has(k) ? Array.from(sets.get(k)) : [];
    return 0;
  });
  inject('lib/store.js', { hasStore: true, redisPipeline: redisPipeline });

  // Die Rollenlogik selbst wird NICHT nachgebaut - lib/capabilities.js laeuft
  // echt und benutzt dieses roleOf. Ein Nachbau wuerde genau die Luecke
  // verstecken, die der Test finden soll.
  let session = null;
  inject('lib/teamAuth.js', {
    requireTeam: async () => session,
    roleOf: (s) => (s ? (s.role || 'trainer') : null),
    isAdmin: (s) => !!s && (s.role || 'trainer') === 'admin',
    TTL: 1,
  });
  let body = {};
  inject('lib/members.js', { readBody: async () => body, ml: async () => ({ status: 403, json: null }) });

  const SH = require(path.resolve(ROOT, 'lib/shifts.js'));
  const handler = require(path.resolve(ROOT, 'api/team/shifts.js'));

  const WOCHE = '2026-08-03';   // ein Montag
  const call = async (method, b) => {
    body = b || {};
    let out = '', code = 200;
    const res = { setHeader: () => {}, end: (s) => { out = s; }, get statusCode() { return code; }, set statusCode(v) { code = v; } };
    await handler({ method: method, url: '/api/team/shifts?week=' + WOCHE, headers: {} }, res);
    let json = {}; try { json = JSON.parse(out); } catch (e) {}
    return { status: code, json: json };
  };
  const alsLeitung = () => { session = { user: 'Admin', role: 'admin' }; };
  const alsAnna = () => { session = { user: 'Anna Beck', role: 'trainer', employeeId: 'e1' }; };
  const alsBen = () => { session = { user: 'Ben Cordes', role: 'trainer', employeeId: 'e2' }; };

  // ── 1. Verfügbarkeit als Schichtblöcke ──
  alsAnna();
  let r = await call('POST', { action: 'avail-set', week: WOCHE, blocks: { mo: [0, 1], di: [2, 3, 4], sa: [0] }, soft: { di: true } });
  ok('1. Eigene Verfügbarkeit laesst sich melden', r.json.ok === true, JSON.stringify(r.json.message || r.json.error || ''));
  const av = await SH.getAvailBlocks('e1');
  ok('1b. … und kommt so zurueck, wie sie gemeldet wurde',
    av.blocks.mo.join(',') === '0,1' && av.blocks.di.join(',') === '2,3,4' && av.soft.di === true,
    JSON.stringify(av.blocks));
  ok('1c. Selbst gemeldet ist als solches markiert', av.src === 'self' && av.reported === true, av.src);

  // Bloecke, die es am Tag nicht gibt, duerfen nicht durchrutschen: Samstag hat
  // zwei Schichten. Eine gespeicherte 5 waere spaeter ein undefined im Plan.
  await call('POST', { action: 'avail-set', week: WOCHE, blocks: { sa: [0, 1, 5, 99], so: [0, 1, 2] } });
  const av2 = await SH.getAvailBlocks('e1');
  ok('2. Bloecke, die es nicht gibt, werden verworfen',
    av2.blocks.sa.join(',') === '0,1' && av2.blocks.so.join(',') === '0,1', JSON.stringify({ sa: av2.blocks.sa, so: av2.blocks.so }));

  // Die grobe Form aus dem Bestand muss mitlaufen, sonst plant planWeek gegen
  // veraltete Angaben - zwei Wahrheiten waeren schlimmer als eine ungenaue.
  await call('POST', { action: 'avail-set', week: WOCHE, blocks: { mo: [0, 1], di: [2, 3, 4], mi: [0, 1, 2, 3, 4], do: [] } });
  const grob = await SH.getAvailability('e1');
  ok('3. Die grobe Angabe wird mitgeschrieben',
    grob.days.mo === 'frueh' && grob.days.di === 'spaet' && grob.days.mi === 'egal' && grob.days.do === 'frei',
    JSON.stringify(grob.days));

  // ── 2. Fuer andere eintragen ist ein Leitungsakt ──
  r = await call('POST', { action: 'avail-set', week: WOCHE, employeeId: 'e2', blocks: { mo: [0] } });
  ok('4. Eine Angestellte traegt NICHT fuer andere ein', r.json.ok === false, JSON.stringify(r.json));
  ok('4b. … und es wurde auch nichts gespeichert', (await SH.getAvailBlocks('e2')).reported === false);

  alsLeitung();
  r = await call('POST', { action: 'avail-set', week: WOCHE, employeeId: 'e2', name: 'Ben Cordes', blocks: { mo: [0, 1] } });
  const avB = await SH.getAvailBlocks('e2');
  ok('5. Die Leitung darf fuer andere eintragen', r.json.ok === true && avB.reported === true);
  // Der Entwurf faerbt die Quelle unterschiedlich ein. Das ist keine Zierde:
  // es sagt, wessen Angabe man vor sich hat.
  ok('5b. … und die Angabe ist als „von Leitung" markiert', avB.src === 'lead', avB.src);

  // ── 3. Urlaub ──
  alsAnna();
  r = await call('POST', { action: 'vac-create', week: WOCHE, from: '2026-08-24', to: '2026-08-20' });
  const vac1 = r.json.vacation;
  ok('6. Ein rueckwaerts eingegebener Zeitraum dreht sich um',
    !!vac1 && vac1.from === '2026-08-20' && vac1.to === '2026-08-24', JSON.stringify(vac1 || r.json));
  ok('6b. … und zaehlt beide Enden mit', vac1 && vac1.days === 5, vac1 && String(vac1.days));
  ok('6c. Ein neuer Antrag ist offen, nicht genehmigt', vac1 && vac1.status === 'pending', vac1 && vac1.status);
  // Ohne Antrag haengen alle folgenden Pruefungen in der Luft – dann lieber
  // hier sauber abbrechen als mit einem Stapelabzug enden.
  if (!vac1) { console.log('SHIFTS-PLAN FAIL'); process.exit(1); }

  r = await call('POST', { action: 'vac-create', week: WOCHE, from: '2026-08-20', to: '2027-05-20' });
  ok('7. Ein unsinnig langer Zeitraum wird abgelehnt', r.json.ok === false, JSON.stringify(r.json.vacation || ''));

  // Entscheiden ist Leitungssache. Genau hier waere eine Luecke teuer.
  r = await call('POST', { action: 'vac-decide', week: WOCHE, id: vac1.id, ok: true });
  ok('8. Eine Angestellte genehmigt ihren Urlaub NICHT selbst', r.json.ok === false, JSON.stringify(r.json));
  ok('8b. … der Antrag steht danach unveraendert offen',
    (await SH.getVacation(vac1.id)).status === 'pending');

  alsLeitung();
  r = await call('POST', { action: 'vac-decide', week: WOCHE, id: vac1.id, ok: true });
  const entschieden = await SH.getVacation(vac1.id);
  ok('9. Die Leitung entscheidet', r.json.ok === true && entschieden.status === 'approved', entschieden.status);
  ok('9b. … und es steht fest, wer das war', entschieden.decidedBy === 'Admin' && entschieden.decidedAt > 0,
    JSON.stringify({ w: entschieden.decidedBy, wann: entschieden.decidedAt }));

  // Ein genehmigter Urlaub ist eine Zusage - er verschwindet nicht still.
  alsAnna();
  r = await call('POST', { action: 'vac-delete', week: WOCHE, id: vac1.id });
  ok('10. Genehmigter Urlaub laesst sich nicht selbst loeschen', r.json.ok === false, JSON.stringify(r.json));
  ok('10b. … er ist auch noch da', !!(await SH.getVacation(vac1.id)));

  r = await call('POST', { action: 'vac-create', week: WOCHE, from: '2026-09-01', to: '2026-09-03' });
  const vac2 = r.json.vacation;
  r = await call('POST', { action: 'vac-delete', week: WOCHE, id: vac2.id });
  ok('11. Den eigenen OFFENEN Antrag darf man zurueckziehen',
    r.json.ok === true && !(await SH.getVacation(vac2.id)));

  // Fremde Antraege gehen niemanden etwas an.
  alsBen();
  r = await call('POST', { action: 'vac-create', week: WOCHE, from: '2026-08-10', to: '2026-08-11' });
  const vacBen = r.json.vacation;
  alsAnna();
  r = await call('POST', { action: 'vac-delete', week: WOCHE, id: vacBen.id });
  ok('12. Fremde Antraege lassen sich nicht loeschen', r.json.ok === false && !!(await SH.getVacation(vacBen.id)));

  // Abgelehnter Urlaub darf niemanden aus dem Plan nehmen.
  alsLeitung();
  await call('POST', { action: 'vac-decide', week: WOCHE, id: vacBen.id, ok: false });
  const alle = await SH.listVacations({});
  ok('13. Abgelehnter Urlaub zaehlt nicht als Abwesenheit',
    SH.isOnVacation(alle, 'e2', '2026-08-10') === false && SH.isOnVacation(alle, 'e1', '2026-08-21') === true);

  // ── 4. Ausschreibungen ──
  const sh1 = await SH.createShift({ date: '2026-08-05', start: '09:30', end: '11:30', role: 'flaeche', assignee: { id: 'e1', name: 'Anna Beck' } });
  ok('14. Eine Schicht laesst sich anlegen', !!sh1 && !!sh1.assignee);

  alsAnna();
  r = await call('POST', { action: 'post', week: WOCHE, id: sh1.id, mode: 'apply' });
  ok('15. Eine Angestellte schreibt NICHT aus', r.json.ok === false, JSON.stringify(r.json));

  alsLeitung();
  r = await call('POST', { action: 'post', week: WOCHE, id: sh1.id, mode: 'apply', deadline: 'heute 20:00' });
  const posted = await SH.getShift(sh1.id);
  ok('16. Die Leitung schreibt aus', r.json.ok === true && posted.postMode === 'apply' && posted.board === true, JSON.stringify(posted));
  // Ausschreiben heisst: die Schicht ist frei. Bliebe die Person darin stehen,
  // waere sie doppelt verplant.
  ok('16b. … und die Schicht ist danach wirklich frei', posted.assignee === null);

  alsBen();
  r = await call('POST', { action: 'apply-shift', week: WOCHE, id: sh1.id });
  alsAnna();
  await call('POST', { action: 'apply-shift', week: WOCHE, id: sh1.id });
  let mitBew = await SH.getShift(sh1.id);
  ok('17. Bewerbungen sammeln sich', mitBew.applicants.length === 2, JSON.stringify(mitBew.applicants.map((x) => x.id)));
  await call('POST', { action: 'apply-shift', week: WOCHE, id: sh1.id });
  mitBew = await SH.getShift(sh1.id);
  ok('17b. … doppelt bewerben geht nicht', mitBew.applicants.length === 2, String(mitBew.applicants.length));
  await call('POST', { action: 'withdraw', week: WOCHE, id: sh1.id });
  mitBew = await SH.getShift(sh1.id);
  ok('17c. … und zuruecknehmen wirkt', mitBew.applicants.length === 1 && mitBew.applicants[0].id === 'e2');

  r = await call('POST', { action: 'accept-applicant', week: WOCHE, id: sh1.id, employeeId: 'e2' });
  ok('18. Eine Angestellte sagt NICHT selbst zu', r.json.ok === false, JSON.stringify(r.json));

  alsLeitung();
  r = await call('POST', { action: 'accept-applicant', week: WOCHE, id: sh1.id, employeeId: 'e2' });
  const vergeben = await SH.getShift(sh1.id);
  ok('19. Die Leitung sagt zu', r.json.ok === true && vergeben.assignee && vergeben.assignee.id === 'e2', JSON.stringify(vergeben.assignee));
  ok('19b. … die Ausschreibung endet damit',
    vergeben.board === false && vergeben.postMode === null && vergeben.applicants.length === 0, JSON.stringify(vergeben));

  // Sofort-Uebernahme ist der andere Weg: wer zuerst zusagt, hat sie.
  const sh2 = await SH.createShift({ date: '2026-08-06', start: '15:00', end: '17:30', role: 'flaeche' });
  await call('POST', { action: 'post', week: WOCHE, id: sh2.id, mode: 'instant' });
  alsBen();
  await call('POST', { action: 'apply-shift', week: WOCHE, id: sh2.id });
  const sofort = await SH.getShift(sh2.id);
  ok('20. Sofort-Uebernahme vergibt ohne Zwischenschritt',
    sofort.assignee && sofort.assignee.id === 'e2' && sofort.board === false && sofort.postMode === null,
    JSON.stringify(sofort.assignee));
  alsAnna();
  r = await call('POST', { action: 'apply-shift', week: WOCHE, id: sh2.id });
  ok('20b. … die Zweite kommt zu spaet', r.json.ok === false, JSON.stringify(r.json));

  // ── 5. Was jede Rolle in der Wochenantwort sieht ──
  alsLeitung();
  r = await call('GET');
  const l = r.json;
  ok('21. Die Leitung sieht alle Verfuegbarkeiten', l.availability.length === 2, String(l.availability.length));
  ok('21b. … alle Urlaubsantraege', l.vacations.length >= 2 && l.vacations.some((v) => v.employeeId === 'e2'), String(l.vacations.length));
  ok('21c. … und darf entscheiden', l.canDecide === true);
  ok('21d. Die Schichtbloecke des Studios kommen mit', !!l.blocks && (l.blocks['1'] || l.blocks[1]).length === 5);

  alsAnna();
  r = await call('GET');
  const a = r.json;
  ok('22. Eine Angestellte sieht NUR die eigene Verfuegbarkeit',
    a.availability.length === 1 && a.availability[0].employeeId === 'e1', JSON.stringify(a.availability.map((x) => x.employeeId)));
  ok('22b. … und nur die eigenen Urlaubsantraege',
    a.vacations.length > 0 && a.vacations.every((v) => v.employeeId === 'e1'),
    JSON.stringify(a.vacations.map((v) => v.employeeId)));
  ok('22c. … und darf nicht entscheiden', a.canDecide === false);

  // Eine Sitzung ohne Rollenfeld ist ein Fehler - und dann gilt die kleinere
  // Berechtigung. Frueher wurde daraus hier still eine Leitung.
  session = { user: 'Irgendwer' };
  r = await call('POST', { action: 'vac-decide', week: WOCHE, id: vac1.id, ok: false });
  ok('23. Sitzung ohne Rollenfeld entscheidet nichts', r.json.ok === false, JSON.stringify(r.json));
  r = await call('GET');
  ok('23b. … und sieht auch nicht alles', r.json.canDecide === false && r.json.availability.length === 0,
    JSON.stringify({ d: r.json.canDecide, n: r.json.availability.length }));

  // ── 6. Mitarbeiter-Stammdaten ──
  // Bereich und Stundengrenze entscheiden mit, wer eingeplant werden darf.
  alsAnna();
  r = await call('POST', { action: 'staff-set', week: WOCHE, employeeId: 'e1', areas: ['reinigung'], monthMax: 300 });
  ok('25. Eine Angestellte pflegt KEINE Stammdaten', r.json.ok === false, JSON.stringify(r.json));

  alsLeitung();
  r = await call('POST', { action: 'staff-set', week: WOCHE, employeeId: 'e1', name: 'Anna Beck', type: 'Teilzeit', areas: ['flaeche', 'reinigung'], monthMax: 90, vacDays: 28 });
  const emp = await SH.getStaff('e1');
  ok('26. Die Leitung pflegt sie', r.json.ok === true && emp.type === 'Teilzeit' && emp.monthMax === 90 && emp.vacDays === 28,
    JSON.stringify(emp));
  ok('26b. … Bereiche werden gesaeubert', emp.areas.join(',') === 'flaeche,reinigung', emp.areas.join(','));
  ok('26c. … Initialen kommen aus dem Namen', emp.initials === 'AB', emp.initials);

  // Ausreisser kappen: eine 9999 im Stundenfeld waere kein Limit mehr.
  await call('POST', { action: 'staff-set', week: WOCHE, employeeId: 'e1', monthMax: 99999, vacDays: 999, areas: ['gibtesnicht'] });
  const emp2 = await SH.getStaff('e1');
  ok('27. Unsinnige Werte werden gekappt',
    emp2.monthMax === 400 && emp2.vacDays === 60 && emp2.areas.join(',') === 'flaeche',
    JSON.stringify({ m: emp2.monthMax, v: emp2.vacDays, a: emp2.areas }));

  // Ein Import darf gepflegte Angaben NICHT ueberschreiben - sonst waeren
  // Bereiche und Grenzen nach jedem Abgleich wieder Standard.
  await call('POST', { action: 'staff-set', week: WOCHE, employeeId: 'e1', type: 'Minijob', monthMax: 43.5 });
  r = await call('POST', { action: 'staff-import', week: WOCHE });
  const emp3 = await SH.getStaff('e1');
  ok('28. Import ohne Magicline meldet das ehrlich', r.json.ok === false, JSON.stringify(r.json.message || ''));
  ok('28b. … und ruehrt bestehende Angaben nicht an', emp3.type === 'Minijob' && emp3.monthMax === 43.5,
    JSON.stringify({ t: emp3.type, m: emp3.monthMax }));

  r = await call('GET');
  ok('29. Die Stammdaten kommen in der Wochenantwort mit',
    Array.isArray(r.json.staff) && r.json.staff.some((s) => s.id === 'e1'), JSON.stringify((r.json.staff || []).map((s) => s.id)));
  // Monatsstunden werden gerechnet, nicht gepflegt. Ben hat zwei Schichten im
  // August: 2 Std + 2,5 Std.
  const ben = (r.json.staff || []).filter((s) => s.id === 'e2')[0];
  ok('29b. Monatsstunden kommen aus den Schichten', ben && ben.monthHours === 4.5, JSON.stringify(ben && ben.monthHours));
  // Ben ist eingeplant, hat aber noch keinen Stammsatz. Er muss trotzdem in der
  // Liste stehen – sonst waere er im Plan sichtbar und in der Mitarbeiterliste
  // unsichtbar, und niemand kaeme darauf, ihn anzulegen.
  ok('29c. Wer eingeplant ist, steht in der Liste – auch ohne Stammsatz',
    ben && ben.stored === false && ben.name === 'Ben Cordes', JSON.stringify(ben && { s: ben.stored, n: ben.name }));

  // ── 7. Ohne Sitzung gar nichts ──
  session = null;
  r = await call('GET');
  ok('24. Ohne Sitzung 401', r.status === 401 && r.json.error === 'unauthorized', JSON.stringify(r));

  console.log(pass ? 'SHIFTS-PLAN PASS' : 'SHIFTS-PLAN FAIL');
  process.exit(pass ? 0 : 1);
}
run();
