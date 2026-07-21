'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const storePath = require.resolve(path.join(ROOT, 'lib/store.js'));
const KV = new Map();

function fakePipeline(cmds) {
  return Promise.resolve((cmds || []).map((c) => {
    const op = String(c[0]).toUpperCase(); const key = c[1];
    if (op === 'GET') return KV.has(key) ? KV.get(key) : null;
    if (op === 'SET') { KV.set(key, c[2]); return 'OK'; }
    if (op === 'DEL') { const had = KV.delete(key); return had ? 1 : 0; }
    if (op === 'EXPIRE') return KV.has(key) ? 1 : 0;
    return null;
  }));
}

require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true,
  exports: { hasStore: true, redisPipeline: fakePipeline },
};

const Privacy = require(path.join(ROOT, 'lib/privacy.js'));

async function run() {
  let pass = true;
  const ok = (label, condition) => { if (!condition) pass = false; console.log((condition ? 'OK  ' : 'FAIL') + ' ' + label); };

  ok('Policy-Version ist gesetzt', /^\d{4}-\d{2}-\d{2}\./.test(Privacy.POLICY_VERSION));
  const d = Privacy.definition('body_analysis_health');
  ok('Körperanalyse-Einwilligung enthält Kategorien und AWS-Empfänger', d.categories.length > 2 && d.recipients.some((x) => /Amazon/.test(x)));
  ok('Text-Hash ist deterministisch', Privacy.textHash(d.text) === Privacy.textHash(d.text) && Privacy.textHash(d.text).length === 64);

  const granted = await Privacy.recordConsent('M-42', 'body_analysis_health', true, { source: 'test' });
  ok('Erteilung enthält Nachweisfelder', granted.granted === true && granted.grantedAt && granted.textHash && granted.policyVersion === Privacy.POLICY_VERSION);
  let current = await Privacy.currentConsents('M-42');
  ok('Aktueller Status ist erteilt', current.body_analysis_health && current.body_analysis_health.granted === true);

  const revoked = await Privacy.recordConsent('M-42', 'body_analysis_health', false, { source: 'test' });
  current = await Privacy.currentConsents('M-42');
  ok('Widerruf ist jüngstes Ereignis', revoked.withdrawnAt && current.body_analysis_health.granted === false);
  ok('Ereignishistorie bleibt erhalten', (await Privacy.listConsents('M-42')).length === 2);

  ok('Mitgliedsschlüssel wird erkannt', Privacy.belongsToMember('inbody:M-42', 'M-42'));
  ok('Ähnlicher Fremdschlüssel wird nicht erkannt', !Privacy.belongsToMember('inbody:M-420', 'M-42'));

  console.log(pass ? 'PRIVACY PASS' : 'PRIVACY FAIL');
  process.exit(pass ? 0 : 1);
}

run().catch((e) => { console.error('FAIL', e); process.exit(1); });
