'use strict';

/**
 * Zentrale Datenschutz-Schicht der Mitglieder-App.
 *
 * - beweissichere, versionierte Einwilligungsereignisse (Art. 7/9 DSGVO)
 * - vollständiger App-Datenexport (Art. 15/20 DSGVO)
 * - Löschung der freiwilligen App-Daten (Art. 17 DSGVO)
 *
 * Vertrags-, Beitrags- und steuerrechtlich aufzubewahrende Daten in Magicline
 * werden bewusst nicht automatisiert gelöscht. Sie werden im Export kenntlich
 * gemacht und müssen im Einzelfall nach dem gesetzlichen Löschkonzept behandelt
 * werden.
 */

const crypto = require('crypto');
const { redisPipeline, hasStore } = require('./store');

const POLICY_VERSION = '2026-07-21.1';
const CONSENT_SCHEMA_VERSION = 2;
const CONSENT_TTL = 6 * 365 * 24 * 3600; // minimales Nachweisprotokoll, danach automatische Löschung
const CONSENT_CAP = 100;
const CKEY = (id) => 'privacy:consent:' + String(id);

const DEFINITIONS = Object.freeze({
  ai_health_profile: {
    title: 'Gesundheitsangaben im FINN-Profil',
    purpose: 'Personalisierung sicherer Trainings- und Ernährungshinweise durch FINN',
    categories: ['Beschwerden', 'Schonhinweise', 'Körper- und Zieldaten'],
    recipients: ['Fit-Inn Trier', 'Vercel', 'Amazon Web Services (Amazon Bedrock)'],
    text: 'Ich willige ausdrücklich ein, dass Fit-Inn Trier meine freiwilligen Gesundheits- und Körperangaben verarbeitet und die für meine konkrete Anfrage erforderlichen Angaben an FINN über Amazon Bedrock innerhalb der EU übermittelt. Die Verarbeitung dient nur meinen persönlichen Trainings- und Ernährungshinweisen, nicht Werbung oder medizinischer Diagnose. Die Einwilligung ist freiwillig und jederzeit widerrufbar.',
  },
  nutrition_health: {
    title: 'Ernährungs- und Gesundheitsdaten',
    purpose: 'Ernährungsprotokoll, Berechnungen sowie persönliche KI-gestützte Ernährungspläne',
    categories: ['Ernährung', 'Gewicht', 'Körperdaten', 'Allergien und Unverträglichkeiten'],
    recipients: ['Fit-Inn Trier', 'Vercel', 'Amazon Web Services (Amazon Bedrock)'],
    text: 'Ich willige ausdrücklich ein, dass Fit-Inn Trier meine Angaben zu Ernährung, Gewicht, Körper und Gesundheit für mein Ernährungsmodul verarbeitet. Für von mir gestartete KI-Funktionen werden nur erforderliche Angaben über Amazon Bedrock innerhalb der EU verarbeitet. Keine Nutzung für Werbung oder Modelltraining. Die Einwilligung ist freiwillig und jederzeit widerrufbar.',
  },
  vital_health: {
    title: 'Vital- und Trainingsdaten',
    purpose: 'Persönliche Wellness-, Erholungs- und Trainingshinweise',
    categories: ['Puls', 'HRV', 'Schlaf', 'Vitalwerte', 'Trainingsbelastung'],
    recipients: ['Fit-Inn Trier', 'Vercel', 'Amazon Web Services (Amazon Bedrock)'],
    text: 'Ich willige ausdrücklich ein, dass Fit-Inn Trier meine Puls-, HRV-, Schlaf-, Vital- und Trainingsdaten für persönliche Wellness- und Trainingshinweise verarbeitet. Soweit ich eine FINN-Auswertung starte, werden nur erforderliche Angaben über Amazon Bedrock innerhalb der EU verarbeitet. Kein Medizinprodukt, keine Diagnose. Die Einwilligung ist freiwillig und jederzeit widerrufbar.',
  },
  vital_team_share: {
    title: 'Vitalstatus mit Trainerteam teilen',
    purpose: 'Anzeige eines zusammengefassten Bereitschaftsstatus für das Trainerteam',
    categories: ['aggregierte Trainingsbereitschaft'],
    recipients: ['Fit-Inn Trier Trainerteam'],
    text: 'Ich willige ein, dass das Fit-Inn-Trainerteam meinen zusammengefassten Bereitschaftsstatus sehen darf. Rohwerte werden nicht angezeigt. Diese zusätzliche Freigabe ist freiwillig und jederzeit widerrufbar.',
  },
  finn_memory: {
    title: 'FINN-Gedächtnis',
    purpose: 'Vom Mitglied ausgewählte Angaben für spätere FINN-Gespräche merken',
    categories: ['freiwillig gemerkte Präferenzen und Ziele'],
    recipients: ['Fit-Inn Trier', 'Vercel', 'Amazon Web Services (nur bei einer neuen Anfrage)'],
    text: 'Ich willige ein, dass FINN ausgewählte Angaben für meine späteren Gespräche speichern darf. Ich kann einzelne oder alle Merkpunkte jederzeit löschen und die Funktion jederzeit ausschalten.',
  },
  lifestyle_health: {
    title: 'Lebensstil-Selbstauskunft',
    purpose: 'Persönliche Wellness- und Vitalalter-Hinweise',
    categories: ['Schlaf', 'Stress', 'Sitzen', 'Rauchen'],
    recipients: ['Fit-Inn Trier', 'Vercel', 'Amazon Web Services (nur bei FINN-Auswertung)'],
    text: 'Ich willige ausdrücklich ein, dass Fit-Inn Trier meine freiwilligen Lebensstil-Angaben für persönliche Wellness- und Vitalalter-Hinweise verarbeitet. Die Einwilligung ist freiwillig und jederzeit widerrufbar.',
  },
  body_analysis_health: {
    title: 'KÃ¶rperanalyse- und Fortschrittsdaten',
    purpose: 'PersÃ¶nlicher KÃ¶rperwerteverlauf sowie auf Wunsch sichere FINN-Auswertung',
    categories: ['Gewicht', 'KÃ¶rperfett', 'Muskelmasse', 'UmfÃ¤nge', 'InBody-Messwerte'],
    recipients: ['Fit-Inn Trier', 'Vercel', 'Amazon Web Services (nur bei einer gestarteten FINN-Auswertung oder Foto-Auslese)'],
    text: 'Ich willige ausdrÃ¼cklich ein, dass Fit-Inn Trier meine freiwilligen KÃ¶rperanalyse-, Gewichts- und Umfangsdaten fÃ¼r meinen persÃ¶nlichen Verlauf verarbeitet. Wenn ich eine Foto-Auslese oder FINN-Auswertung starte, werden nur erforderliche Angaben Ã¼ber Amazon Bedrock innerhalb der EU verarbeitet. Keine Diagnose, keine Werbung und kein Modelltraining. Die Einwilligung ist freiwillig und jederzeit widerrufbar.',
  },
  community: {
    title: 'Trainingspartner-Community',
    purpose: 'Freiwillige Vernetzung mit anderen Mitgliedern',
    categories: ['Anzeigename', 'Verbindungen', 'Nachrichten', 'freiwillig freigegebene Aktivitätssignale'],
    recipients: ['ausgewählte verbundene Mitglieder', 'Fit-Inn Trier', 'Vercel'],
    text: 'Ich willige ein, in der Trainingspartner-Community mit meinem gewählten Anzeigenamen sichtbar zu werden und die von mir ausgewählten Aktivitätssignale mit bestätigten Trainingspartnern zu teilen. Verbindungen entstehen nur nach Bestätigung. Ich kann die Community jederzeit deaktivieren; Verbindungen, Chats und Verabredungen werden dann entfernt.',
  },
});

