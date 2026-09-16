'use strict';

/**
 * FINN – Tool-Registry und Ausführung.
 * -----------------------------------------------------------------------------
 * Jedes Tool: { name, description, input_schema, risk, scopes, actors, agents,
 *               run(ctx,args), preview?(ctx,args), validate?(ctx,args,result) }
 *
 *   risk   LOW    – lesen; läuft sofort
 *          MEDIUM – schreibt, aber gut umkehrbar (Termin, Kontaktdaten); Bestätigung nötig
 *          HIGH   – rechtlich/finanziell relevant (Kündigung, Pause, Modul, Bankdaten,
 *                   Datenschutz, Zugang); ausdrückliche Bestätigung + Ergebnisprüfung + Audit
 *   actors ['member','team','lead'] – wer das Tool überhaupt nutzen darf
 *   agents welche Agenten es sehen dürfen ('*' = alle)
 *
 * Ausführung (`execute`) ist die Durchsetzungsstelle – unabhängig davon, was ein
 * Modell „möchte": Aktor, Agent, Capability, Schema, Risiko, Rate-Limit, Audit.
 * Agenten erreichen Magicline NUR über diese Tools (lib/finn/magicline.js).
 *
 * Ziel-Kunde: Im Mitglieder-Kanal IMMER die Session-Id (ctx.actor.id) – nie ein
 * Argument. Im Team-Kanal darf `customerId` als Argument kommen (Team ist
 * serverseitig autorisiert), FINN prüft dann nur, dass es eine Id ist.
 */

const ML = require('./magicline');
const Cap = require('./capabilities');
const KV = require('./kv');
const U = require('./util');

const TOOL_LIMIT = { n: 80, sec: 3600 };   // Tool-Ausführungen je Aktor und Stunde
const RISK = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' };

function targetId(ctx, args) {
  if (ctx && ctx.actor && ctx.actor.kind === 'member') return ctx.actor.id;
  if (ctx && ctx.actor && ctx.actor.kind === 'team') {
    const v = (args && args.customerId != null) ? String(args.customerId) : (ctx.customerId != null ? String(ctx.customerId) : '');
    return /^[0-9]{1,12}$/.test(v) ? v : null;
  }
  return null;
}
async function contractIdFor(ctx, args) {
  const cid = targetId(ctx, args); if (!cid) return null;
  const c = await ML.contract.get(cid);
  return c.ok && c.data && c.data.contractId != null ? c.data.contractId : null;
}
const S = (d, extra) => Object.assign({ type: 'string', description: d }, extra || {});
const obj = (props, required) => ({ type: 'object', properties: props || {}, required: required || [] });
const CUST = { customerId: S('Kunden-Id (nur Team-Kanal; im Mitglieder-Kanal ignoriert)') };

