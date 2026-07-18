'use strict';

/**
 * Willkommensgeschenk: der ERSTE Plan geht aufs Haus.
 * -------------------------------------------------------------------------
 * Nach dem Onboarding darf sich jedes Mitglied EINMALIG je Bereich einen Plan
 * gratis von FINN erstellen lassen, ohne das monatliche Gratis-Kontingent zu
 * verbrauchen (und ohne Premium):
 *   - 'train' : erster Trainingsplan (api/member/training → generate)
 *   - 'ern'   : erster Ernährungs-Wochenplan (api/member/nutrition → plan-generate)
 *
 * Key:  finn:welcome:<memberId>   JSON { train:boolean, ern:boolean }  (eingelöst?)
 *       TTL wird bei jedem Schreiben erneuert. Ohne KV-Store: No-Op – dann greift
 *       einfach das normale Kontingent/Premium (tryClaim liefert false).
 */

const { redisPipeline, hasStore } = require('./store');

const TTL = 400 * 24 * 3600;
const MKEY = (id) => 'finn:welcome:' + String(id);

function normalize(o) {
  const x = o && typeof o === 'object' ? o : {};
  return { train: !!x.train, ern: !!x.ern };
}

async function get(id) {
  if (!hasStore || id == null) return { train: false, ern: false };
  try {
    const [v] = await redisPipeline([['GET', MKEY(id)]]);
    if (!v) return { train: false, ern: false };
    return normalize(typeof v === 'string' ? JSON.parse(v) : v);
  } catch (e) { return { train: false, ern: false }; }
}

async function save(id, state) {
  const clean = normalize(state);
  if (!hasStore || id == null) return clean;
  try {
    await redisPipeline([['SET', MKEY(id), JSON.stringify(clean)]]);
    try { await redisPipeline([['EXPIRE', MKEY(id), String(TTL)]]); } catch (e) {}
  } catch (e) {}
  return clean;
}

// Geschenk für 'which' einlösen. Gibt true zurück, wenn es NOCH FREI war (und markiert es
// jetzt als eingelöst). Ohne Store immer false → normales Kontingent/Premium greift.
async function tryClaim(id, which) {
  if (which !== 'train' && which !== 'ern') return false;
  if (!hasStore || id == null) return false;
  const cur = await get(id);
  if (cur[which]) return false;           // schon eingelöst
  cur[which] = true;
  await save(id, cur);
  return true;
}

// Ist das Geschenk für 'which' NOCH FREI? Reiner Lese-Check (verändert nichts).
async function available(id, which) {
  if (which !== 'train' && which !== 'ern') return false;
  if (!hasStore || id == null) return false;
  const cur = await get(id);
  return !cur[which];
}

// Geschenk als eingelöst markieren – ERST nach erfolgreicher Generierung aufrufen,
// damit ein fehlgeschlagener Versuch das Geschenk NICHT verbraucht.
async function consume(id, which) {
  if (which !== 'train' && which !== 'ern') return false;
  if (!hasStore || id == null) return false;
  const cur = await get(id);
  if (cur[which]) return false;
  cur[which] = true;
  await save(id, cur);
  return true;
}

module.exports = { MKEY, get, save, available, consume, tryClaim };
