'use strict';
/*
 * SyncNet Project Home — OPS SUSPENSION (SyncNet moderation). Separate from the operator's own unpublish.
 *
 *   site:suspension:v1:<token>   current state {schema, token, status: SUSPENDED|REINSTATED, category, note, actor, at,
 *                                since, seq}
 *   site:audit:v1:<token>        the project's append-only audit set (shared with activation/publish events):
 *                                {type: 'ops-suspend'|'ops-reinstate', token, category, note, actor, at, seq}
 *   site:suspended:v1            index of every token that has ever been suspended (ops listing)
 *
 * Authority: there is NO HTTP route to suspend() / reinstate(). They run only from the ops CLI
 * (netlify/ops/project-home-suspension.mjs) with the production store credentials — the same pattern as
 * grantComplimentary. No wallet signature (the Passport operator's included) ever reaches this code, so a Passport
 * operator cannot suspend, reinstate or override a suspension.
 *
 * Effect while SUSPENDED: /site/<token> answers a neutral "currently unavailable" page, the revision content view is
 * not served, and publish / restore / adopt are refused (the operator can still unpublish). The entitlement, payment
 * intents, activation registry, revisions and the Passport are never modified. Only `category` and `since` are ever
 * public; `note` and `actor` stay internal. A record that exists but cannot be parsed counts as SUSPENDED (fail closed).
 */
const CATEGORIES = Object.freeze(['security', 'abuse', 'legal', 'third-party-rights', 'terms']);
const K = Object.freeze({
  suspension: (t) => `site:suspension:v1:${t}`,
  audit: (t) => `site:audit:v1:${t}`,
  index: 'site:suspended:v1',
});
const PUBLIC_MESSAGE = 'This Project Home is currently unavailable.';
const isAddr = (v) => /^0x[0-9a-f]{40}$/.test(String(v || ''));

/** {raw, suspended, record}. Store errors propagate: every caller already fails closed on them. */
async function readSuspension(store, token) {
  const raw = await store.get(K.suspension(token));
  if (!raw) return { raw: null, suspended: false, record: null };
  let record = null;
  try { record = JSON.parse(raw); } catch { record = null; }
  return { raw, suspended: !record || record.status !== 'REINSTATED', record };
}

/** The only suspension facts ever returned over HTTP. */
function publicSuspension(s) {
  if (!s || !s.suspended) return null;
  const r = s.record || {};
  return { status: 'SUSPENDED', category: CATEGORIES.includes(r.category) ? r.category : null, since: r.since || null };
}

function args(token, { actor, note } = {}) {
  const t = String(token || '').toLowerCase();
  if (!isAddr(t)) throw new Error('invalid token address');
  const a = String(actor || '').trim();
  if (!a || a.length > 80) throw new Error('actor is required (at most 80 characters)');
  if (note !== undefined && (typeof note !== 'string' || note.length > 1000)) throw new Error('note must be text of at most 1000 characters');
  return { t, a, n: note ? note : '' };
}

async function write(store, t, prev, record, type) {
  if (typeof store.cas !== 'function') throw new Error('an atomic (cas) store is required');
  const event = { type, token: t, category: record.category, note: record.note, actor: record.actor, at: record.at, seq: record.seq };
  const ok = await store.cas({
    expect: [[K.suspension(t), prev.raw]],
    set: [[K.suspension(t), JSON.stringify(record)]],
    sadd: [[K.audit(t), JSON.stringify(event)], [K.index, t]],
  });
  if (!ok) throw new Error('the suspension state changed concurrently; read it again');
  return record;
}

async function suspend(store, token, { category, note, actor, now } = {}) {
  const { t, a, n } = args(token, { actor, note });
  if (!CATEGORIES.includes(category)) throw new Error('category must be one of: ' + CATEGORIES.join(', '));
  const prev = await readSuspension(store, t);
  if (prev.suspended) throw new Error('this Project Home is already suspended');
  const at = new Date(now ? now() : Date.now()).toISOString();
  const seq = ((prev.record && Number(prev.record.seq)) || 0) + 1;
  return write(store, t, prev, { schema: 'syncnet.project-home.suspension.v1', token: t, status: 'SUSPENDED', category, note: n, actor: a, at, since: at, seq }, 'ops-suspend');
}

async function reinstate(store, token, { note, actor, now } = {}) {
  const { t, a, n } = args(token, { actor, note });
  const prev = await readSuspension(store, t);
  if (!prev.suspended) throw new Error('this Project Home is not suspended');
  const at = new Date(now ? now() : Date.now()).toISOString();
  const r = prev.record || {};
  const seq = (Number(r.seq) || 0) + 1;
  return write(store, t, prev, { schema: 'syncnet.project-home.suspension.v1', token: t, status: 'REINSTATED', category: r.category || null, note: n, actor: a, at, since: null, suspendedSince: r.since || null, seq }, 'ops-reinstate');
}

/** Ops audit trail for one token, oldest first. */
async function history(store, token) {
  const t = String(token || '').toLowerCase();
  const rows = (await store.smembers(K.audit(t))).map((m) => { try { return JSON.parse(m); } catch { return null; } });
  return rows.filter((e) => e && /^ops-/.test(e.type)).sort((x, y) => (x.seq || 0) - (y.seq || 0));
}

module.exports = { CATEGORIES, K, PUBLIC_MESSAGE, readSuspension, publicSuspension, suspend, reinstate, history };
