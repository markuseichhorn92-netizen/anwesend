'use strict';

/**
 * POST /api/phone/member
 *   { key, aktion, phone, code?, neu? }
 *
 * Auskunft zu den EIGENEN Daten am Telefon – Vertrag, Beitrag, Pause.
 *
 * ── Der Ablauf im Gespräch ──────────────────────────────────────────────────
 *   aktion=status   Bin ich schon ausgewiesen? Gibt KEINE Daten heraus, nur
 *                   „ja/nein" und über welchen Weg es weitergeht.
 *   aktion=code     Einmal-Code an den hinterlegten Kanal schicken.
 *                   Mit neu=true auch dann, wenn schon ausgewiesen (zum Testen).
 *   aktion=abmelden Telefon-Verifizierung zuruecksetzen.
 *   aktion=eskalieren Anliegen mit allem Kontext an das Team uebergeben.
 *                   Am Telefon wird NICHTS ausgefuehrt - das macht ein Mensch.
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
const SR = require('../../lib/studioReply');

const STUDIO_PHONE = '0651 308524';

/**
 * Was am Telefon NICHT ausgeführt wird, sondern an einen Menschen geht.
 *
 * `hinweis` steht in der Übergabe an das Team – dort, wo etwas leicht übersehen
 * wird. `antwort` ist der Satz für den Anrufer und verspricht nie mehr als
 * „weitergegeben". `ersatz` ist der Weg, der auch ohne uns funktioniert.
 */
const ANLIEGEN = {
  kuendigung: {
    key: 'kuendigung', label: 'Kündigung', betreff: 'Kündigungswunsch (telefonisch)',
    // Rechtlich zählt, wann der Wunsch geäussert wurde – nicht, wann das Team
    // dazu kommt. Deshalb steht der Zeitpunkt oben in der Übergabe.
    hinweis: 'Der Kündigungswunsch wurde zum oben genannten Zeitpunkt telefonisch geäussert. '
      + 'Dieser Zeitpunkt ist für die Frist massgeblich, nicht der Tag der Bearbeitung. '
      + 'Bitte dem Mitglied den Eingang in Textform bestätigen, mit dem genauen Vertragsende.',
    antwort: 'Ich habe Ihren Kündigungswunsch mit Datum und Uhrzeit aufgenommen und an das Team '
      + 'weitergegeben – eine Kollegin oder ein Kollege meldet sich bei Ihnen und bestätigt '
      + 'Ihnen das schriftlich. Für die Frist zählt der heutige Tag.',
    ersatz: 'eine E-Mail an info@fit-inn-trier.de genügt in Textform, von jeder Adresse aus.',
  },
  pause: {
    key: 'pause', label: 'Beitragspause', betreff: 'Pausenwunsch (telefonisch)',
    hinweis: 'Bitte Zeitraum, Grund und mögliche Gebühr mit dem Mitglied klären.',
    antwort: 'Ich habe Ihren Pausenwunsch aufgenommen und an das Team weitergegeben. '
      + 'Eine Kollegin oder ein Kollege meldet sich bei Ihnen und richtet das ein.',
    ersatz: 'die Kolleginnen und Kollegen richten die Pause gern für Sie ein.',
  },
  vertrag: {
    key: 'vertrag', label: 'Vertragsänderung', betreff: 'Vertragsanliegen (telefonisch)',
    hinweis: '', antwort: 'Ich habe Ihr Anliegen aufgenommen und an das Team weitergegeben. '
      + 'Eine Kollegin oder ein Kollege meldet sich bei Ihnen.',
    ersatz: 'das Team klärt das gern direkt mit Ihnen.',
  },
  beitrag: {
    key: 'beitrag', label: 'Beitrag / Rechnung', betreff: 'Beitragsanliegen (telefonisch)',
    hinweis: '', antwort: 'Ich habe Ihr Anliegen aufgenommen und an das Team weitergegeben. '
      + 'Eine Kollegin oder ein Kollege meldet sich bei Ihnen.',
    ersatz: 'das Team klärt das gern direkt mit Ihnen.',
  },
  beschwerde: {
    key: 'beschwerde', label: 'Beschwerde', betreff: 'Beschwerde (telefonisch)',
    hinweis: 'Bitte zeitnah persönlich melden.',
    antwort: 'Danke, dass Sie das ansprechen. Ich habe es aufgenommen und weitergegeben – '
      + 'jemand aus dem Team meldet sich bei Ihnen.',
    ersatz: 'das Team meldet sich gern persönlich bei Ihnen.',
  },
  sonstiges: {
    key: 'sonstiges', label: 'Sonstiges', betreff: 'Anliegen (telefonisch)',
    hinweis: '', antwort: 'Ich habe Ihr Anliegen aufgenommen und an das Team weitergegeben. '
      + 'Eine Kollegin oder ein Kollege meldet sich bei Ihnen.',
    ersatz: 'das Team hilft Ihnen gern weiter.',
  },
};

