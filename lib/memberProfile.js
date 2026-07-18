'use strict';

/**
 * Mitglieder-Profil aus dem Onboarding (serverseitig, datensparsam).
 * -------------------------------------------------------------------------
 * Beim ausführlichen Onboarding beantwortet das Mitglied Fragen zu Ziel,
 * Körperdaten, Trainingsrhythmus, Erfahrung, Vorlieben, GESUNDHEIT und
 * Ernährung. Diese Angaben fließen als kompakter Kontext in FINNs
 * System-Prompt (api/member/coach.js), damit der Coach persönlicher und –
 * bei Beschwerden/Einschränkungen – SICHER berät (z. B. Rücken/Knie schonen)
 * und auf Trainer:innen vor Ort verweist.
 *
 * Gesundheitsdaten sind besonders geschützt (DSGVO Art. 9). Sie werden NUR
 * gespeichert, wenn das Mitglied im Onboarding ausdrücklich zugestimmt hat
 * (health.consent === true). Ohne Zustimmung werden Beschwerden/Notiz
 * verworfen und NICHT an die KI gegeben. Jederzeit löschbar (Profil-UI +
 * DSGVO-Komplettlöschung in api/member/nutrition.js → delete-all).
 *
 * Key:  member:profile:<memberId>   JSON { v, ...felder, health:{consent,items,note}, ts }
 *       TTL wird bei jedem Schreiben erneuert. Ohne KV-Store: sauberer No-Op.
 */

const { redisPipeline, hasStore } = require('./store');

const TTL = 400 * 24 * 3600;               // ~13 Monate, bei jedem Schreiben erneuert
const MKEY = (id) => 'member:profile:' + String(id);

const MAX_LIST = 8;                        // höchstens so viele Einträge je Liste (Vorlieben/Allergien/Beschwerden)
const MAX_ITEM = 40;                       // Zeichen je Listeneintrag
const MAX_NOTE = 200;                      // Zeichen für die freie Gesundheits-Notiz

const GOALS = ['Abnehmen', 'Definieren', 'Gewicht halten', 'Muskelaufbau', 'Ausdauer & Fitness', 'Gesundheit & Longevity', 'Stressabbau & Kopf frei'];
const SEX = ['w', 'm', 'd'];
const TIMES = ['morgens', 'mittags', 'abends', 'flexibel'];
const EXP = ['einsteiger', 'gelegentlich', 'erfahren'];
const DIETS = ['alles', 'vegetarisch', 'vegan', 'pescetarisch', 'low-carb', 'high-protein'];

// ── Reine Logik (ohne KV – voll unit-testbar) ──

function str(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || MAX_ITEM).trim();
}
function intIn(v, lo, hi) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}
function oneOf(v, list) { const s = str(v, 40).toLowerCase(); const hit = list.find((x) => x.toLowerCase() === s); return hit || ''; }
function cleanList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  arr.forEach((raw) => {
    const c = str(raw, MAX_ITEM);
    const k = c.toLowerCase();
    if (c.length >= 2 && !seen.has(k) && out.length < MAX_LIST) { seen.add(k); out.push(c); }
  });
  return out;
}

// Eingehende (nutzergelieferte) Rohdaten auf ein sauberes, minimales Profil abbilden.
// Gesundheitsangaben werden NUR übernommen, wenn consent === true.
function sanitize(input) {
  const o = input && typeof input === 'object' ? input : {};
  const h = o.health && typeof o.health === 'object' ? o.health : {};
  const consent = h.consent === true || h.consent === 'true' || h.consent === 1;
  const profile = {
    goal: oneOf(o.goal, GOALS) || str(o.goal, 40),
    freq: intIn(o.freq, 1, 7),
    age: intIn(o.age, 14, 100),
    sex: oneOf(o.sex, SEX),
    heightCm: intIn(o.heightCm, 100, 250),
    weightKg: intIn(o.weightKg, 30, 300),
    targetWeight: intIn(o.targetWeight, 30, 300),
    trainTime: oneOf(o.trainTime, TIMES),
    exp: oneOf(o.exp, EXP),
    likes: cleanList(o.likes),
    dislikes: cleanList(o.dislikes),
    diet: oneOf(o.diet, DIETS),
    allergies: cleanList(o.allergies),
    onboarded: !!o.onboarded,
    health: {
      consent: consent,
      items: consent ? cleanList(h.items) : [],
      note: consent ? str(h.note, MAX_NOTE) : '',
    },
  };
  return profile;
}

