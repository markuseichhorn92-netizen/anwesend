'use strict';

/**
 * POST /api/phone/member
 *   { key, aktion, phone, code?, lastname?, dateOfBirth? }
 *
 * Auskunft zu den EIGENEN Daten am Telefon – Vertrag, Beitrag, Pause.
 *
 * ── Der Ablauf im Gespräch ──────────────────────────────────────────────────
 *   aktion=status   Bin ich schon ausgewiesen? Gibt KEINE Daten heraus, nur
 *                   „ja/nein" und über welchen Weg es weitergeht.
 *   aktion=code     Einmal-Code an den hinterlegten Kanal schicken.
 *   aktion=pruefen  Vorgelesenen Code prüfen -> ab jetzt verifiziert.
 *   aktion=vertrag  Tarif, Laufzeit, Kündigungsfrist, Beitrag.
 *   aktion=pause    Ob und wie pausiert werden kann, laufende Pausen.
 *
 * ── Warum ein Code und nicht nur die Anruferkennung ─────────────────────────
 * Die anrufende Nummer gegen Magicline zu prüfen ist der erste Faktor – aber
 * nur der erste. Rufnummern lassen sich fälschen; wer allein darauf baut, gibt
 * Vertragsdaten an jeden heraus, der eine Nummer kennt. Der Code geht deshalb an
 * einen Kanal, der dem Mitglied gehört (E-Mail/WhatsApp aus Magicline). Eine
 * gefälschte Anruferkennung nützt dann nichts.
 *
 * Wer über WhatsApp bereits verifiziert ist, hat beides für genau diese Nummer
 * schon erbracht – dann entfällt der Code (siehe lib/phoneAuth).
 *
 * ── Was hier NICHT herausgeht ───────────────────────────────────────────────
 * Trainings- und Ernährungsdaten, Atteste, Diagnosen: Gesundheitsdaten nach
 * Art. 9 DSGVO. Die brauchen eine eigene, nachweisbare Einwilligung, und die
 * lässt sich am Telefon nicht sauber einholen. Dafür verweist der Assistent auf
 * den Mitgliederbereich. Auch IBAN, vollständige Anschrift und Dokumente bleiben
 * draußen – sie beantworten keine der typischen Telefonfragen.
 */

const P = require('../../lib/phoneApi');
const A = require('../../lib/phoneAuth');
const M = require('../../lib/members');
const MM = require('../../lib/mlMembership');
const { sendLoginCode } = require('../../lib/loginCode');

const STUDIO_PHONE = '0651 308524';

function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 80); }