function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 80); }

// „04.05.1990" und „1990-05-04" sind dasselbe Datum – wie in appointment.js.
function normDob(v) {
  const t = clean(v, 20);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) {
    const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
    if (d) m = [null, d[3], ('0' + d[2]).slice(-2), ('0' + d[1]).slice(-2)];
  }
  return m ? (m[1] + '-' + m[2] + '-' + m[3]) : '';
}

/**
 * Wer ruft da an – auch wenn die Nummer nicht im Studio hinterlegt ist?
 *
 * Der Regelfall ist die Anruferkennung. Sie versagt aber genau dann, wenn jemand
 * gar keine Nummer im Profil hat, vom Festnetz eines Dritten anruft oder die
 * Nummer unterdrueckt. Dann bleibt der Weg ueber Angaben, die das Mitglied selbst
 * nennen kann: Mitgliedsnummer plus Geburtsdatum, oder E-Mail plus Geburtsdatum.
 *
 * Beides identifiziert nur – es weist NICHT aus. Der Ausweis bleibt der Code, und
 * der geht danach an einen Kanal aus dem Profil. Deshalb ist es unbedenklich,
 * hier mehrere Wege anzubieten: Wer sich falsch identifiziert, bekommt einen Code
 * an die Adresse eines Fremden und kommt keinen Schritt weiter.
 */
async function findeMitglied(body, phone) {
  let kunde = null;
  try { kunde = await M.findByPhone(phone); } catch (e) { kunde = null; }
  if (kunde) return { kunde: kunde, weg: 'rufnummer' };

  const dob = normDob(body.dateOfBirth || body.geburtsdatum);
  if (dob) {
    const nummer = clean(body.customerNumber || body.mitgliedsnummer, 24);
    if (nummer) {
      try { kunde = await M.findByNumberDob(nummer, dob); } catch (e) { kunde = null; }
      if (kunde) return { kunde: kunde, weg: 'mitgliedsnummer' };
    }
    const mail = clean(body.email, 120);
    if (mail) {
      try { kunde = await M.findByEmailDob(mail, dob); } catch (e) { kunde = null; }
      if (kunde) return { kunde: kunde, weg: 'email' };
    }
  }
  return { kunde: null, weg: null };
}

// Ueber welche Kanaele koennte ein Code ueberhaupt zugestellt werden?
// Ohne einen einzigen ist Selbstbedienung nicht moeglich – das muss der Anrufer
// erfahren, statt es dreimal vergeblich zu versuchen.
async function kanaeleVon(kunde) {
  let voll = kunde;
  if (kunde && !kunde.email && kunde.id != null) {
    try { const m = await M.getMember(kunde.id); if (m) voll = m; } catch (e) { /* egal */ }
  }
  const hatMail = !!(voll && voll.email);
  const hatHandy = !!(voll && (voll.phonePrivate || voll.phoneMobile || voll.phoneBusiness));
  return { hatMail: hatMail, hatHandy: hatHandy, keiner: !hatMail && !hatHandy, voll: voll };
}

