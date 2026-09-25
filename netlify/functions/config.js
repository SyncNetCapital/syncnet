'use strict';
// GET /api/config -> the server-side rollout gate as the pages see it:
//   { publicLaunch, publicUploads, registrySubmissions, founderGate, chainId, version }
// The values come only from this deployment's environment (see ../lib/flags.js). A URL parameter or a
// browser setting can never turn a public feature on. No configuration details are exposed.
const { json, publicError } = require('../lib/respond');
const { flags } = require('../lib/flags');

async function handler(event = {}, deps = {}) {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return publicError(405, 'method_not_allowed', 'GET only.', { allow: 'GET' });
  const f = flags({ env: deps.env, store: deps.store });
  return json(200, {
    publicLaunch: f.publicLaunch,
    publicUploads: f.publicUploads,
    registrySubmissions: f.registrySubmissions,
    marketplace: f.marketplace === true,
    founderGate: true,
    chainId: 4663,
    version: 'v2.5-rc',
  });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
