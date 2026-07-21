'use strict';
process.env.AI_PROVIDER = 'bedrock';
process.env.AWS_REGION = 'eu-central-1';
process.env.AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/test';
process.env.BEDROCK_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

const Module = require('module');
const path = require('path');
const originalLoad = Module._load;
let commandInput = null;
let clientConfig = null;
let oidcOptions = null;

class InvokeModelCommand {
  constructor(input) { commandInput = input; }
}
class BedrockRuntimeClient {
  constructor(config) { clientConfig = config; }
  async send() {
    return { body: Buffer.from(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })) };
  }
}

Module._load = function (request, parent, isMain) {
  if (request === '@aws-sdk/client-bedrock-runtime') return { InvokeModelCommand, BedrockRuntimeClient };
  if (request === '@vercel/oidc-aws-credentials-provider') {
    return { awsCredentialsProvider: function (opts) { oidcOptions = opts; return async function () { return {}; }; } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function run() {
  let pass = true;
  const ok = function (label, condition) {
    if (!condition) pass = false;
    console.log((condition ? 'OK  ' : 'FAIL') + ' ' + label);
  };
  const aiPath = path.resolve(__dirname, '..', 'lib', 'ai.js');
  const AI = require(aiPath);
  const result = await AI.askHelp('Wann offen?', [{ t: 'Test', body: 'Immer.' }]);
  const body = JSON.parse(Buffer.from(commandInput.body).toString('utf8'));

  ok('1. Bedrock ist konfiguriert', AI.hasAI === true);
  ok('2. Client ist fest auf Frankfurt gesetzt', clientConfig && clientConfig.region === 'eu-central-1');
  ok('3. OIDC nutzt nur die konfigurierte Rolle', oidcOptions && oidcOptions.roleArn === process.env.AWS_ROLE_ARN);
  ok('4. Nur das konfigurierte Modell wird aufgerufen', commandInput && commandInput.modelId === process.env.BEDROCK_MODEL_ID);
  ok('5. Bedrock-Anthropic-Version ist gesetzt', body.anthropic_version === 'bedrock-2023-05-31');
  ok('6. Modell-ID steht nicht im Prompt-Payload', !Object.prototype.hasOwnProperty.call(body, 'model'));
  ok('7. Antwort wird kompatibel geparst', result.ok === true && result.answer === 'ok');

  delete require.cache[aiPath];
  process.env.AWS_REGION = 'us-east-1';
  const AIWrongRegion = require(aiPath);
  ok('8. Andere AWS-Regionen werden fail-closed abgelehnt', AIWrongRegion.hasAI === false);

  Module._load = originalLoad;
  console.log(pass ? 'AI-BEDROCK PASS' : 'AI-BEDROCK FAIL');
  process.exit(pass ? 0 : 1);
}

run().catch(function (e) {
  Module._load = originalLoad;
  console.error('FAIL', e);
  process.exit(1);
});