function definition(type) {
  const d = DEFINITIONS[String(type || '')];
  if (!d) throw Object.assign(new Error('Unbekannte Einwilligung'), { code: 'unknown_consent' });
  return d;
}

function textHash(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function cleanMeta(meta) {
  meta = meta && typeof meta === 'object' ? meta : {};
  return {
    source: String(meta.source || 'member-app').slice(0, 60),
    appVersion: String(meta.appVersion || '').slice(0, 40),
    locale: String(meta.locale || 'de-DE').slice(0, 20),
  };
}

async function listConsents(id) {
  if (!hasStore || id == null) return [];
  try {
    const [raw] = await redisPipeline([['GET', CKEY(id)]]);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(0, CONSENT_CAP) : [];
  } catch (e) { return []; }
}

async function recordConsent(id, type, granted, meta) {
  const d = definition(type);
  const now = Date.now();
  const event = Object.assign({
    schemaVersion: CONSENT_SCHEMA_VERSION,
    policyVersion: POLICY_VERSION,
    type: String(type),
    title: d.title,
    purpose: d.purpose,
    categories: d.categories.slice(),
    recipients: d.recipients.slice(),
    textHash: textHash(d.text),
    granted: !!granted,
    at: now,
    grantedAt: granted ? now : null,
    withdrawnAt: granted ? null : now,
  }, cleanMeta(meta));
  if (!hasStore || id == null) return event;
  const list = await listConsents(id);
  list.unshift(event);
  await redisPipeline([['SET', CKEY(id), JSON.stringify(list.slice(0, CONSENT_CAP)), 'EX', String(CONSENT_TTL)]]);
  return event;
}

function consentSummary(events) {
  const out = {};
  (Array.isArray(events) ? events : []).forEach((e) => {
    if (e && e.type && !Object.prototype.hasOwnProperty.call(out, e.type)) out[e.type] = e;
  });
  return out;
}

async function currentConsents(id) { return consentSummary(await listConsents(id)); }

const APP_PREFIXES = ['member:', 'morning:', 'health:', 'workout:', 'workouts:', 'inbody:', 'finn:', 'nutri:', 'train:', 'soc:', 'push:', 'mpref:', 'nudge:'];

function belongsToMember(key, id) {
  key = String(key || ''); id = String(id || '');
  if (!id || !APP_PREFIXES.some((p) => key.indexOf(p) === 0)) return false;
  return key.split(':').some((part) => part === id);
}

async function scanAllKeys() {
  if (!hasStore) return [];
  let cursor = '0'; const keys = [];
  do {
    const [reply] = await redisPipeline([['SCAN', cursor, 'COUNT', '250']]);
    if (!Array.isArray(reply)) break;
    cursor = String(reply[0] == null ? '0' : reply[0]);
    if (Array.isArray(reply[1])) keys.push.apply(keys, reply[1].map(String));
  } while (cursor !== '0' && keys.length < 10000);
  return keys;
}

function flatToObject(v) {
  if (!Array.isArray(v)) return v || {};
  const o = {}; for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}

function maybeJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return v; }
}