// „15. Oktober 2026“ – am Telefon liest niemand ein ISO-Datum vor.
function sprechTag(iso) {
  const d = new Date(String(iso || '').slice(0, 10) + 'T12:00:00Z');
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin',
    day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

// „im Monat" / „pro Woche" - ohne die Zahlweise ist ein Betrag nichtssagend.
function zahlweise(unit) {
  const u = String(unit || '').toUpperCase();
  if (u.indexOf('MONTH') >= 0) return 'im Monat';
  if (u.indexOf('WEEK') >= 0) return 'pro Woche';
  if (u.indexOf('YEAR') >= 0) return 'im Jahr';
  if (u.indexOf('QUARTER') >= 0) return 'im Quartal';
  return '';
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
    // `neu` erzwingt den Code-Weg, auch wenn die Nummer schon ausgewiesen ist.
    // Gebraucht zum Testen: Wer ueber WhatsApp verifiziert ist, ueberspringt den
    // Code sonst und bekaeme den Ablauf nie zu sehen. Kein Sicherheitsloch - es
    // wird dabei nur MEHR verlangt, nie weniger.
    const neuAusweisen = body.neu === true || body.neu === 'true' || body.neu === 1 || body.neu === '1';
    if (st.verified && !neuAusweisen) {
      return P.json(res, 200, { ok: true, verifiziert: true, quelle: st.quelle,
        text: 'Sie sind bereits ausgewiesen. Was möchten Sie wissen?' });
    }
    const gefunden = await findeMitglied(body, phone);
    const kunde = gefunden.kunde;
    // Ist niemand zu finden, sagen wir NICHT „diese Nummer kennen wir nicht" –
    // sonst liesse sich durchprobieren, welche Nummern im Studio hinterlegt sind.
    // Stattdessen der Hinweis auf die Angaben, mit denen es doch noch geht.
    if (!kunde) {
      P.logAttempt({ schritt: 'member', aktion: 'code', ok: false, status: 'nicht_gefunden' });
      return P.json(res, 200, {
        ok: false, error: 'nicht_gefunden',
        text: 'Über diese Nummer finde ich Sie nicht – vielleicht ist eine andere bei uns '
          + 'hinterlegt. Nennen Sie mir Ihre Mitgliedsnummer und Ihr Geburtsdatum, dann '
          + 'versuche ich es darüber.',
        naechsterSchritt: 'Erneut aktion=code aufrufen, zusaetzlich mit customerNumber und '
          + 'dateOfBirth. Alternativ email und dateOfBirth. Findet sich auch damit nichts: '
          + 'Rueckruf notieren.',
      });
    }

    // Weder E-Mail noch Handynummer im Profil: Dann gibt es keinen Weg, auf dem
    // ein Code ankommen koennte. Das ehrlich sagen, statt es scheitern zu lassen.
    const kan = await kanaeleVon(kunde);
    if (kan.keiner) {
      P.logAttempt({ schritt: 'member', aktion: 'code', ok: false, status: 'kein_kanal_im_profil' });
      return P.json(res, 200, {
        ok: false, error: 'kein_kanal',
        text: 'Bei Ihnen ist weder eine E-Mail-Adresse noch eine Handynummer hinterlegt – '
          + 'deshalb kann ich Ihnen keinen Code schicken. Am schnellsten geht es im Studio: '
          + 'Dort tragen die Kolleginnen und Kollegen das kurz ein, danach klappt es auch '
          + 'telefonisch. Soll ich einen Rückruf notieren?',
        naechsterSchritt: 'Rueckruf mit topic=sonstiges notieren und im Text vermerken, dass '
          + 'E-Mail oder Handynummer im Profil fehlen.',
      });
    }
    // Eigene Basis-URL fuer den Magic-Link in der Mail (gleiche Region, schnell).
    const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || null;
    let r = null;
    try { r = await sendLoginCode(kan.voll || kunde, host, { phone: phone }); } catch (e) { r = null; }
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

  // ── Anliegen an einen Menschen übergeben ───────────────────────────────────
  // Grundsatz: Auskunft gibt der Assistent, HANDELN tut ein Mensch. Kündigung,
  // Pause, Vertragsänderung, Beschwerde — nichts davon wird am Telefon
  // ausgeführt. Der Assistent nimmt auf, was das Team braucht, und übergibt.
  //
  // Steht bewusst VOR der Ausweispflicht: Wer sein Anliegen loswerden will, soll
  // das immer können. Ob der Anrufer ausgewiesen war, steht in der Eskalation
  // ausdrücklich drin — sonst könnte jemand fremde Vertragsdaten in eine
  // Übergabe hineinerzählen und das Team hielte sie für geprüft.
  if (aktion === 'eskalieren' || aktion === 'kuendigen' || aktion === 'kuendigung-link'
      || aktion === 'beenden' || aktion === 'uebergeben' || aktion === 'mitarbeiter') {
    const anliegen = ANLIEGEN[clean(body.anliegen, 24).toLowerCase()]
      || (/kuendig|beenden/.test(aktion) ? ANLIEGEN.kuendigung : ANLIEGEN.sonstiges);
    // Der Zeitpunkt ist bei einer Kündigung nicht Beiwerk: Massgeblich ist,
    // wann der Wunsch geäussert wurde, nicht wann das Team dazu kommt.
    const wannISO = new Date(Date.now()).toISOString();
    const wann = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'full', timeStyle: 'short' })
      .format(new Date(Date.now()));

    const gef = await findeMitglied(body, phone);
    const kunde = gef.kunde;
    let ct = null;
    if (kunde) { try { ct = await M.getContract(kunde.id); } catch (e) { ct = null; } }

    const z = [];
    z.push('Anliegen:      ' + anliegen.label);
    z.push('Eingegangen:   ' + wann + '  (' + wannISO + ')');
    z.push('Rufnummer:     ' + phone);
    z.push('Name genannt:  ' + (clean(body.name, 80) || '—'));
    z.push('');
    if (kunde) {
      z.push('── Zuordnung ──');
      z.push('Mitglied:      ' + [kunde.firstName, kunde.lastName].filter(Boolean).join(' ')
        + (kunde.customerNumber ? ' (' + kunde.customerNumber + ')' : ''));
      z.push('Gefunden über: ' + gef.weg);
      // Der wichtigste Satz für das Team: Wurde die Identität geprüft?
      z.push(st.verified
        ? ('AUSGEWIESEN:   ja (' + (st.quelle || 'unbekannt') + ') – Identität wurde geprüft.')
        : 'AUSGEWIESEN:   NEIN – nur zugeordnet, NICHT geprüft. Vor dem Handeln bestätigen.');
      if (ct) {
        z.push('');
        z.push('── Vertrag ──');
        if (ct.rateName) z.push('Tarif:         ' + ct.rateName);
        if (ct.startDate) z.push('Beginn:        ' + ct.startDate);
        if (ct.endDate) z.push('Laufzeit bis:  ' + ct.endDate);
        if (ct.deadline) z.push('Kündigung bis: ' + ct.deadline + (ct.deadlinePassed ? '  (VERSTRICHEN)' : ''));
        if (ct.nextCancellationDate) z.push('Nächster Term.:' + ct.nextCancellationDate);
        if (ct.cancellationPeriod) z.push('Frist:         ' + ct.cancellationPeriod);
        if (ct.cancelled) z.push('Status:        BEREITS GEKÜNDIGT');
      }
    } else {
      z.push('── Zuordnung ──');
      z.push('Nicht zugeordnet – weder über die Rufnummer noch über Mitgliedsnummer/E-Mail.');
    }
    const notiz = clean(body.notiz || body.note, 500);
    if (notiz) { z.push(''); z.push('── Aus dem Gespräch ──'); z.push(notiz); }
    const erreichbar = clean(body.erreichbar, 120);
    if (erreichbar) { z.push(''); z.push('Erreichbar:    ' + erreichbar); }
    if (anliegen.hinweis) { z.push(''); z.push('── Hinweis ──'); z.push(anliegen.hinweis); }

    let ok = false;
    try {
      const r = await SR.notifyStudio({
        subject: anliegen.betreff + ' – ' + (clean(body.name, 60) || phone),
        text: z.join('\n'),
      });
      ok = !!(r && r.ok !== false);
    } catch (e) { ok = false; }
    P.logAttempt({ schritt: 'member', aktion: 'eskalieren', ok: ok,
      anliegen: anliegen.key, zugeordnet: !!kunde, ausgewiesen: st.verified });

    if (!ok) {
      return P.json(res, 200, { ok: false, error: 'uebergabe_fehlgeschlagen',
        text: 'Ich konnte die Notiz gerade nicht weitergeben. Bitte melden Sie sich direkt unter '
          + STUDIO_PHONE + ' oder schreiben Sie an info@fit-inn-trier.de – ' + anliegen.ersatz });
    }
    return P.json(res, 200, {
      ok: true, uebergeben: true, anliegen: anliegen.key, zugeordnet: !!kunde,
      text: anliegen.antwort,
      naechsterSchritt: 'Das Anliegen ist an das Team uebergeben, mehr nicht. NICHT sagen, es sei '
        + 'erledigt, gekuendigt, pausiert oder geaendert. Fehlt noch etwas fuer die Uebergabe '
        + '(Name, Erreichbarkeit, worum es genau geht), vorher erfragen und mit notiz und '
        + 'erreichbar erneut senden.',
    });
  }

  // ── Abmelden ───────────────────────────────────────────────────────────────
  // Nimmt Zugriff weg, gibt keinen. Deshalb unbedenklich ueber diese Leitung.
  if (aktion === 'abmelden' || aktion === 'zuruecksetzen' || aktion === 'reset') {
    await A.clearVerified(phone);
    const danach = await A.status(phone);
    P.logAttempt({ schritt: 'member', aktion: 'abmelden', ok: true, restVerified: danach.verified });
    return P.json(res, 200, {
      ok: true, verifiziert: danach.verified, quelle: danach.quelle,
      text: danach.verified
        ? 'Die Telefon-Verifizierung ist zurückgesetzt. Über WhatsApp sind Sie weiterhin '
          + 'ausgewiesen – das ist ein eigener Kanal mit eigener Einwilligung und bleibt unberührt.'
        : 'Erledigt. Beim nächsten Mal weisen Sie sich neu aus.',
      // Der WhatsApp-Ausweis bleibt absichtlich stehen: ihn von hier aus zu
      // loeschen wuerde in einen anderen Kanal hineingreifen. Zum Testen des
      // Code-Ablaufs stattdessen aktion=code mit neu=true.
      naechsterSchritt: danach.verified
        ? 'Soll trotzdem der Code-Ablauf getestet werden: aktion=code mit neu=true.'
        : 'Mit aktion=code einen Einmal-Code zustellen lassen.',
    });
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  if (!aktion || aktion === 'status') {
    return P.json(res, 200, {
      ok: true, verifiziert: st.verified, quelle: st.quelle,
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
  if (aktion === 'vertrag' || aktion === 'mitgliedschaft' || aktion === 'laufzeit'
      || aktion === 'kuendigung' || aktion === 'beginn' || aktion === 'beitrag') {
    if (!ct || !ct.contractId) {
      return P.json(res, 200, { ok: false, error: 'kein_vertrag',
        text: 'Ich sehe gerade keinen laufenden Vertrag. Das schaut das Team besser persönlich an – '
          + 'ich notiere gern einen Rückruf.' });
    }
    // getContract liefert die Daten bereits in deutscher Schreibweise (fmtDE),
    // NICHT als ISO. Sie noch einmal durch eine Datumsformatierung zu schicken
    // ergibt null - dann stuende der Assistent mit leeren Haenden da und
    // erfaende sich etwas. Deshalb hier unveraendert uebernehmen.
    const teile = [];
    if (ct.rateName) teile.push('Ihr Tarif ist ' + clean(ct.rateName, 60));
    if (ct.startDate) teile.push('der Vertrag läuft seit dem ' + ct.startDate);
    if (ct.cancelled) {
      teile.push('er ist zum ' + (ct.endDate || 'vereinbarten Ende') + ' gekündigt');
    } else if (ct.endDate) {
      teile.push('die Laufzeit endet am ' + ct.endDate);
      if (ct.deadline && !ct.deadlinePassed) teile.push('kündigen können Sie noch bis zum ' + ct.deadline);
      else if (ct.nextCancellationDate) teile.push('der nächste Kündigungstermin ist der ' + ct.nextCancellationDate);
    }
    if (ct.cancellationPeriod) teile.push('die Kündigungsfrist beträgt ' + ct.cancellationPeriod);
    const preis = euro(ct.price);
    if (preis) teile.push('der Beitrag liegt bei ' + preis + ' ' + zahlweise(ct.paymentFrequencyUnit));

    P.logAttempt({ schritt: 'member', aktion: 'vertrag', ok: true, quelle: st.quelle });
    return P.json(res, 200, {
      ok: true,
      vertrag: {
        tarif: clean(ct.rateName, 60) || null,
        beginn: ct.startDate || null,
        laufzeitEnde: ct.endDate || null,
        gekuendigt: !!ct.cancelled,
        kuendigungBis: (ct.deadline && !ct.deadlinePassed) ? ct.deadline : null,
        naechsterKuendigungstermin: ct.nextCancellationDate || null,
        kuendigungsfrist: ct.cancellationPeriod || null,
        beitrag: preis,
        zahlweise: zahlweise(ct.paymentFrequencyUnit) || null,
        aktiv: ct.active !== false,
      },
      text: teile.length
        ? (teile.join(', ') + '.')
        : 'Zu Ihrem Vertrag kann ich hier gerade keine Einzelheiten sehen. Ich notiere gern einen Rückruf.',
      // Die allgemeinen AGB-Fristen aus der Wissensdatenbank passen nicht
      // zwangslaeufig zu diesem Vertrag. Was hier steht, gilt.
      naechsterSchritt: 'Nur diese Werte nennen. Die allgemeinen Kuendigungsfristen aus der '
        + 'Wissensdatenbank NICHT zusaetzlich vorlesen - sie koennen fuer diesen Vertrag falsch sein. '
        + 'Fehlt ein Wert, sage das offen. Will das Mitglied etwas AENDERN oder kuendigen: '
        + 'aktion=eskalieren - am Telefon wird nichts ausgefuehrt.',
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
      // Auskunft ja, Einrichten nein - dafuer uebernimmt ein Mensch.
      naechsterSchritt: 'Das ist eine AUSKUNFT. Die Pause NICHT zusagen und NICHT einrichten. '
        + 'Moechte das Mitglied sie wirklich, mit aktion=eskalieren und anliegen=pause an das '
        + 'Team uebergeben - vorher Zeitraum und Grund erfragen und als notiz mitgeben.',
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
