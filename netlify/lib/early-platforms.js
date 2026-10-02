'use strict';
// SYNC Proof / EARLY: server-side per-platform ADAPTERS. The protocol (lib/syncnet-early.js) only knows an identity as
// (platform, immutable externalId); everything a platform needs on the server that is NOT protocol (how its creators
// authenticate, how its audience context is fetched, the exact attestation claims it records) lives here, so the shared
// code (early.js, early-snapshot.js, early-youtube-auth.js) never mentions a platform by name.
//
// YouTube and X are registered. Registering an adapter is necessary but not sufficient to serve a platform: it must also be
// enabled in early-config.js (`platforms`; X needs an explicit flag). The YouTube claim shapes below are the ones already signed, anchored and
// embedded in existing receipts; they are written out literally and pinned by tests/early/platform.test.mjs: do not
// "tidy" them (an attestation id is a hash of its exact claims).
const E = require('../../lib/syncnet-early.js');
const { OAUTH_SCOPE: YOUTUBE_OAUTH_SCOPE, makeYouTube } = require('./early-youtube');
const XClient = require('./early-x');

/**
 * How an identity is spelled inside attestation subjects/claims. YouTube keeps the v1 name `channelId` (existing signed
 * attestations use it); any other platform names it `externalId`.
 */
const idFields = (platform, externalId) => (platform === E.PLATFORM ? { channelId: externalId } : { externalId });

const youtube = Object.freeze({
  platform: 'youtube',
  label: 'YouTube',
  noun: 'YouTube channel',
  authStart: '/api/early-youtube-auth', // creator onboarding entry (302 to the provider); the callback is the same function
  oauthScope: YOUTUBE_OAUTH_SCOPE,
  identityMethod: 'google-oauth2 youtube.readonly channels.mine', // the `method` of a creator-identity attestation
  batchSize: 50, // ids per audience read
  /** Mutable display metadata from an OAuth link record (never identity). */
  displayFromLink: (link) => ({ title: E.clean(link.title, 80), avatarUrl: link.avatarUrl || '', handle: E.clean(link.handle, 40) }),
  /** Display refresh from a fresh platform read; keeps the previous avatar/handle when the read has none. */
  refreshDisplay: (rec, cur) => ({ title: E.clean(rec.title, 80), avatarUrl: rec.avatarUrl || cur.avatarUrl, handle: E.clean(rec.handle, 40) || cur.handle }),
  /** Many ids -> Map(externalId -> platform record); `client` is the platform's API client. */
  fetchMany: (client, ids) => client.channelsById(ids),
  /** The join-day snapshot, from the OAuth link record (a value read at that moment). -> {subject, claims} */
  enrolmentSnapshot: (externalId, link, dateUTC) => ({
    subject: { channelId: externalId },
    claims: { channelId: externalId, dateUTC, title: E.clean(link.title, 80), subscriberCount: link.hiddenSubscriberCount || link.subscriberCount == null ? null : Number(link.subscriberCount), hiddenSubscriberCount: Boolean(link.hiddenSubscriberCount), fetchedAt: Number(link.at), source: 'youtube-data-api-v3 channels.list statistics (oauth link, enrolment)' },
  }),
  /** The scheduled daily snapshot from a platform record (see fetchMany). -> {subject, claims} */
  dailySnapshot: (externalId, rec, dateUTC, fetchedAt) => ({
    subject: { channelId: externalId },
    claims: { channelId: externalId, dateUTC, title: E.clean(rec.title, 80), subscriberCount: rec.hidden ? null : rec.subscriberCount, hiddenSubscriberCount: Boolean(rec.hidden), fetchedAt, source: 'youtube-data-api-v3 channels.list statistics' },
  }),
});

// X. The immutable identity is the numeric user id (a string); the audience context is the follower count, recorded as a
// dated, approximate attestation that is never identity and never part of payment validity. The snapshot deliberately
// carries NO display name, handle or avatar (all mutable): only {platform, externalId, kind, count, time, source}.
const X_SNAPSHOT_FIELDS = (externalId, dateUTC, followerCount, fetchedAt, source) => ({
  subject: { externalId },
  claims: { platform: 'x', externalId, dateUTC, audienceKind: 'followers', followerCount, fetchedAt, source },
});
const x = Object.freeze({
  platform: 'x',
  label: 'X',
  noun: 'X account',
  authStart: '/api/early-x-auth',
  oauthScope: XClient.OAUTH_SCOPE,
  identityMethod: 'x-oauth2-pkce ' + XClient.OAUTH_SCOPE + ' GET /2/users/me',
  batchSize: 100,
  metered: true, // every audience read is a metered API request: the snapshot job counts it against the daily allowance
  displayFromLink: (link) => ({ title: E.clean(link.title, 80), avatarUrl: link.avatarUrl || '', handle: E.clean(link.handle, 40) }),
  refreshDisplay: (rec, cur) => ({ title: E.clean(rec.title, 80) || cur.title, avatarUrl: rec.avatarUrl || cur.avatarUrl, handle: E.clean(rec.handle, 40) || cur.handle }),
  fetchMany: (client, ids) => client.usersById(ids),
  /** null = nothing honest to record (no follower count was returned): the day stays "unavailable", never a guess. */
  enrolmentSnapshot: (externalId, link, dateUTC) => (Number.isSafeInteger(link.followerCount) && link.followerCount >= 0
    ? X_SNAPSHOT_FIELDS(externalId, dateUTC, link.followerCount, Number(link.at), 'x-api-v2 users/me public_metrics.followers_count (oauth link, enrolment)') : null),
  dailySnapshot: (externalId, rec, dateUTC, fetchedAt) => (Number.isSafeInteger(rec.followerCount) && rec.followerCount >= 0
    ? X_SNAPSHOT_FIELDS(externalId, dateUTC, rec.followerCount, fetchedAt, 'x-api-v2 users public_metrics.followers_count') : null),
});

const ADAPTERS = Object.freeze({ youtube, x });
const adapterOf = (platform) => (E.isPlatform(platform) && Object.prototype.hasOwnProperty.call(ADAPTERS, platform) ? ADAPTERS[platform] : null);

/**
 * The platform's API client for server-side reads (resolver, snapshots), or null when its credential is absent.
 * Credentials are read here and nowhere else in the shared code; they are never logged or returned.
 */
function clientFor(platform, env, fetchImpl) {
  const e = env || process.env;
  if (platform === 'youtube') return e.SYNCNET_YOUTUBE_API_KEY ? makeYouTube({ fetch: fetchImpl, apiKey: e.SYNCNET_YOUTUBE_API_KEY }) : null;
  if (platform === 'x') return String(e.SYNCNET_X_BEARER_TOKEN || '').trim() ? XClient.makeX({ fetch: fetchImpl, bearer: String(e.SYNCNET_X_BEARER_TOKEN).trim() }) : null;
  return null;
}

module.exports = { ADAPTERS, adapterOf, idFields, clientFor };
