'use strict';
// Test-Runner: fuehrt alle tests/*.test.js nacheinander in eigenen
// Node-Prozessen aus (Isolation der require.cache-Mocks) und fasst zusammen.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const dir = path.join(ROOT, 'tests');
const tests = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let failed = [];
for (const t of tests) {
  const r = spawnSync(process.execPath, [path.join(dir, t)], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { TEAM_PASSWORD: process.env.TEAM_PASSWORD || 'test-only' }),
    timeout: 120000,
  });
  if (r.status !== 0) failed.push(t);
}
console.log('\n──────────────────────────────');
console.log('Tests: ' + tests.length + ' gesamt, ' + failed.length + ' fehlgeschlagen' + (failed.length ? (' -> ' + failed.join(', ')) : ''));
process.exit(failed.length ? 1 : 0);
