'use strict';
process.env.AI_PROVIDER = 'bedrock';
process.env.AWS_REGION = 'eu-central-1';
process.env.AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/test';
process.env.BEDROCK_MODEL_ID = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
process.env.BEDROCK_GUARDRAIL_ID = 'guardrail-test-id';
process.env.BEDROCK_GUARDRAIL_VERSION = '1';

const Module = require('module');
const path = require('path');
const originalLoad = Module._load;
let commandInput = null;
let converseInput = null;
let clientConfig = null;
let oidcOptions = null;

class InvokeModelCommand {
  constructor(input) { commandInput = input; }
}
class ConverseCommand {
  constructor(input) { converseInput = input; }
}
class BedrockRuntimeClient {
  constructor(config) { clientConfig = config; }
  async send(command) {
    if (command instanceof ConverseCommand) {
      return { output: { message: { content: [{ text: 'ok' }] } }, stopReason: 'end_turn' };
    }
    return { body: Buffer.from(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })) };
  }
}

Module._load = function (request, parent, isMain) {
  if (request === '@aws-sdk/client-bedrock-runtime') return { InvokeModelCommand, ConverseCommand, BedrockRuntimeClient };
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
  ok('1. Bedrock ist konfiguriert', AI.hasAI === true);
  ok('2. Client ist fest auf Frankfurt gesetzt', clientConfig && clientConfig.region === 'eu-central-1');
  ok('3. OIDC nutzt nur die konfigurierte Rolle', oidcOptions && oidcOptions.roleArn === process.env.AWS_ROLE_ARN);
  ok('4. Textanfragen nutzen AWS Converse mit dem EU-Profil', converseInput && converseInput.modelId === process.env.BEDROCK_MODEL_ID && commandInput === null);
  ok('5. System-Prompt wird AWS-nativ als Textblock gesendet', converseInput && Array.isArray(converseInput.system) && typeof converseInput.system[0].text === 'string');
  ok('6. Nachrichten werden AWS-nativ aufgebaut', converseInput && converseInput.messages[0].content[0].text.includes('Wann offen?'));
  ok('7. Converse-Payload enthaelt keine Anthropic-Cache-Marker', !JSON.stringify(converseInput).includes('cache_control'));
  ok('8. Antwort wird kompatibel geparst', result.ok === true && result.answer === 'ok');
  ok('8b. Bedrock-Guardrail wird bei Converse erzwungen', converseInput && converseInput.guardrailConfig && converseInput.guardrailConfig.guardrailIdentifier === process.env.BEDROCK_GUARDRAIL_ID);
  ok('8c. Nutzereingabe ist für den Prompt-Attack-Filter markiert', /amazon-bedrock-guardrails-guardContent_finn/.test(converseInput.messages[0].content[0].text));

  delete require.cache[aiPath];
  process.env.AWS_REGION = 'us-east-1';
  const AIWrongRegion = require(aiPath);
  ok('9. Andere AWS-Regionen werden fail-closed abgelehnt', AIWrongRegion.hasAI === false);

  delete require.cache[aiPath];
  process.env.AWS_REGION = 'eu-central-1';
  process.env.BEDROCK_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';
  const AIDirectModel = require(aiPath);
  ok('10. Direkte oder globale Modell-IDs werden fail-closed abgelehnt', AIDirectModel.hasAI === false);

  delete require.cache[aiPath];
  process.env.BEDROCK_MODEL_ID = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
  process.env.VERCEL_ENV = 'production';
  process.env.AI_REQUIRE_GUARDRAIL = '1';
  delete process.env.BEDROCK_GUARDRAIL_ID;
  delete process.env.BEDROCK_GUARDRAIL_VERSION;
  const AIMissingGuardrail = require(aiPath);
  ok('11. Production ohne verlangten Guardrail wird fail-closed abgelehnt', AIMissingGuardrail.hasAI === false);

  Module._load = originalLoad;
  console.log(pass ? 'AI-BEDROCK PASS' : 'AI-BEDROCK FAIL');
  process.exit(pass ? 0 : 1);
}

run().catch(function (e) {
  Module._load = originalLoad;
  console.error('FAIL', e);
  process.exit(1);
});