// „15. Oktober 2026“ – am Telefon liest niemand ein ISO-Datum vor.
function sprechTag(iso) {
  const d = new Date(String(iso || '').slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin',
    day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

function euro(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return n.toFixed(2).replace('.', ',') + ' Euro';
}

// Kanal nur andeuten, nie ausschreiben: „an Ihre E-Mail auf m…@gmail.com" wäre
// eine Auskunft an jemanden, der sich noch gar nicht ausgewiesen hat.
function kanalWort(channel) {
  if (channel === 'whatsapp') return 'per WhatsApp';
  if (channel === 'email') return 'per E-Mail';
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return P.json(res, 405, { ok: false, error: 'method_not_allowed' });
  const body = await P.readBody(req);
  // Streng begrenzt: hier hängt der Zugang zu persönlichen Daten dran.
  const g = await P.guard(req, body, 20);
  if (!g.ok) return P.json(res, g.code, g.body);

  const aktion = clean(body.aktion || body.action, 20).toLowerCase();
  const phone = clean(body.phone, 40);
  if (phone.replace(/[^\d]/g, '').length < 6) {
    return P.json(res, 200, { ok: false, error: 'missing',
      text: 'Dafür brauche ich die Rufnummer, die im Studio hinterlegt ist.' });
  }

  // Durchprobieren begrenzen – zusätzlich zur Begrenzung pro IP im Torwächter.
  try {
    const okR = await M.rateLimit('phonemem:' + M.normDePhone(phone), 10, 900);
    if (okR === false) {
      return P.json(res, 200, { ok: false, error: 'rate_limited',
        text: 'Das hat gerade nicht geklappt. Bitte melden Sie sich direkt unter ' + STUDIO_PHONE + '.' });
    }
  } catch (e) { /* Begrenzung darf den Anruf nicht verhindern */ }

  const st = await A.status(phone);

  // ── Code anfordern ─────────────────────────────────────────────────────────
  if (aktion === 'code' || aktion === 'ausweisen' || aktion === 'verifizieren') {
    if (st.verified) {
      return P.json(res, 200, { ok: true, verifiziert: true,
        text: 'Sie sind bereits ausgewiesen. Was möchten Sie wissen?' });
    }
    let kunde = null;
    try { kunde = await M.findByPhone(phone); } catch (e) { kunde = null; }
    // Ist die Nummer unbekannt, sagen wir das NICHT als solches – sonst liesse
    // sich durchprobieren, welche Nummern im Studio hinterlegt sind.
    if (!kunde) {
      P.logAttempt({ schritt: 'member', aktion: 'code', ok: false, status: 'nummer_unbekannt' });
      return P.json(res, 200, { ok: false, error: 'kein_versand',
        text: 'Ich konnte dazu nichts zustellen. Das Team hilft Ihnen gern weiter – '
          + 'unter ' + STUDIO_PHONE + ' oder über den Mitgliederbereich.' });
    }
    // Eigene Basis-URL fuer den Magic-Link in der Mail (gleiche Region, schnell).
    const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || null;
    let r = null;
    try { r = await sendLoginCode(kunde, host, { phone: phone }); } catch (e) { r = null; }
    if (r && r.challenge) await A.saveChallenge(phone, r.challenge);
    const wort = kanalWort(r && r.channel);
    P.logAttempt({ schritt: 'member', aktion: 'code', ok: !!wort, status: (r && r.channel) || 'kein_kanal' });
    if (!wort) {
      return P.json(res, 200, { ok: false, error: 'kein_versand',
        text: 'Ich konnte Ihnen gerade keinen Code zustellen. Bitte melden Sie sich unter '
          + STUDIO_PHONE + ', dann klärt das Team das direkt.' });
    }
    return P.json(res, 200, {
      ok: true, verifiziert: false, kanal: r.channel,
      text: 'Ich habe Ihnen einen sechsstelligen Code ' + wort + ' geschickt. '
        + 'Bitte lesen Sie ihn mir vor, dann kann ich weiterhelfen.',
      naechsterSchritt: 'Den vorgelesenen Code mit aktion=pruefen und dem Feld code senden. '
        + 'Der Code ist fuenf Minuten gueltig.',
    });
  }

  // ── Code prüfen ────────────────────────────────────────────────────────────
  if (aktion === 'pruefen' || aktion === 'code-pruefen' || aktion === 'bestaetigen') {
    const r = await A.checkCode(phone, body.code);
    P.logAttempt({ schritt: 'member', aktion: 'pruefen', ok: r.ok, status: r.grund });
    if (!r.ok) {
      return P.json(res, 200, { ok: false, error: 'code_falsch',
        text: r.grund === 'zu_viele_versuche'
          ? ('Das hat mehrfach nicht gepasst. Bitte melden Sie sich unter ' + STUDIO_PHONE + '.')
          : 'Der Code stimmt nicht oder ist abgelaufen. Soll ich einen neuen schicken?' });
    }
    await A.setVerified(phone, r.memberId, A.CONSENT_VERSION);
    return P.json(res, 200, { ok: true, verifiziert: true,
      text: 'Danke, das hat geklappt. Was möchten Sie wissen?' });
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  if (!aktion || aktion === 'status') {
    return P.json(res, 200, {
      ok: true, verifiziert: st.verified,
      text: st.verified
        ? 'Sie sind ausgewiesen. Was möchten Sie wissen?'
        : 'Für Auskünfte zu Ihrem Vertrag muss ich sichergehen, dass Sie es sind. '
          + 'Soll ich Ihnen dafür einen kurzen Code schicken?',
      naechsterSchritt: st.verified
        ? 'Direkt mit aktion=vertrag oder aktion=pause weitermachen.'
        : 'Mit aktion=code einen Einmal-Code zustellen lassen.',
    });
  }

  // ── Ab hier nur mit Nachweis ───────────────────────────────────────────────
  if (!st.verified) {
    P.logAttempt({ schritt: 'member', aktion: aktion, ok: false, status: 'nicht_verifiziert' });
    return P.json(res, 200, {
      ok: false, error: 'nicht_verifiziert', verifiziert: false,
      text: 'Dazu darf ich erst etwas sagen, wenn ich sicher bin, dass Sie es sind. '
        + 'Ich schicke Ihnen dafür gern einen kurzen Code – einverstanden?',
      naechsterSchritt: 'Mit aktion=code einen Einmal-Code zustellen lassen, danach aktion=pruefen.',
    });
  }
  await A.touch(phone);

  const mid = st.memberId;
  let ct = null;
  try { ct = await M.getContract(mid); } catch (e) { ct = null; }

  // ── Vertrag ────────────────────────────────────────────────────────────────
  if (aktion === 'vertrag' || aktion === 'mitgliedschaft' || aktion === 'laufzeit' || aktion === 'kuendigung') {
    if (!ct || !ct.contractId) {
      return P.json(res, 200, { ok: false, error: 'kein_vertrag',
        text: 'Ich sehe gerade keinen laufenden Vertrag. Das schaut das Team besser persönlich an – '
          + 'ich notiere gern einen Rückruf.' });
    }
    const teile = [];
    if (ct.tariffName || ct.name) teile.push('Ihr Tarif ist ' + clean(ct.tariffName || ct.name, 60));
    if (ct.endDate) teile.push('die Laufzeit endet am ' + sprechTag(ct.endDate));
    if (ct.lastPossibleCancellationDate) {
      teile.push('kündigen können Sie noch bis zum ' + sprechTag(ct.lastPossibleCancellationDate));
    }
    const preis = euro(ct.monthlyPrice != null ? ct.monthlyPrice : ct.price);
    if (preis) teile.push('der Beitrag liegt bei ' + preis + ' im Monat');

    P.logAttempt({ schritt: 'member', aktion: 'vertrag', ok: true, quelle: st.quelle });
    return P.json(res, 200, {
      ok: true,
      vertrag: {
        tarif: clean(ct.tariffName || ct.name, 60) || null,
        laufzeitEnde: ct.endDate || null,
        kuendigungBis: ct.lastPossibleCancellationDate || null,
        beitrag: preis,
        aktiv: ct.active !== false,
      },
      text: teile.length
        ? (teile.join(', ') + '.')
        : 'Zu Ihrem Vertrag kann ich hier gerade keine Einzelheiten sehen. Ich notiere gern einen Rückruf.',
    });
  }

  // ── Pause ──────────────────────────────────────────────────────────────────
  if (aktion === 'pause' || aktion === 'pausieren' || aktion === 'ruhen') {
    if (!ct || !ct.contractId || ct.active === false) {
      return P.json(res, 200, { ok: false, error: 'kein_vertrag',
        text: 'Dazu sehe ich gerade keinen laufenden Vertrag. Ich notiere gern einen Rückruf.' });
    }
    let cfg = null, rest = null, liste = null;
    try {
      const r = await Promise.all([MM.idleConfig(ct.contractId), MM.idleRemaining(ct.contractId), MM.idleList(ct.contractId)]);
      cfg = r[0]; rest = r[1]; liste = r[2];
    } catch (e) { cfg = null; }
    if (!cfg || !cfg.available) {
      return P.json(res, 200, { ok: false, error: 'nicht_verfuegbar',
        text: 'Eine Pause kann ich hier nicht selbst einrichten. Das Team klärt das gern mit Ihnen – '
          + 'ich notiere einen Rückruf, oder Sie erreichen uns unter ' + STUDIO_PHONE + '.' });
    }
    const laufend = (liste && liste.ok && Array.isArray(liste.current)) ? liste.current : [];
    const teile = [];
    if (laufend.length) {
      const p0 = laufend[0];
      teile.push('Ihr Vertrag ruht aktuell'
        + (p0 && p0.endDate ? (' bis zum ' + sprechTag(p0.endDate)) : ''));
    } else {
      teile.push('Ihr Vertrag läuft gerade normal');
      if (cfg.firstPossibleStartDate) teile.push('eine Pause wäre ab dem ' + sprechTag(cfg.firstPossibleStartDate) + ' möglich');
      if (rest && rest.ok && rest.freeTerms != null) {
        teile.push('Sie haben noch ' + rest.freeTerms + (rest.freeTerms === 1 ? ' Pause' : ' Pausen') + ' frei');
      }
      const geb = euro(cfg.fee);
      if (geb) teile.push('dafür fällt eine Gebühr von ' + geb + ' an');
    }
    P.logAttempt({ schritt: 'member', aktion: 'pause', ok: true, quelle: st.quelle, laufend: laufend.length });
    return P.json(res, 200, {
      ok: true,
      pause: {
        laufend: laufend.length > 0,
        bis: laufend.length && laufend[0].endDate ? laufend[0].endDate : null,
        abMoeglich: cfg.firstPossibleStartDate || null,
        freieTermine: (rest && rest.ok) ? rest.freeTerms : null,
        gebuehr: euro(cfg.fee),
      },
      text: teile.join(', ') + '.',
      // Einrichten heisst Vertrag aendern. Das laesst sich am Telefon nicht
      // nachweisbar erklaeren - dafuer der Mitgliederbereich oder das Team.
      naechsterSchritt: 'Die Pause NICHT am Telefon zusagen oder einrichten. Auf den Mitgliederbereich '
        + 'verweisen oder einen Rueckruf notieren.',
    });
  }

  // Gesundheitsbezogenes gehoert nicht auf diese Leitung - siehe Kopfkommentar.
  if (/training|ernaehr|ernähr|gewicht|attest|gesundheit|diagnose|kalorien/.test(aktion)) {
    return P.json(res, 200, { ok: false, error: 'nicht_am_telefon',
      text: 'Zu Trainings- und Gesundheitsdaten sage ich am Telefon bewusst nichts – '
        + 'die finden Sie in Ihrem Mitgliederbereich in der App. Soll ich Ihnen den Link schicken?' });
  }

  return P.json(res, 200, { ok: false, error: 'unknown_action',
    text: 'Das habe ich nicht verstanden. Ich kann etwas zu Ihrem Vertrag oder zur Pause sagen.' });
};