// ── Die Tools ──
const TOOLS = [
  // Lesen (LOW)
  { name: 'get_profile', risk: RISK.LOW, scopes: ['CUSTOMER_READ'], actors: ['member', 'team'], agents: ['*'],
    description: 'Stammdaten der Person (Name, Kontakt, Adresse, IBAN maskiert).', input_schema: obj(CUST),
    run: (ctx, a) => ML.customer.get(targetId(ctx, a)) },
  { name: 'get_contract', risk: RISK.LOW, scopes: ['CUSTOMER_READ'], actors: ['member', 'team'], agents: ['*'],
    description: 'Hauptvertrag: Tarif, Status, Laufzeit, Kündigungsfrist, nächstmögliche Kündigung, Widerrufsrecht.', input_schema: obj(CUST),
    run: (ctx, a) => ML.contract.get(targetId(ctx, a)) },
  { name: 'get_account', risk: RISK.LOW, scopes: ['CUSTOMER_ACCOUNT_READ'], actors: ['member', 'team'], agents: ['payment', 'contract', 'concierge', 'retention', 'support', 'crm', 'handoff'],
    description: 'Beitragskonto: Saldo, offene Posten, Mahnstufe, Inkasso.', input_schema: obj(CUST),
    run: (ctx, a) => ML.account.summary(targetId(ctx, a)) },
  { name: 'list_appointments', risk: RISK.LOW, scopes: ['APPOINTMENTS_READ'], actors: ['member', 'team'], agents: ['appointment', 'concierge', 'member', 'crm', 'handoff'],
    description: 'Kommende gebuchte Termine der Person.', input_schema: obj(CUST),
    run: (ctx, a) => ML.appointments.mine(targetId(ctx, a)) },
  { name: 'list_appointment_types', risk: RISK.LOW, scopes: ['BOOKABLE_APPOINTMENTS_READ'], actors: ['member', 'team', 'lead'], agents: ['appointment', 'concierge', 'lead', 'studio'],
    description: 'Buchbare Terminarten (z. B. Stoffwechselanalyse, Einführungstraining) mit Ids.', input_schema: obj(),
    run: () => ML.appointments.types() },
  { name: 'find_appointment_slots', risk: RISK.LOW, scopes: ['BOOKABLE_APPOINTMENTS_READ'], actors: ['member', 'team'], agents: ['appointment', 'concierge'],
    description: 'Freie Slots einer Terminart ab einem Datum (YYYY-MM-DD), bis 21 Tage.',
    input_schema: obj(Object.assign({ typeId: S('Id der Terminart aus list_appointment_types'), startDate: S('Startdatum YYYY-MM-DD'), days: { type: 'integer', description: 'Zeitraum in Tagen (1–21)' } }, CUST), ['typeId']),
    run: async (ctx, a) => { const r = await ML.appointments.slots(a.typeId, targetId(ctx, a), a.startDate || U.todayYMD(), Math.min(21, a.days || 14)); if (r.ok) r.data = r.data.slice(0, 40); return r; } },
  { name: 'list_checkins', risk: RISK.LOW, scopes: ['CHECKIN_READ'], actors: ['member', 'team'], agents: ['member', 'access', 'concierge', 'retention', 'crm'],
    description: 'Letzte Besuche (Check-ins) der Person.', input_schema: obj(CUST),
    run: async (ctx, a) => { const r = await ML.checkins.recent(targetId(ctx, a)); if (r.ok) r.data = r.data.slice(0, 30); return r; } },
  { name: 'get_pause_options', risk: RISK.LOW, scopes: ['MEMBERSHIP_SELF_SERVICE_READ'], actors: ['member', 'team'], agents: ['contract', 'concierge', 'retention'],
    description: 'Pausen-Regeln des Vertrags: Gründe, Einheit, Maximum, frühester Start, Gebühr; plus bestehende Pausen.', input_schema: obj(CUST),
    run: async (ctx, a) => { const k = await contractIdFor(ctx, a); if (!k) return ML.fail('not_found', { status: 404 }); const [c, l] = await Promise.all([ML.pause.config(k), ML.pause.list(k)]); if (!c.ok) return c; c.data = Object.assign({ contractId: k }, c.data, { existing: l.ok ? l.data : null }); return c; } },
  { name: 'get_cancel_reasons', risk: RISK.LOW, scopes: ['MEMBERSHIP_SELF_SERVICE_READ'], actors: ['member', 'team'], agents: ['contract', 'retention'],
    description: 'Kündigungsgründe des Studios (Id + Name) – Pflichtangabe für eine Kündigung.', input_schema: obj(),
    run: () => ML.contract.cancelReasons() },
  { name: 'list_modules', risk: RISK.LOW, scopes: ['MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_READ'], actors: ['member', 'team'], agents: ['contract', 'concierge', 'payment'],
    description: 'Buchbare Zusatzmodule des Vertrags (Name, Preis, Laufzeit, Kündigung). Gebuchte Module kann die API nicht auflisten.', input_schema: obj(CUST),
    run: async (ctx, a) => { const k = await contractIdFor(ctx, a); if (!k) return ML.fail('not_found', { status: 404 }); const r = await ML.modules.list(k); if (r.ok) r.data.contractId = k; return r; } },
  { name: 'list_documents', risk: RISK.LOW, scopes: ['CUSTOMER_DOCUMENT_READ'], actors: ['member', 'team'], agents: ['document', 'contract', 'concierge'],
    description: 'Dokumente der Person in Magicline (Name, Datum).', input_schema: obj(CUST),
    run: (ctx, a) => ML.documents.list(targetId(ctx, a)) },
  { name: 'list_access_media', risk: RISK.LOW, scopes: ['CUSTOMER_ACCESS_MEDIUM_READ'], actors: ['member', 'team'], agents: ['access', 'concierge', 'support'],
    description: 'Zugangsmedien (Chip/Karte/Band) mit Status aktiv/gesperrt.', input_schema: obj(CUST),
    run: (ctx, a) => ML.access.list(targetId(ctx, a)) },
  { name: 'get_comm_prefs', risk: RISK.LOW, scopes: ['COMMUNICATION_PREFERENCES_READ'], actors: ['member', 'team'], agents: ['member', 'support', 'crm'],
    description: 'Werbe-/Kommunikations-Einwilligungen (E-Mail, Telefon, Post, SMS).', input_schema: obj(CUST),
    run: (ctx, a) => ML.comm.get(targetId(ctx, a)) },
  { name: 'get_studio_hours', risk: RISK.LOW, scopes: ['STUDIO_READ'], actors: ['member', 'team', 'lead'], agents: ['*'],
    description: 'Öffnungszeiten und Sonderzeiten des Studios.', input_schema: obj(),
    run: () => ML.studio.hours() },
  { name: 'get_utilization', risk: RISK.LOW, scopes: ['STUDIO_READ'], actors: ['member', 'team', 'lead'], agents: ['studio', 'concierge', 'member'],
    description: 'Aktuelle Auslastung des Studios.', input_schema: obj(),
    run: () => ML.studio.utilization() },
  { name: 'search_knowledge', risk: RISK.LOW, scopes: [], actors: ['member', 'team', 'lead'], agents: ['*'],
    description: 'Wissensbasis des Studios durchsuchen (Hilfe-Artikel, Regeln, Angebote). Live-Daten aus Magicline haben Vorrang.',
    input_schema: obj({ query: S('Suchbegriffe') }, ['query']),
    run: async (ctx, a) => { const K = require('./knowledge'); return ML.ok(await K.search(a.query, 4), null); } },

  // Schreiben, umkehrbar (MEDIUM)
  { name: 'book_appointment', risk: RISK.MEDIUM, scopes: ['APPOINTMENTS_WRITE'], actors: ['member', 'team'], agents: ['appointment', 'concierge'],
    description: 'Termin buchen. Slot MUSS aus find_appointment_slots stammen (start/end exakt übernehmen).',
    input_schema: obj(Object.assign({ typeId: S('Id der Terminart'), start: S('Startzeit ISO aus den Slots'), end: S('Endzeit ISO aus den Slots'), title: S('Titel der Terminart (für die Rückfrage)') }, CUST), ['typeId', 'start']),
    preview: (ctx, a) => 'Termin buchen: ' + (a.title || 'Termin') + ' am ' + U.fmtDT(a.start),
    run: (ctx, a) => ML.appointments.book(targetId(ctx, a), a.typeId, { start: a.start, end: a.end || a.start }),
    validate: async (ctx, a) => { const r = await ML.appointments.mine(targetId(ctx, a)); return { ok: !!(r.ok && r.data.some((x) => x.start === a.start)), note: r.ok ? 'Termin in der Liste gefunden' : 'Liste nicht lesbar' }; } },
  { name: 'cancel_appointment', risk: RISK.MEDIUM, scopes: ['APPOINTMENTS_WRITE'], actors: ['member', 'team'], agents: ['appointment', 'concierge'],
    description: 'Gebuchten Termin stornieren (bookingId aus list_appointments).',
    input_schema: obj(Object.assign({ bookingId: S('Buchungs-Id'), title: S('Titel (für die Rückfrage)'), start: S('Startzeit ISO (für die Rückfrage)') }, CUST), ['bookingId']),
    preview: (ctx, a) => 'Termin stornieren: ' + (a.title || 'Termin') + (a.start ? (' am ' + U.fmtDT(a.start)) : ''),
    run: (ctx, a) => ML.appointments.cancel(targetId(ctx, a), a.bookingId),
    validate: async (ctx, a) => { const r = await ML.appointments.mine(targetId(ctx, a)); return { ok: !!(r.ok && !r.data.some((x) => String(x.bookingId) === String(a.bookingId))), note: 'Termin nicht mehr in der Liste' }; } },
  { name: 'update_contact', risk: RISK.MEDIUM, scopes: ['CUSTOMER_SELF_SERVICE_WRITE'], actors: ['member', 'team'], agents: ['member', 'concierge'],
    description: 'E-Mail und/oder Telefonnummer ändern.',
    input_schema: obj(Object.assign({ email: S('Neue E-Mail-Adresse', { maxLength: 120 }), phone: S('Neue Telefonnummer', { maxLength: 40 }) }, CUST)),
    preview: (ctx, a) => 'Kontaktdaten ändern: ' + [a.email ? ('E-Mail → ' + a.email) : null, a.phone ? ('Telefon → ' + a.phone) : null].filter(Boolean).join(', '),
    run: (ctx, a) => { if (!a.email && !a.phone) return ML.fail('invalid', { status: 400 }); if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) return ML.fail('invalid', { status: 400 }); return ML.customer.updateContact(targetId(ctx, a), { email: a.email, phone: a.phone }); } },
  { name: 'update_address', risk: RISK.MEDIUM, scopes: ['CUSTOMER_SELF_SERVICE_WRITE'], actors: ['member', 'team'], agents: ['member', 'concierge'],
    description: 'Postadresse ändern.',
    input_schema: obj(Object.assign({ street: S('Straße'), houseNumber: S('Hausnummer'), zipCode: S('PLZ'), city: S('Ort') }, CUST), ['street', 'houseNumber', 'zipCode', 'city']),
    preview: (ctx, a) => 'Adresse ändern → ' + a.street + ' ' + a.houseNumber + ', ' + a.zipCode + ' ' + a.city,
    run: (ctx, a) => ML.customer.updateAddress(targetId(ctx, a), a) },
  { name: 'set_comm_prefs', risk: RISK.MEDIUM, scopes: ['COMMUNICATION_PREFERENCES_WRITE'], actors: ['member', 'team'], agents: ['member', 'support'],
    description: 'Werbe-Einwilligungen ändern (true/false je Kanal).',
    input_schema: obj(Object.assign({ email: { type: 'boolean' }, phone: { type: 'boolean' }, post: { type: 'boolean' }, sms: { type: 'boolean' } }, CUST)),
    preview: (ctx, a) => 'Einwilligungen ändern: ' + Object.keys(a).filter((k) => typeof a[k] === 'boolean').map((k) => k + ' ' + (a[k] ? 'an' : 'aus')).join(', '),
    run: (ctx, a) => { const p = {}; ['email', 'phone', 'post', 'sms'].forEach((k) => { if (typeof a[k] === 'boolean') p[k] = a[k]; }); return ML.comm.set(targetId(ctx, a), p); } },
  { name: 'checkin_now', risk: RISK.MEDIUM, scopes: ['CHECKIN_WRITE'], actors: ['member'], agents: ['access', 'concierge'],
    description: 'Die Person jetzt im Studio einchecken.', input_schema: obj(),
    preview: () => 'Jetzt einchecken',
    run: (ctx) => ML.checkins.checkin(targetId(ctx)) },
  { name: 'create_lead', risk: RISK.MEDIUM, scopes: ['LEAD_WRITE'], actors: ['lead', 'team'], agents: ['lead'],
    description: 'Interessent (Lead) in Magicline anlegen.',
    input_schema: obj({ firstname: S('Vorname'), lastname: S('Nachname'), email: S('E-Mail'), telephone: S('Telefon') }, ['firstname', 'lastname', 'email']),
    preview: (ctx, a) => 'Interessent anlegen: ' + a.firstname + ' ' + a.lastname,
    run: (ctx, a) => ML.leads.create(a) },

  // Rechtlich/finanziell relevant (HIGH)
  { name: 'cancel_contract', risk: RISK.HIGH, scopes: ['MEMBERSHIP_SELF_SERVICE_WRITE'], actors: ['member', 'team'], agents: ['contract'],
    description: 'Ordentliche Kündigung des Hauptvertrags zum nächstmöglichen Termin. Vorher get_contract (Datum) und get_cancel_reasons (Grund) aufrufen.',
    input_schema: obj(Object.assign({ contractId: S('Vertrags-Id aus get_contract'), cancelationReasonId: S('Grund-Id aus get_cancel_reasons'), cancelationDate: S('Kündigungsdatum YYYY-MM-DD = nächstmögliche Kündigung aus get_contract') }, CUST), ['contractId', 'cancelationReasonId', 'cancelationDate']),
    preview: (ctx, a) => 'Mitgliedschaft ordentlich kündigen zum ' + U.fmtDate(a.cancelationDate) + '. Danach endet der Vertrag zu diesem Datum.',
    run: async (ctx, a) => {
      // Datum und Vertrag gegen den echten Vertrag prüfen – das Modell darf nichts erfinden.
      const c = await ML.contract.get(targetId(ctx, a)); if (!c.ok) return c;
      if (String(c.data.contractId) !== String(a.contractId)) return ML.fail('invalid', { status: 400 });
      if (c.data.nextCancellationDateISO && a.cancelationDate < c.data.nextCancellationDateISO) return ML.fail('invalid_date', { status: 400 });
      return ML.contract.cancel(targetId(ctx, a), { contractId: a.contractId, cancelationReasonId: ML.num(a.cancelationReasonId) != null ? ML.num(a.cancelationReasonId) : a.cancelationReasonId, cancelationDate: a.cancelationDate });
    },
    validate: async (ctx, a) => { const c = await ML.contract.get(targetId(ctx, a)); return { ok: !!(c.ok && c.data.cancelled), note: c.ok ? ('Vertrag steht auf gekündigt: ' + (c.data.cancelled ? 'ja' : 'nein')) : 'Vertrag nicht lesbar' }; } },
  { name: 'withdraw_cancellation', risk: RISK.HIGH, scopes: ['MEMBERSHIP_SELF_SERVICE_WRITE'], actors: ['member', 'team'], agents: ['contract', 'retention'],
    description: 'Eine bestehende Kündigung zurücknehmen (Mitgliedschaft läuft weiter).',
    input_schema: obj(Object.assign({ contractId: S('Vertrags-Id aus get_contract') }, CUST), ['contractId']),
    preview: () => 'Kündigung zurücknehmen – die Mitgliedschaft läuft danach regulär weiter.',
    run: (ctx, a) => ML.contract.withdrawCancel(targetId(ctx, a), a.contractId),
    validate: async (ctx, a) => { const c = await ML.contract.get(targetId(ctx, a)); return { ok: !!(c.ok && !c.data.cancelled), note: 'Kündigungsstatus nachgelesen' }; } },
  { name: 'withdraw_contract', risk: RISK.HIGH, scopes: ['MEMBERSHIP_SELF_SERVICE_WRITE'], actors: ['member'], agents: ['contract'],
    description: '14-Tage-Widerruf eines online abgeschlossenen Vertrags. Nur wenn get_contract withdrawalEligible=true liefert.',
    input_schema: obj({ contractId: S('Vertrags-Id aus get_contract') }, ['contractId']),
    preview: () => 'Vertrag widerrufen (14-Tage-Widerruf). Der Vertrag gilt danach als nicht zustande gekommen.',
    run: async (ctx, a) => { const c = await ML.contract.get(targetId(ctx, a)); if (!c.ok) return c; if (!c.data.withdrawalEligible) return ML.fail('not_eligible', { status: 400 }); return ML.contract.withdrawal(targetId(ctx, a), a.contractId); },
    validate: async (ctx, a) => { const c = await ML.contract.get(targetId(ctx, a)); return { ok: !!(c.ok && c.data.reversed), note: 'Widerruf nachgelesen' }; } },
  { name: 'create_pause', risk: RISK.HIGH, scopes: ['MEMBERSHIP_SELF_SERVICE_WRITE'], actors: ['member', 'team'], agents: ['contract'],
    description: 'Beitragspause anlegen. Vorher get_pause_options (Gründe, Einheit, frühester Start).',
    input_schema: obj(Object.assign({ startDate: S('Beginn YYYY-MM-DD'), termValue: { type: 'integer', description: 'Dauer in Einheiten (temporalUnit aus get_pause_options)' }, reasonId: S('Grund-Id aus get_pause_options'), reasonName: S('Grund (für die Rückfrage)') }, CUST), ['startDate', 'termValue', 'reasonId']),
    preview: (ctx, a) => 'Beitragspause ab ' + U.fmtDate(a.startDate) + ' für ' + a.termValue + ' Einheit(en)' + (a.reasonName ? (', Grund: ' + a.reasonName) : ''),
    run: async (ctx, a) => {
      const k = await contractIdFor(ctx, a); if (!k) return ML.fail('not_found', { status: 404 });
      const cfg = await ML.pause.config(k); if (!cfg.ok) return cfg;
      const data = { startDate: a.startDate, temporalUnit: cfg.data.temporalUnit || 'WEEK', termValue: Number(a.termValue), unlimited: false, reasonId: ML.num(a.reasonId) != null ? ML.num(a.reasonId) : a.reasonId };
      const v = await ML.pause.validate(k, data); if (!v.ok) return v; if (!v.data.creatable) return ML.fail('not_creatable', { status: 400 });
      return ML.pause.create(k, data);
    },
    validate: async (ctx, a) => { const k = await contractIdFor(ctx, a); const l = k ? await ML.pause.list(k) : null; return { ok: !!(l && l.ok && l.data.current.some((p) => p.startDate === a.startDate)), note: 'Pause in der Liste gesucht' }; } },
  { name: 'withdraw_pause', risk: RISK.HIGH, scopes: ['MEMBERSHIP_SELF_SERVICE_WRITE'], actors: ['member', 'team'], agents: ['contract'],
    description: 'Eine geplante/beantragte Beitragspause zurückziehen (Id aus get_pause_options.existing).',
    input_schema: obj(Object.assign({ pauseId: S('Id der Pause') }, CUST), ['pauseId']),
    preview: () => 'Beitragspause zurückziehen',
    run: async (ctx, a) => { const k = await contractIdFor(ctx, a); if (!k) return ML.fail('not_found', { status: 404 }); return ML.pause.withdraw(k, a.pauseId); } },
  { name: 'book_module', risk: RISK.HIGH, scopes: ['MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_WRITE'], actors: ['member', 'team'], agents: ['contract'],
    description: 'Kostenpflichtiges Zusatzmodul buchen (Id aus list_modules). Preis, Laufzeit und Kündigung MÜSSEN vorher genannt worden sein.',
    input_schema: obj(Object.assign({ moduleId: S('Modul-Id'), name: S('Modulname'), price: S('Preis (für die Rückfrage)') }, CUST), ['moduleId']),
    preview: (ctx, a) => 'Zusatzmodul kostenpflichtig buchen: ' + (a.name || a.moduleId) + (a.price ? (' für ' + a.price) : '') + ' – Abrechnung über deinen Vertrag.',
    run: async (ctx, a) => { const k = await contractIdFor(ctx, a); if (!k) return ML.fail('not_found', { status: 404 }); return ML.modules.book(k, a.moduleId); } },
  { name: 'cancel_module', risk: RISK.HIGH, scopes: ['MEMBERSHIP_SELF_SERVICE_ADDITIONAL_MODULE_WRITE'], actors: ['member', 'team'], agents: ['contract'],
    description: 'Gebuchtes Zusatzmodul kündigen (Modul-Vertrags-Id). Die Mitgliedschaft bleibt bestehen.',
    input_schema: obj(Object.assign({ moduleContractId: S('Modul-Vertrags-Id'), cancelationDate: S('Datum YYYY-MM-DD'), cancelationReasonId: S('Grund-Id aus get_cancel_reasons'), name: S('Modulname') }, CUST), ['moduleContractId', 'cancelationDate', 'cancelationReasonId']),
    preview: (ctx, a) => 'Zusatzmodul kündigen: ' + (a.name || a.moduleContractId) + ' zum ' + U.fmtDate(a.cancelationDate) + '. Die Mitgliedschaft bleibt.',
    run: async (ctx, a) => { const k = await contractIdFor(ctx, a); if (!k) return ML.fail('not_found', { status: 404 }); return ML.modules.cancel(k, a.moduleContractId, { cancelationDate: a.cancelationDate, cancelationReasonId: a.cancelationReasonId }); } },
  { name: 'update_payment', risk: RISK.HIGH, scopes: ['CUSTOMER_SELF_SERVICE_WRITE'], actors: ['member'], agents: ['payment'],
    description: 'Bankverbindung (SEPA) ändern. IBAN wird serverseitig geprüft und nie zurückgegeben.',
    input_schema: obj({ accountHolder: S('Kontoinhaber'), iban: S('IBAN'), bic: S('BIC (optional)'), bankName: S('Bank (optional)') }, ['accountHolder', 'iban']),
    preview: (ctx, a) => 'Bankverbindung ändern auf IBAN ' + maskIban(a.iban) + ' (Kontoinhaber ' + a.accountHolder + ')',
    run: (ctx, a) => { const iban = String(a.iban || '').replace(/\s+/g, '').toUpperCase(); if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return ML.fail('invalid', { status: 400 }); return ML.customer.updatePayment(targetId(ctx), { accountHolder: a.accountHolder, iban: iban, bic: a.bic, bankName: a.bankName }); } },
  { name: 'block_access_medium', risk: RISK.HIGH, scopes: ['CUSTOMER_ACCESS_MEDIUM_WRITE'], actors: ['member', 'team'], agents: ['access'],
    description: 'Zugangsmedium sperren (z. B. Chip verloren). Id aus list_access_media.',
    input_schema: obj(Object.assign({ mediumId: S('Id des Mediums'), label: S('Bezeichnung (für die Rückfrage)') }, CUST), ['mediumId']),
    preview: (ctx, a) => 'Zugangsmedium sperren: ' + (a.label || a.mediumId) + '. Danach funktioniert es am Eingang nicht mehr.',
    run: (ctx, a) => ML.access.block(targetId(ctx, a), a.mediumId) },
  { name: 'unblock_access_medium', risk: RISK.HIGH, scopes: ['CUSTOMER_ACCESS_MEDIUM_WRITE'], actors: ['team'], agents: ['access'],
    description: 'Zugangsmedium entsperren (nur Team).',
    input_schema: obj(Object.assign({ mediumId: S('Id des Mediums') }, CUST), ['mediumId']),
    preview: (ctx, a) => 'Zugangsmedium entsperren: ' + a.mediumId,
    run: (ctx, a) => ML.access.unblock(targetId(ctx, a), a.mediumId) },

  // Übergabe an Menschen (LOW – erzeugt nur einen Vorgang im eigenen System)
  { name: 'handoff_to_team', risk: RISK.LOW, scopes: [], actors: ['member', 'lead', 'team'], agents: ['*'],
    description: 'Anliegen an das Studio-Team übergeben (Mensch meldet sich). Nutze das bei heiklen Themen, Beschwerden, fehlenden Rechten oder wenn du unsicher bist.',
    input_schema: obj({ reason: S('Kurzer Grund (ohne Gesundheitsdetails)', { maxLength: 200 }), summary: S('Zusammenfassung des Anliegens für das Team', { maxLength: 600 }) }, ['reason']),
    run: async (ctx, a) => { const H = require('./handoff'); const r = await H.create(ctx, { reason: a.reason, summary: a.summary }); return r.ok ? ML.ok({ ref: r.ref, handoff: true }, null) : ML.fail('failed', { status: 0 }); } },
];

