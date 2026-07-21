const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const ai = read('lib/ai.js');
const member = read('mitglieder.html');
const vercel = JSON.parse(read('vercel.json'));

assert.strictEqual(
  (ai.match(/maxTokens: 4096, temperature: 0\.4, model: MODEL_PLAN, timeoutMs: 110000/g) || []).length,
  2,
  'training and nutrition plans must have enough output budget and runtime'
);
assert.ok(ai.includes('aiTimeout(opts.timeoutMs)'), 'AI calls must honor the per-request timeout');

assert.deepStrictEqual(vercel.regions, ['fra1'], 'server functions must stay in Frankfurt');
assert.strictEqual(vercel.functions['api/member/training.js'].maxDuration, 120);
assert.strictEqual(vercel.functions['api/member/nutrition.js'].maxDuration, 120);

assert.ok(member.includes('.ernSetupMetrics{display:flex;gap:10px;margin-top:14px}'));
assert.ok(member.includes('@media(max-width:380px)'));
assert.ok(member.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));
assert.ok(member.includes('.ernSetupMetric:last-child{grid-column:1/-1}'));
assert.ok(member.includes('overflow-x:hidden'), 'nutrition onboarding must not overflow horizontally');
assert.ok(
  (member.match(/timeoutMs:120000/g) || []).length >= 4,
  'plan requests must wait for the extended server runtime'
);

console.log('android plan fixes test passed');