async function readKeys(keys) {
  const out = {};
  for (const key of keys) {
    try {
      const [type] = await redisPipeline([['TYPE', key]]);
      let value = null;
      if (type === 'string') [value] = await redisPipeline([['GET', key]]);
      else if (type === 'set') [value] = await redisPipeline([['SMEMBERS', key]]);
      else if (type === 'hash') { [value] = await redisPipeline([['HGETALL', key]]); value = flatToObject(value); }
      else if (type === 'list') [value] = await redisPipeline([['LRANGE', key, '0', '-1']]);
      else if (type === 'zset') [value] = await redisPipeline([['ZRANGE', key, '0', '-1', 'WITHSCORES']]);
      out[key] = maybeJson(value);
    } catch (e) { out[key] = { unavailable: true }; }
  }
  return out;
}

async function appDataExport(id) {
  if (!hasStore) return { available: false, records: {} };
  const keys = (await scanAllKeys()).filter((k) => belongsToMember(k, id) && k !== CKEY(id)).sort();
  return { available: true, records: await readKeys(keys) };
}

async function removePushTokens(id) {
  try {
    const Push = require('./push');
    const tokens = await Push.tokensFor(id);
    for (const token of tokens) await Push.unregisterToken(id, token);
  } catch (e) {}
}

async function deleteAppData(id) {
  id = String(id || '');
  if (!id) return { ok: false, error: 'bad_member' };
  const results = {};
  const run = async (name, fn) => { try { await fn(); results[name] = true; } catch (e) { results[name] = false; } };
  await run('profile', () => require('./memberProfile').clear(id));
  await run('morning', async () => { const x = require('./morning'); await x.setConsent(id, false); await x.clearRecovery(id); });
  await run('vitals', () => require('./vitals').clear(id));
  await run('workouts', () => require('./workouts').clear(id));
  await run('inbody', () => require('./inbody').clear(id));
  await run('social', async () => { const x = require('./social'); if (x.erase) await x.erase(id); else await x.disable(id); });
  await run('push', () => removePushTokens(id));
  await run('finnMemory', async () => { const x = require('./finnMemory'); if (x.erase) await x.erase(id); else { await x.setOptIn(id, false); } });

  if (hasStore) {
    try {
      const keys = (await scanAllKeys()).filter((k) => belongsToMember(k, id) && k !== CKEY(id));
      const commands = keys.map((k) => ['DEL', k]);
      // Mitgliedsbezüge aus globalen Indizes entfernen.
      commands.push(['SREM', 'push:members', id], ['SREM', 'soc:members', id], ['SREM', 'soc:banned', id]);
      if (commands.length) await redisPipeline(commands);
      results.residualKeys = keys.length;
    } catch (e) { results.residualKeys = false; }
  }

  // Minimalen Widerrufs-/Löschungsnachweis getrennt von den gelöschten Nutzdaten behalten.
  for (const type of Object.keys(DEFINITIONS)) {
    try { await recordConsent(id, type, false, { source: 'privacy-delete-all' }); } catch (e) {}
  }
  return { ok: Object.keys(results).every((k) => results[k] !== false), deletedAt: Date.now(), results };
}

module.exports = {
  POLICY_VERSION, CONSENT_SCHEMA_VERSION, DEFINITIONS, CKEY,
  definition, textHash, listConsents, recordConsent, currentConsents,
  belongsToMember, appDataExport, deleteAppData,
};