function maskIban(iban) { const s = String(iban || '').replace(/\s+/g, ''); return s.length > 6 ? (s.slice(0, 4) + '…' + s.slice(-4)) : '…'; }

const BY_NAME = {}; TOOLS.forEach((t) => { BY_NAME[t.name] = t; });
function get(name) { return BY_NAME[String(name || '')] || null; }
function list() { return TOOLS.slice(); }

// ── Schema-Prüfung (klein, ausreichend für unsere flachen Schemata) ──
function validateArgs(schema, args) {
  args = args && typeof args === 'object' ? args : {};
  const props = (schema && schema.properties) || {};
  for (const k of ((schema && schema.required) || [])) {
    if (args[k] == null || args[k] === '') return { ok: false, error: 'missing_' + k };
  }
  const clean = {};
  for (const k of Object.keys(args)) {
    const p = props[k]; if (!p) continue;   // Unbekannte Felder verwerfen
    let v = args[k];
    if (v == null) continue;
    if (p.type === 'string') { v = String(v).trim(); if (p.maxLength && v.length > p.maxLength) return { ok: false, error: 'too_long_' + k }; if (v.length > 2000) return { ok: false, error: 'too_long_' + k }; }
    else if (p.type === 'integer') { v = parseInt(v, 10); if (!Number.isFinite(v)) return { ok: false, error: 'invalid_' + k }; }
    else if (p.type === 'number') { v = Number(v); if (!Number.isFinite(v)) return { ok: false, error: 'invalid_' + k }; }
    else if (p.type === 'boolean') { v = v === true || v === 'true'; }
    if (p.enum && p.enum.indexOf(v) < 0) return { ok: false, error: 'invalid_' + k };
    clean[k] = v;
  }
  return { ok: true, args: clean };
}

