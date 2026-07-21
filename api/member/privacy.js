'use strict';

/**
 * Datenschutz-Self-Service.
 * GET  -> Einwilligungsstatus und Datenschutzhinweise
 * POST { action:'export' } -> vollständiger JSON-Export der App-Daten
 * POST { action:'delete-app-data', confirm:'APP-DATEN LOESCHEN' }
 *      -> freiwillige App-Daten löschen; Vertragsdaten in Magicline bleiben
 *         entsprechend gesetzlicher/vertraglicher Pflichten unberührt.
 */

const M = require('../../lib/members');
const Privacy = require('../../lib/privacy');

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.end(JSON.stringify(body));
}

function publicDefinitions() {
  const out = {};
  Object.keys(Privacy.DEFINITIONS).forEach((key) => {
    const d = Privacy.DEFINITIONS[key];
    out[key] = { title: d.title, purpose: d.purpose, categories: d.categories, recipients: d.recipients, text: d.text };
  });
  return out;
}

async function buildExport(id) {
  let member = null, contract = null, checkins = [], inbox = [], social = null;
  try { const raw = await M.getMember(id); member = raw ? M.publicProfile(raw) : null; } catch (e) {}
  try { contract = await M.getContract(id); } catch (e) {}
  try { checkins = await M.checkinHistory(id, { windows: 12 }); } catch (e) {}
  try { inbox = await require('../../lib/inbox').list(id); } catch (e) {}
  try { social = await require('../../lib/social').socialExport(id); } catch (e) {}
  const consents = await Privacy.listConsents(id);
  const appData = await Privacy.appDataExport(id);
  return {
    exportVersion: 1,
    generatedAt: new Date().toISOString(),
    controller: 'Fit-Inn Trier, Auf Hirtenberg 8, 54296 Trier',
    policyVersion: Privacy.POLICY_VERSION,
    scope: 'Mitglieder-App und über die App abrufbare Magicline-Daten',
    note: 'Gesetzlich aufzubewahrende Vertrags-, Beitrags- und Buchungsdaten werden nicht durch die App-Löschung entfernt.',
    member, contract, checkins, inbox, social, consents, appData,
  };
}

module.exports = async function handler(req, res) {
  const sess = await M.getSession(M.bearer(req));
  if (!sess) return json(res, 401, { ok: false, error: 'unauthorized' });
  const id = String(sess.id);

  if (req.method === 'GET') {
    const events = await Privacy.listConsents(id);
    return json(res, 200, {
      ok: true,
      policyVersion: Privacy.POLICY_VERSION,
      definitions: publicDefinitions(),
      consents: Privacy.currentConsents ? await Privacy.currentConsents(id) : {},
      events,
    });
  }
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  const body = await M.readBody(req);
  const action = String(body.action || '');
  if (!(await M.rateLimit('privacy:' + id, 12, 3600))) return json(res, 429, { ok: false, error: 'rate_limited' });

  if (action === 'export') {
    const data = await buildExport(id);
    res.setHeader('Content-Disposition', 'attachment; filename="fit-inn-datenauskunft-' + new Date().toISOString().slice(0, 10) + '.json"');
    return json(res, 200, { ok: true, data });
  }

  if (action === 'delete-app-data') {
    if (String(body.confirm || '') !== 'APP-DATEN LOESCHEN') {
      return json(res, 400, { ok: false, error: 'confirmation_required' });
    }
    const result = await Privacy.deleteAppData(id);
    return json(res, result.ok ? 200 : 500, Object.assign({
      message: result.ok
        ? 'Deine freiwilligen App-Daten wurden gelöscht. Gesetzlich aufzubewahrende Vertragsdaten bleiben unberührt.'
        : 'Ein Teil der App-Daten konnte nicht gelöscht werden. Bitte kontaktiere info@fit-inn-trier.de.',
    }, result));
  }

  return json(res, 400, { ok: false, error: 'bad_action' });
};

module.exports.buildExport = buildExport;
