'use strict';
// SYNC Proof / EARLY: server-side per-platform ADAPTERS. The protocol (lib/syncnet-early.js) only knows an identity as
// (platform, immutable externalId); everything a platform needs on the server that is NOT protocol (how its creators
// authenticate, how its audience context is fetched, the exact attestation claims it records) lives here, so the shared
// code (early.js, early-snapshot.js, early-youtube-auth.js) never mentions a platform by name.
//
// ONLY YouTube is registered. Registering an adapter is necessary but not sufficient to serve a platform: it must also be
// enabled in early-config.js (`platforms`). The YouTube claim shapes below are the ones already signed, anchored and
// embedded in existing receipts; they are written out literally and pinned by tests/early/platform.test.mjs: do not
// "tidy" them (an attestation id is a hash of its exact claims).
const E = require('../../lib/syncnet-early.js');
const { OAUTH_SCOPE: YOUTUBE_OAUTH_SCOPE } = require('./early-youtube');

/**
 * How an identity is spelled inside attestation subjects/claims. YouTube keeps the v1 name `channelId` (existing signed
 * attestations use it); any other platform names it `externalId`.
 */
const idFields = (platform, externalId) => (platform === E.PLATFORM ? { channelId: externalId } : { externalId });

const youtube = Object.freeze({
  platform: 'youtube',
  label: 'YouTube',
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

const ADAPTERS = Object.freeze({ youtube });
const adapterOf = (platform) => (E.isPlatform(platform) && Object.prototype.hasOwnProperty.call(ADAPTERS, platform) ? ADAPTERS[platform] : null);

module.exports = { ADAPTERS, adapterOf, idFields };
