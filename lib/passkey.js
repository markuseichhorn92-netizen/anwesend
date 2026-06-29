'use strict';

/**
 * Passkeys (WebAuthn/FIDO2) – serverseitige Logik.
 * -------------------------------------------------
 * Registrierung erfolgt nur für EINGELOGGTE Mitglieder (an die Magicline-ID
 * gebunden). Anmeldung ist „usernameless" (discoverable credentials): der Browser
 * schlägt den passenden Passkey vor, das Gerät signiert eine Challenge, wir prüfen
 * sie und erstellen eine Mitglieder-Sitzung. E-Mail/WhatsApp-Code bleibt Fallback.
 *
 * Die sicherheitskritische Verifikation übernimmt @simplewebauthn/server.
 *
 * KV-Keys:
 *   pkcred:<credId>   JSON { memberId, publicKey(b64url), counter, transports, createdAt }
 *   pkids:<memberId>  SET der credIds des Mitglieds
 *   pkchal:reg:<m>    Challenge der Registrierung (TTL 5 min)
 *   pkchal:auth:<f>   Challenge einer Anmeldung, per flowId (TTL 5 min)
 */

const crypto = require('node:crypto');
const { redisPipeline, hasStore } = require('./store');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = process.env.PASSKEY_RP_NAME || 'Fit-Inn Trier';
const TTL = 300;

// rpID/Origin aus dem Host ableiten (rpID = Domain ohne Schema/Port).
function rpFromHost(host) {
  const h = String(host || '').split(',')[0].trim().replace(/:\d+$/, '').toLowerCase();
  return { rpID: h || 'localhost', origin: 'https://' + (h || 'localhost') };
}
const credKey = (id) => 'pkcred:' + id;
const idsKey = (m) => 'pkids:' + m;
const regChalKey = (m) => 'pkchal:reg:' + m;
const authChalKey = (f) => 'pkchal:auth:' + f;

async function listCredIds(memberId) {
  if (!hasStore) return [];
  try { const [ids] = await redisPipeline([['SMEMBERS', idsKey(String(memberId))]]); return Array.isArray(ids) ? ids : []; }
  catch (e) { return []; }
}
async function getCred(id) {
  try { const [v] = await redisPipeline([['GET', credKey(id)]]); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}

async function regOptions(member, host) {
  const { rpID } = rpFromHost(host);
  const ids = await listCredIds(member.id);
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME, rpID,
    userName: member.email || member.customerNumber || ('Mitglied ' + member.id),
    userDisplayName: ((member.firstName || '') + ' ' + (member.lastName || '')).trim() || (member.email || String(member.id)),
    userID: new TextEncoder().encode(String(member.id)),
    attestationType: 'none',
    excludeCredentials: ids.map((id) => ({ id })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  await redisPipeline([['SET', regChalKey(member.id), opts.challenge, 'EX', String(TTL)]]);
  return opts;
}

async function regVerify(member, host, response) {
  const { rpID, origin } = rpFromHost(host);
  let chal; try { [chal] = await redisPipeline([['GET', regChalKey(member.id)]]); } catch (e) {}
  if (!chal) return { ok: false, error: 'no_challenge' };
  let v;
  try {
    v = await verifyRegistrationResponse({
      response, expectedChallenge: chal, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
    });
  } catch (e) { return { ok: false, error: e.message }; }
  if (!v.verified || !v.registrationInfo) return { ok: false, error: 'not_verified' };
  const c = v.registrationInfo.credential;
  const rec = {
    memberId: String(member.id),
    publicKey: Buffer.from(c.publicKey).toString('base64url'),
    counter: c.counter || 0,
    transports: c.transports || [],
    createdAt: Date.now(),
  };
  await redisPipeline([
    ['SET', credKey(c.id), JSON.stringify(rec)],
    ['SADD', idsKey(member.id), c.id],
    ['DEL', regChalKey(member.id)],
  ]);
  return { ok: true, id: c.id };
}

async function authOptions(host) {
  const { rpID } = rpFromHost(host);
  // Keine allowCredentials -> usernameless: das Gerät bietet den passenden Passkey an.
  const opts = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  const flowId = crypto.randomBytes(18).toString('hex');
  await redisPipeline([['SET', authChalKey(flowId), opts.challenge, 'EX', String(TTL)]]);
  return { options: opts, flowId: flowId };
}

async function authVerify(host, flowId, response) {
  const { rpID, origin } = rpFromHost(host);
  if (!flowId) return { ok: false, error: 'no_flow' };
  let chal; try { [chal] = await redisPipeline([['GET', authChalKey(flowId)]]); } catch (e) {}
  if (!chal) return { ok: false, error: 'no_challenge' };
  const id = response && response.id;
  if (!id) return { ok: false, error: 'no_id' };
  const rec = await getCred(id);
  if (!rec) return { ok: false, error: 'unknown_credential' };
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge: chal, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
      credential: { id: id, publicKey: Buffer.from(rec.publicKey, 'base64url'), counter: rec.counter || 0, transports: rec.transports || [] },
    });
  } catch (e) { return { ok: false, error: e.message }; }
  if (!v.verified) return { ok: false, error: 'not_verified' };
  rec.counter = v.authenticationInfo.newCounter;
  try { await redisPipeline([['SET', credKey(id), JSON.stringify(rec)], ['DEL', authChalKey(flowId)]]); } catch (e) {}
  return { ok: true, memberId: rec.memberId };
}

async function listForMember(memberId) {
  const ids = await listCredIds(memberId);
  const out = [];
  for (const id of ids) { const r = await getCred(id); if (r) out.push({ id: id, createdAt: r.createdAt || 0 }); }
  return out;
}
async function removeCred(memberId, id) {
  const r = await getCred(id);
  if (!r || r.memberId !== String(memberId)) return false;
  try { await redisPipeline([['DEL', credKey(id)], ['SREM', idsKey(String(memberId)), id]]); } catch (e) { return false; }
  return true;
}

module.exports = { hasStore, regOptions, regVerify, authOptions, authVerify, listForMember, removeCred };
