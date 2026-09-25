/*
 * SyncNet provenance statuses: one place that decides which label a token may carry, from evidence checked live.
 *
 *   SYNCNET ORIGIN                 curated record of a foundational SyncNet launch (pre-V2 live launcher); curated, not cryptographic
 *   BUILT WITH SYNCNET · VERIFIED  a syncnet.launch.proof.v2 that verifies against Robinhood Chain right now (verifyEvidence)
 *   OPERATOR VERIFIED              an operator claim signed by the token's on-chain deployer or current creator-fee recipient
 *   PAR INDEXED                    a PAR launch (factory record read on-chain); SyncNet holds no provenance for it
 *   PROFILE ONLY                   curated SyncNet profile information, no provenance asserted
 *   UNVERIFIED                     evidence was supplied but does not check out, or could not be checked right now
 *
 * Browser-local launch records are never passed in here: they are shown separately as "THIS BROWSER ONLY".
 * (Marketplace records use EIP-712 typed signatures in lib/syncnet-market.js, verified server-side — not this file.)
 * Shared by the pages (window.SyncNetProvenance) and Node tests (require()). Depends on SyncNetCore + SyncNetChain.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./syncnet-core.js'), require('./syncnet-chain.js'));
  else root.SyncNetProvenance = factory(root.SyncNetCore, root.SyncNetChain);
})(typeof self !== 'undefined' ? self : this, function (Core, Chain) {
  'use strict';
  if (!Core || !Chain) throw new Error('SyncNetProvenance requires SyncNetCore and SyncNetChain.');
  const lc = (v) => String(v == null ? '' : v).toLowerCase();

  const STATUS = Object.freeze({
    ORIGIN: Object.freeze({ key: 'origin', label: 'SYNCNET ORIGIN', cls: 'origin', what: 'Curated SyncNet record of a foundational project launched before the V2 live launcher. It records origin only; it is a curated record, not a cryptographic proof.' }),
    BUILT: Object.freeze({ key: 'built', label: 'BUILT WITH SYNCNET · VERIFIED', cls: 'built', what: 'Checked against Robinhood Chain just now: the deployer signed the SyncNet launch intent, the launch transaction carried its salt, and that transaction deployed this token.' }),
    OPERATOR: Object.freeze({ key: 'operator', label: 'OPERATOR VERIFIED', cls: 'verified', what: 'The token’s deployer or current creator-fee recipient signed a SyncNet operator claim for this token (signature checked just now). It proves control of that wallet, not the quality of the project.' }),
    INDEXED: Object.freeze({ key: 'indexed', label: 'PAR INDEXED', cls: 'indexed', what: 'A PAR launch: its factory record was read on-chain. SyncNet holds no launch provenance for it.' }),
    PROFILE: Object.freeze({ key: 'profile', label: 'PROFILE ONLY', cls: 'profile', what: 'SyncNet shows curated profile information. No launch provenance is asserted.' }),
    UNVERIFIED: Object.freeze({ key: 'unverified', label: 'UNVERIFIED', cls: 'unverified', what: 'Provenance evidence exists but did not check out against the chain, or could not be checked right now.' }),
  });

  // ---- operator claims (signed by the deployer or the current creator-fee recipient)
  const OPERATOR_CLAIM = /^SyncNet operator claim v1\nchainId:(\d+)\ntoken:(0x[0-9a-fA-F]{40})\noperator:(0x[0-9a-fA-F]{40})\nissuedAt:(\d{4}-\d{2}-\d{2}T[0-9:.]{5,15}Z)$/;
  function operatorClaimMessage({ chainId, token, operator, issuedAt }) {
    return ['SyncNet operator claim v1', 'chainId:' + Number(chainId), 'token:' + lc(token), 'operator:' + lc(operator), 'issuedAt:' + (issuedAt || new Date().toISOString())].join('\n');
  }
  async function signatureBy(rpc, address, message, signature) {
    let signer = '';
    try { signer = lc(Core.recoverPersonalSignAddress(message, signature)); } catch (e) { signer = ''; }
    if (signer && signer === lc(address)) return 'ecdsa';
    try {
      const code = lc(await Chain.getCode(rpc, address));
      if (code && code !== '0x' && !code.startsWith('0xef0100')) {
        const out = await Chain.ethCall(rpc, address, Chain.SEL.isValidSignature + Core.abiEncode(['bytes32', 'bytes'], [Core.hashPersonalMessage(message), signature]).slice(2));
        if (lc(out).slice(0, 10) === '0x1626ba7e') return 'eip1271';
      }
    } catch (e) { /* not approved */ }
    return '';
  }
  /** → {ok, role:'deployer'|'fee-recipient', operator, detail} */
  async function verifyOperatorProof(rpc, token, proof, launch) {
    const m = OPERATOR_CLAIM.exec(String((proof && proof.message) || ''));
    if (!m) return { ok: false, detail: 'operator claim is not in the SyncNet format' };
    if (Number(m[1]) !== Chain.ROBINHOOD.chainId || lc(m[2]) !== lc(token)) return { ok: false, detail: 'operator claim is for another token or chain' };
    const operator = lc(m[3]);
    const rec = launch === undefined ? await Chain.readLaunch(rpc, token) : launch;
    if (!rec) return { ok: false, detail: 'not a PAR launch on-chain' };
    const role = lc(rec.deployer) === operator ? 'deployer' : lc(rec.creatorFeeRecipient) === operator ? 'fee-recipient' : '';
    if (!role) return { ok: false, detail: 'the claimed operator is neither the deployer nor the current creator-fee recipient' };
    const how = await signatureBy(rpc, operator, String(proof.message), String(proof.signature || ''));
    if (!how) return { ok: false, detail: 'signature does not match the claimed operator' };
    return { ok: true, role, operator, detail: `signed by the ${role === 'deployer' ? 'deployer' : 'current creator-fee recipient'} ${operator}${how === 'eip1271' ? ' (EIP-1271 contract wallet)' : ''}` };
  }

  /**
   * assess(rpc, {token, profile?, serverEntry?, launch?}) → {status, detail, checks, proofResult, launch, canonical}
   * launch: Chain.readLaunch() result, null (not a PAR launch) or undefined (read here). 'unavailable' if the caller could not read it.
   */
  async function assess(rpc, input) {
    const token = lc(input.token);
    const profile = input.profile || null;
    let launch = input.launch;
    if (launch === undefined) {
      try { launch = await Chain.readLaunch(rpc, token); } catch (e) { launch = 'unavailable'; }
    }
    const canonical = Boolean(profile && profile.registry && profile.registry.canonical === true && lc(profile.token) === token);
    const proof = (input.serverEntry && input.serverEntry.proof) || (profile && profile.proof) || null;
    if (proof) {
      if (lc(proof.token) !== token) return { status: STATUS.UNVERIFIED, detail: 'the supplied proof is for another token', checks: [], launch, canonical };
      const r = await Chain.verifyEvidence(rpc, proof);
      if (r.status === 'VERIFIED') return { status: STATUS.BUILT, detail: STATUS.BUILT.what, checks: r.checks, proofResult: r, launch, canonical };
      return { status: STATUS.UNVERIFIED, detail: r.status === 'UNAVAILABLE' ? 'The chain could not be read right now, so the SyncNet launch proof was not checked.' : 'The SyncNet launch proof did not verify: ' + r.checks.filter((c) => !c.ok).map((c) => c.label).join('; ') + '.', checks: r.checks, proofResult: r, launch, canonical };
    }
    const reg = (profile && profile.registry) || {};
    if (reg.status === 'origin') return { status: STATUS.ORIGIN, detail: reg.definition || STATUS.ORIGIN.what, checks: [], launch, canonical };
    if (profile && profile.operatorProof) {
      if (launch === 'unavailable') return { status: STATUS.UNVERIFIED, detail: 'The chain could not be read right now, so the operator claim was not checked.', checks: [], launch, canonical };
      const o = await verifyOperatorProof(rpc, token, profile.operatorProof, launch);
      return o.ok ? { status: STATUS.OPERATOR, detail: 'Operator claim ' + o.detail + '.', operator: o, checks: [], launch, canonical } : { status: STATUS.UNVERIFIED, detail: 'Operator claim not verified: ' + o.detail + '.', checks: [], launch, canonical };
    }
    if (profile) return { status: STATUS.PROFILE, detail: STATUS.PROFILE.what, checks: [], launch, canonical };
    if (launch && launch !== 'unavailable') return { status: STATUS.INDEXED, detail: STATUS.INDEXED.what, checks: [], launch, canonical };
    return { status: null, detail: '', checks: [], launch, canonical };
  }

  return Object.freeze({ STATUS, assess, verifyOperatorProof, operatorClaimMessage });
});
