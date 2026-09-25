'use strict';
// Structured logs: one JSON line per event via console.log (Netlify function logs).
// Client IPs and wallet addresses go through hashId() first, so raw identifiers never reach the logs.
// Error details (name/message/code) are logged here, server side only, and never sent to clients.
const crypto = require('crypto');

const DEFAULT_SALT = 'syncnet-log-v1';
const RESERVED = new Set(['ts', 'fn', 'event']);

// First 16 hex chars of HMAC-SHA256(SYNCNET_LOG_SALT || 'syncnet-log-v1', value).
function hashId(value) {
  const salt = process.env.SYNCNET_LOG_SALT || DEFAULT_SALT;
  const text = value === undefined || value === null ? '' : String(value);
  return crypto.createHmac('sha256', salt).update(text, 'utf8').digest('hex').slice(0, 16);
}

function log(fn, event, fields) {
  const line = { ts: new Date().toISOString(), fn: String(fn || 'unknown'), event: String(event || 'event') };
  if (fields && typeof fields === 'object') {
    for (const [key, value] of Object.entries(fields)) {
      if (RESERVED.has(key) || key === '__proto__' || value === undefined) continue;
      line[key] = value;
    }
  }
  let text;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ ts: line.ts, fn: line.fn, event: line.event, logError: 'fields-not-serializable' });
  }
  console.log(text);
}

function describe(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return { name: 'Error', message: String(err).slice(0, 500) };
  const out = { name: String(err.name || 'Error').slice(0, 100), message: String(err.message || '').slice(0, 500) };
  if (err.code !== undefined && err.code !== null) out.code = String(err.code).slice(0, 100);
  return out;
}

function logError(fn, event, err, fields) {
  const error = describe(err);
  if (err && typeof err === 'object' && err.cause && err.cause !== err) error.cause = describe(err.cause);
  log(fn, event, { ...(fields || {}), error });
}

module.exports = { log, logError, hashId };