function allowedFor(tool, ctx) {
  const kind = ctx && ctx.actor && ctx.actor.kind;
  if (tool.actors.indexOf(kind) < 0) return false;
  const agent = ctx && ctx.agent;
  if (agent && tool.agents.indexOf('*') < 0 && tool.agents.indexOf(agent) < 0) return false;
  return true;
}

// Anthropic-Tool-Definitionen für einen Agenten/Kontext – nur was erlaubt UND
// (soweit bekannt) freigeschaltet ist.
async function toolsFor(ctx) {
  const out = [];
  for (const t of TOOLS) {
    if (!allowedFor(t, ctx)) continue;
    if (!(await Cap.canAll(t.scopes))) continue;
    const desc = t.description + (t.risk === RISK.LOW ? '' : (' [Aktion – wird dem Nutzer vor der Ausführung zur Bestätigung angezeigt; ' + (t.risk === RISK.HIGH ? 'rechtlich/finanziell relevant' : 'umkehrbar') + ']'));
    out.push({ name: t.name, description: desc, input_schema: t.input_schema });
  }
  return out;
}

// Vorschau-Text für die Bestätigung.
function preview(tool, ctx, args) {
  try { return tool.preview ? String(tool.preview(ctx, args)) : (tool.name + ' ausführen'); } catch (e) { return tool.name + ' ausführen'; }
}

