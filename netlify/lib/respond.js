'use strict';
// Shared JSON responses for SyncNet Netlify Functions (Lambda-compatible {statusCode, headers, body}).
// Every response is JSON with nosniff and a deny-all CSP, so no function can serve markup under the
// site origin. publicError() only ever sends the fixed message the caller passes, never exception text;
// details belong in the server log (see log.js).

const BASE_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
});
// Callers may add headers (location, retry-after, CDN caching) and override cache-control, never these.
const LOCKED = new Set(Object.keys(BASE_HEADERS));
const GENERIC_MESSAGE = 'The request could not be completed.';

function serialize(body) {
  if (body === undefined) return '';
  // <, >, & and U+2028/2029 are escaped so the bytes stay inert even if a client ignored the content type.
  // JSON.parse returns exactly the same values.
  return JSON.stringify(body).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function json(statusCode, body, extraHeaders) {
  const headers = { ...BASE_HEADERS, 'cache-control': 'no-store' };
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [name, value] of Object.entries(extraHeaders)) {
      const key = String(name).toLowerCase();
      if (LOCKED.has(key) || value === undefined || value === null) continue;
      const text = String(value);
      if (/[\r\n\0]/.test(text)) continue; // no header injection
      headers[key] = text;
    }
  }
  return { statusCode, headers, body: serialize(body) };
}

// {error: message, code}. `message` must be a fixed, generic sentence; anything that is not a non-empty
// string (an Error object, undefined...) is replaced by a generic message.
function publicError(statusCode, code, message, extraHeaders) {
  const safeCode = typeof code === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : 'error';
  const safeMessage = typeof message === 'string' && message.trim() ? message.slice(0, 300) : GENERIC_MESSAGE;
  return json(statusCode, { error: safeMessage, code: safeCode }, extraHeaders);
}

function tooManyRequests(retryAfterSeconds) {
  const n = Number(retryAfterSeconds);
  const seconds = Number.isFinite(n) && n > 0 ? Math.min(86400, Math.ceil(n)) : 60;
  return json(
    429,
    { error: 'Too many requests. Please wait and try again.', code: 'rate_limited', retryAfter: seconds },
    { 'retry-after': String(seconds) },
  );
}

module.exports = { json, publicError, tooManyRequests, BASE_HEADERS };
