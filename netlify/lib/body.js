'use strict';
// Request helpers shared by the functions: bounded JSON bodies, headers and query parameters.

// Returns the parsed JSON object, or null when the body is missing, too large, not JSON or not an object.
function readJsonBody(event, maxChars) {
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 4096;
  const body = event && event.body;
  if (typeof body !== 'string' || !body) return null;
  // A base64 body is ~4/3 of the decoded size; check before decoding.
  if (body.length > (event.isBase64Encoded ? Math.ceil(limit * 4 / 3) + 4 : limit)) return null;
  let raw;
  try {
    raw = event.isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  } catch {
    return null;
  }
  if (raw.length > limit) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function header(event, name) {
  const headers = (event && event.headers) || {};
  const want = String(name).toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === want) return String(headers[key]);
  return '';
}

function query(event, name) {
  const q = (event && event.queryStringParameters) || {};
  const v = q[name];
  return typeof v === 'string' ? v : '';
}

function method(event) {
  return String((event && event.httpMethod) || '').toUpperCase();
}

module.exports = { readJsonBody, header, query, method };