/**
 * Tool ausführen. opts.confirmed = true nur aus der Confirmation Engine.
 * Rückgabe: Magicline-Format plus ggf. { needsConfirm:true, risk, preview } oder
 * { ok:false, error:'not_allowed'|'forbidden'|'rate_limited'|'invalid' }.
 */
async function execute(ctx, name, rawArgs, opts) {
  opts = opts || {};
  const t = get(name);
  const started = Date.now();
  const Audit = require('./audit');
  const Metrics = require('./metrics');
  const base = { tool: name, agent: ctx && ctx.agent, actor: ctx && ctx.actor, channel: ctx && ctx.channel, traceId: ctx && ctx.traceId };
  const done = async (r, status, extra) => {
    try { await Audit.record(Object.assign({}, base, { risk: t ? t.risk : null, status: status, via: r && r.via, code: r && r.error, ms: Date.now() - started }, extra || {})); } catch (e) {}
    try { await Metrics.bump('finn.tool.' + (t ? t.name : 'unknown') + '.' + status); } catch (e) {}
    return r;
  };
  if (!t) return done({ ok: false, forbidden: false, status: 0, data: null, error: 'unknown_tool', via: null }, 'rejected');
  // Bewusst KEIN 403-Status: „nicht erlaubt" ist eine Regel von uns, kein fehlender Magicline-Scope.
  if (!allowedFor(t, ctx)) return done(ML.fail('not_allowed', { status: 0 }), 'rejected');
  if (!(await Cap.canAll(t.scopes))) { const r = ML.fail('forbidden', { status: 403 }); r.forbidden = true; return done(r, 'forbidden'); }
  const v = validateArgs(t.input_schema, rawArgs);
  if (!v.ok) { const r = ML.fail('invalid', { status: 400 }); r.detail = v.error; return done(r, 'invalid'); }
  const args = v.args;
  if (ctx && ctx.actor && ctx.actor.kind !== 'team') delete args.customerId;   // nie vom Modell im Mitglieder-Kanal
  if (t.risk !== RISK.LOW && !opts.confirmed) {
    return { ok: false, needsConfirm: true, risk: t.risk, preview: preview(t, ctx, args), tool: t.name, args: args, error: 'needs_confirm', forbidden: false, status: 0, data: null, via: null };
  }
  // Rate-Limit je Aktor (Bestätigungen zählen mit).
  const actorKey = ctx && ctx.actor ? (ctx.actor.kind + ':' + ctx.actor.id) : 'anon';
  const n = await KV.incr('finnrl:tool:' + actorKey, TOOL_LIMIT.sec);
  if (n != null && n > TOOL_LIMIT.n) return done(ML.fail('rate_limited', { status: 429 }), 'rate_limited');

  let r;
  try { r = await t.run(ctx, args); } catch (e) { r = ML.fail('unavailable', { status: 0 }); }
  if (!r || typeof r !== 'object') r = ML.fail('failed', { status: 0 });
  if (r.ok && opts.confirmed && t.validate) {
    try { r.validated = await t.validate(ctx, args, r); } catch (e) { r.validated = { ok: false, note: 'Prüfung nicht möglich' }; }
  }
  return done(r, r.ok ? 'ok' : (r.forbidden ? 'forbidden' : 'failed'), { validated: r.validated ? !!r.validated.ok : null });
}

module.exports = { TOOLS, RISK, get, list, toolsFor, execute, validateArgs, preview, allowedFor, targetId, TOOL_LIMIT };