// true, wenn das Profil überhaupt eine verwertbare Angabe enthält.
function hasAny(p) {
  if (!p) return false;
  return !!(p.goal || p.freq || p.age || p.sex || p.heightCm || p.weightKg || p.trainTime || p.exp
    || (p.likes && p.likes.length) || (p.dislikes && p.dislikes.length) || p.diet
    || (p.allergies && p.allergies.length)
    || (p.health && p.health.consent && ((p.health.items && p.health.items.length) || p.health.note)));
}

// Kompakter Kontext-Block für FINNs System-Prompt (Deutsch, vertraulich).
// Gesundheit nur, wenn Zustimmung vorliegt. Leerer String, wenn nichts Verwertbares da ist.
function toPromptText(p) {
  if (!hasAny(p)) return '';
  const L = [];
  if (p.goal) L.push('Ziel: ' + p.goal + (p.targetWeight ? (' (Wunschgewicht ' + p.targetWeight + ' kg)') : ''));
  const body = [];
  if (p.age) body.push(p.age + ' Jahre');
  if (p.sex) body.push({ w: 'weiblich', m: 'männlich', d: 'divers' }[p.sex] || '');
  if (p.heightCm) body.push(p.heightCm + ' cm');
  if (p.weightKg) body.push(p.weightKg + ' kg');
  if (body.filter(Boolean).length) L.push('Körperdaten: ' + body.filter(Boolean).join(', '));
  if (p.freq) L.push('Trainingsrhythmus: ' + p.freq + '×/Woche' + (p.trainTime ? (' (am liebsten ' + p.trainTime + ')') : ''));
  if (p.exp) L.push('Erfahrung: ' + ({ einsteiger: 'Einsteiger:in', gelegentlich: 'trainiert gelegentlich', erfahren: 'erfahren' }[p.exp] || p.exp));
  if (p.likes && p.likes.length) L.push('Mag: ' + p.likes.join(', '));
  if (p.dislikes && p.dislikes.length) L.push('Mag nicht: ' + p.dislikes.join(', '));
  if (p.diet) L.push('Ernährungsweise: ' + p.diet);
  if (p.allergies && p.allergies.length) L.push('Allergien/Unverträglichkeiten: ' + p.allergies.join(', '));
  if (p.health && p.health.consent) {
    const parts = [];
    if (p.health.items && p.health.items.length) parts.push(p.health.items.join(', '));
    if (p.health.note) parts.push(p.health.note);
    if (parts.length) {
      L.push('Gesundheit/Beschwerden (vertraulich, vom Mitglied freigegeben): ' + parts.join('; ')
        + '. Berücksichtige das bei Trainings- und Ernährungstipps, empfiehl nichts Riskantes, stelle KEINE Diagnosen '
        + 'und verweise bei gesundheitlichen Themen ausdrücklich auf ärztlichen Rat bzw. die Trainer:innen vor Ort.');
    }
  }
  if (!L.length) return '';
  return 'Was du aus dem Onboarding über dieses Mitglied weißt '
    + '(vertraulich, gilt NUR für die angemeldete Person):\n– ' + L.join('\n– ');
}

// ── KV-gebundene Operationen (No-Op ohne Store) ──

async function get(id) {
  const empty = sanitize({});
  if (!hasStore || id == null) return empty;
  try {
    const [v] = await redisPipeline([['GET', MKEY(id)]]);
    if (!v) return empty;
    return sanitize(typeof v === 'string' ? JSON.parse(v) : v);
  } catch (e) { return empty; }
}

async function save(id, input) {
  const clean = sanitize(input);
  if (!hasStore || id == null) return clean;
  try {
    await redisPipeline([['SET', MKEY(id), JSON.stringify(Object.assign({ v: 1 }, clean, { ts: Date.now() }))]]);
    try { await redisPipeline([['EXPIRE', MKEY(id), String(TTL)]]); } catch (e) {}
  } catch (e) {}
  return clean;
}

// Nur die Gesundheitsangaben löschen (Rest des Profils bleibt).
async function clearHealth(id) {
  const cur = await get(id);
  cur.health = { consent: false, items: [], note: '' };
  return save(id, cur);
}

// Ganzes Profil löschen (DSGVO / Konto-Löschung).
async function clear(id) {
  if (!hasStore || id == null) return sanitize({});
  try { await redisPipeline([['DEL', MKEY(id)]]); } catch (e) {}
  return sanitize({});
}

module.exports = {
  MKEY, GOALS, SEX, TIMES, EXP, DIETS, MAX_LIST, MAX_ITEM, MAX_NOTE,
  sanitize, hasAny, toPromptText, get, save, clearHealth, clear,
};
