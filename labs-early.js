/*
 * EARLY (SYNC Proof) — fan surfaces, client-routed by path under /labs/early (docs/sync-proof-early-spec.md §15, §16):
 *   /labs/early                    landing: Count me in + creator setup link
 *   /labs/early/c/<channelId>      creator page + the support flow (connect → sign what you mean → send → verified)
 *   /labs/early/c/<platform>/<id>  the canonical form: youtube/<UC…> (same page as the legacy URL above, kept permanently)
 *                                  and x/<numeric user id> (only when the server's config enables X)
 *   /labs/early/receipt?intent=…   the private receipt (resumes from the server; recovery by tx hash; card)
 *   /labs/early/mine               private list (fan session = one free signature, off the happy path)
 *   /labs/early/v/<shareId>        public verification page of a card
 *
 * The page never builds anything but the standard ERC-20 transfer the server returned with the stored intent, and only
 * after the signed intent is persisted. Two wallet prompts on the happy path. Consumer language: no investment framing.
 */
(function () {
  'use strict';
  const UI = window.SyncNetUI, W = window.SyncNetWallet, Core = window.SyncNetCore, E = window.SyncNetEarly;
  const $ = (id) => document.getElementById(id);
  const esc = UI.esc, short = UI.short;
  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage may be blocked */ } },
  };
  const session = { get() { try { return sessionStorage.getItem('syncnet_early_fan_session') || ''; } catch { return ''; } }, set(v) { try { if (v) sessionStorage.setItem('syncnet_early_fan_session', v); else sessionStorage.removeItem('syncnet_early_fan_session'); } catch { /* blocked */ } } };
  const S = { cfg: null, creator: null, intent: null, polling: 0, busy: false, route: null, platform: 'youtube' };
  // X is offered ONLY when the server's own config says it is enabled (the server enforces the gate on every request regardless)
  const xOn = () => Boolean(S.cfg && Array.isArray(S.cfg.platforms) && S.cfg.platforms.includes('x') && S.cfg.platformServices && S.cfg.platformServices.x && S.cfg.platformServices.x.resolver);
  const status = (m, tone, id) => { const el = $(id || 'eStatus'); if (!el) return; el.textContent = m || ''; if (tone) el.dataset.tone = tone; else delete el.dataset.tone; };
  const flow = (m, tone) => status(m, tone, 'eFlowStatus');

  async function api(params) { const r = await fetch('/api/early?' + new URLSearchParams(params), { cache: 'no-store', headers: session.get() ? { 'x-syncnet-early-session': session.get() } : {} }); const j = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, body: j }; }
  async function post(body) { const r = await fetch('/api/early', { method: 'POST', headers: { 'content-type': 'application/json', ...(session.get() ? { 'x-syncnet-early-session': session.get() } : {}) }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, body: j }; }
  const errText = (r, fallback) => (r && r.body && r.body.error) || fallback || 'The request was refused.';
  const rejected = (e) => e && (e.code === 4001 || /reject|denied/i.test(String(e.message)));
  const nonce = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); };
  const nowSec = () => Math.floor(Date.now() / 1000);
  const fmtDate = (d) => { try { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }); } catch { return d; } };
  // follower context (X) is always named as such ("Followers on X then: …"); every other case keeps the original wording
  const audienceText = (a) => (a && a.kind === 'followers' ? E.audienceLine(a) : !a || a.state === 'unavailable' ? 'Audience then: unavailable' : a.state === 'hidden' ? 'Audience then: hidden' : 'Audience then: ' + a.display);
  const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // ---------------------------------------------------------------- routing
  function route() {
    const p = location.pathname.replace(/\/+$/, '');
    const q = new URLSearchParams(location.search);
    let m;
    if ((m = /^\/labs\/early\/c\/(UC[A-Za-z0-9_-]{22})$/.exec(p))) return { name: 'creator', platform: 'youtube', externalId: m[1] };
    // canonical /c/<platform>/<id>: the id must be that platform's immutable id shape, otherwise the route is not a creator page
    if ((m = /^\/labs\/early\/c\/([a-z]{1,16})\/([^/]+)$/.exec(p)) && (m[1] === 'youtube' || m[1] === 'x') && E.isExternalId(m[1], m[2])) return { name: 'creator', platform: m[1], externalId: m[2] };
    if (p === '/labs/early/receipt') return { name: 'receipt', intent: lc(q.get('intent') || '') };
    if (p === '/labs/early/mine') return { name: 'mine' };
    if ((m = /^\/labs\/early\/v\/(0x[0-9a-f]{64})$/i.exec(p))) return { name: 'card', shareId: lc(m[1]) };
    return { name: 'landing' };
  }
  function show(id) { for (const s of ['eLanding', 'eCreator', 'eReceipt', 'eMine', 'eCard']) $(s).hidden = s !== id; }

  async function init() {
    S.route = route();
    const cfg = await api({ view: 'config' }).catch(() => null);
    S.cfg = cfg && cfg.body ? cfg.body : null;
    if (!S.cfg || !S.cfg.enabled) { $('eGate').hidden = false; return; }
    if (S.route.name === 'creator') return creatorPage(S.route);
    if (S.route.name === 'receipt') return receiptPage(S.route.intent);
    if (S.route.name === 'mine') return minePage();
    if (S.route.name === 'card') return cardPage(S.route.shareId);
    return landing();
  }

  // ---------------------------------------------------------------- landing: Count me in
  function landing() {
    show('eLanding');
    $('eCmiFind').addEventListener('click', findCreator);
    $('eCmiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findCreator(); } });
    if (xOn()) platformTabs();
  }
  /** YouTube | X, rendered only when the server enables X; the existing .sn-filters tabs (aria-pressed), YouTube pressed by default. */
  function platformTabs() {
    const label = document.querySelector('label[for="eCmiInput"]'), input = $('eCmiInput');
    const original = { label: label.textContent, placeholder: input.placeholder };
    const words = { youtube: original, x: { label: 'X username or profile link', placeholder: 'x.com/username' } };
    label.insertAdjacentHTML('beforebegin', '<div class="sn-filters" id="ePlatform" role="group" aria-label="Platform" style="margin:14px 0 0"><button type="button" data-platform="youtube" aria-pressed="true">YouTube</button><button type="button" data-platform="x" aria-pressed="false">X</button></div>');
    $('ePlatform').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-platform]');
      if (!b || b.dataset.platform === S.platform) return;
      S.platform = b.dataset.platform;
      for (const t of $('ePlatform').querySelectorAll('button')) t.setAttribute('aria-pressed', String(t.dataset.platform === S.platform));
      label.textContent = words[S.platform].label; input.placeholder = words[S.platform].placeholder; input.value = '';
      $('eCmiResult').hidden = true; $('eCmiResult').innerHTML = ''; status('');
    });
  }
  async function findCreator() {
    const v = $('eCmiInput').value.trim();
    if (!v) return;
    const x = S.platform === 'x' && xOn();
    status(x ? 'Looking up the account…' : 'Looking up the channel…');
    const r = await api(x ? { view: 'resolve', platform: 'x', q: v } : { view: 'resolve', yt: v });
    if (!r.ok) { status(errText(r, x ? 'That account could not be found.' : 'That channel could not be found.'), 'bad'); return; }
    status('');
    const ch = r.body;
    const c = await api(x ? { view: 'creator', platform: 'x', externalId: ch.externalId } : { view: 'creator', channelId: ch.channelId });
    const on = c.ok && c.body.onEarly;
    const box = $('eCmiResult');
    box.hidden = false;
    // X: the person-facing line is the current @username (display metadata); the immutable numeric id only builds the link
    box.innerHTML = `<div class="early-head small">${UI.logoHtml('', ch.title)}<div><strong>${esc(ch.title)}</strong><br><span class="sn-small sn-muted">${esc(x ? ch.handle || 'X account' : ch.handle || ch.channelId)}</span></div></div>` +
      (on ? `<p><a class="sn-btn primary" href="/labs/early/c/${x ? 'x/' + esc(ch.externalId) : esc(ch.channelId)}">On EARLY · Support directly →</a></p>`
        : `<p class="sn-dim sn-small">Not on EARLY yet. Leave a private signal: free, no amount, nothing reserved. It never counts as support.</p><p><button class="sn-btn primary" type="button" id="eCmiSign">Count me in</button></p><p class="sn-status sn-small" id="eCmiStatus" role="status"></p>`);
    if (!on) $('eCmiSign').addEventListener('click', () => countMeIn(ch));
  }
  async function countMeIn(ch) {
    const st = (m, t) => status(m, t, 'eCmiStatus');
    try {
      if (!W.state().connected) { st('Connect your wallet…'); await W.connect(); }
      const fan = W.state().account;
      if (!fan) return;
      const x = ch.platform === 'x';
      const m = { schema: E.SCHEMA.countMeIn, platform: x ? 'x' : 'youtube', channelId: x ? ch.externalId : ch.channelId, fan, issuedAt: nowSec(), expiry: nowSec() + E.CONST.CMI_TTL_S, nonce: nonce() };
      st('Sign the free signal in your wallet…');
      const signature = await W.signTyped(E.typedData('CountMeIn', m));
      const r = await post(x ? { action: 'count-me-in', platform: 'x', externalId: m.channelId, fan, issuedAt: m.issuedAt, expiry: m.expiry, nonce: m.nonce, signature } : { action: 'count-me-in', channelId: m.channelId, fan, issuedAt: m.issuedAt, expiry: m.expiry, nonce: m.nonce, signature });
      if (!r.ok) throw new Error(errText(r, 'The signal was not recorded.'));
      st('Counted in. Private, free and non-binding. You will see it under My EARLY.', 'ok');
      $('eCmiSign').disabled = true;
    } catch (e) { st(rejected(e) ? 'You did not sign. Nothing was recorded.' : (e.message || 'Something went wrong.'), 'bad'); }
  }

  // ---------------------------------------------------------------- creator page + support flow
  const KEY = (cid) => 'syncnet_early_intent_' + cid;
  async function creatorPage(rt) {
    show('eCreator');
    const x = rt.platform === 'x';
    // YouTube (legacy and /youtube/ routes) asks exactly as before; X asks by (platform, immutable numeric id)
    const r = await api(x ? { view: 'creator', platform: 'x', externalId: rt.externalId } : { view: 'creator', channelId: rt.externalId });
    if (!r.ok || !r.body.onEarly) { $('eTitle').textContent = 'Not on EARLY'; $('eSupportPanel').hidden = true; $('eHandle').textContent = (x ? 'This account' : 'This channel') + ' has not joined EARLY. You can leave a private Count me in signal from the EARLY page.'; return; }
    const c = S.creator = r.body;
    $('eTitle').textContent = c.display.title || 'Creator';
    $('eHandle').textContent = c.display.handle || (x ? 'X account' : c.channelId);
    if (x) { document.querySelector('#eCreator .early-head .sn-label').textContent = 'EARLY · X creator'; $('eWallet').nextElementSibling.textContent = 'verified for this account by SyncNet'; }
    if (c.display.avatarUrl) $('eAvatar').innerHTML = `<img src="${esc(c.display.avatarUrl)}" alt="">`; else $('eAvatar').textContent = (c.display.title || '·').charAt(0).toUpperCase();
    const m = c.currentManifest;
    $('eWallet').textContent = m ? short(m.receivingWallet) : '—';
    const assets = S.cfg.assets;
    const symbolOf = (t) => { const a = assets.find((x) => x.token === t); return a ? a.symbol : short(t); };
    const decimalsOf = (t) => { const a = assets.find((x) => x.token === t); return a ? a.decimals : 18; };
    $('eAssets').innerHTML = m ? m.acceptedAssets.map((a) => `<span class="sn-mono">${esc(symbolOf(a.token))}</span> <span class="sn-small sn-muted">min ${esc(E.formatUnits(a.minAmount, decimalsOf(a.token)))}</span>`).join(' · ') : '—';
    if (c.rotation && c.rotation.pending) { $('eWarn').hidden = false; $('eWarnText').textContent = 'This creator is changing their receiving wallet on ' + new Date(c.rotation.effectiveAt * 1000).toUTCString() + '. Support sent before then goes to the current verified wallet shown here.'; }
    if (c.paused) { $('eWarn').hidden = false; $('eWarnText').textContent = 'This creator has paused support for now.'; }
    const sel = $('eAsset');
    sel.innerHTML = (m ? m.acceptedAssets : []).map((a) => `<option value="${esc(a.token)}">${esc(symbolOf(a.token))}</option>`).join('');
    const showMin = () => { const a = m.acceptedAssets.find((x) => x.token === sel.value); if (a) $('eMin').textContent = 'Minimum ' + E.formatUnits(a.minAmount, decimalsOf(a.token)) + ' ' + symbolOf(a.token) + '. The exact amount you enter is what the creator receives.'; };
    sel.addEventListener('change', showMin); showMin();
    if (!c.acceptsSupport) { $('eConnect').disabled = true; $('eSign').disabled = true; }
    W.onChange(renderFlow);
    $('eConnect').addEventListener('click', async () => { try { await W.connect(); } catch (e) { if (e && e.code === 'NO_WALLET') walletApps(); else flow(e.message || 'The wallet did not connect.', 'bad'); } });
    $('eSign').addEventListener('click', signIntent);
    $('eSend').addEventListener('click', sendTransfer);
    // resume: an intent already stored for this creator in this browser
    const saved = store.get(KEY(c.creatorId));
    if (saved && saved.intentId) { const iv = await api({ view: 'intent', intent: saved.intentId }); if (iv.ok) { S.intent = iv.body.intent; if (S.intent.status === 'CONSUMED') { store.set(KEY(c.creatorId), null); S.intent = null; } } }
    if (!W.state().connected && isMobile()) { const has = await new Promise((res) => setTimeout(() => res(Boolean(window.ethereum) || document.querySelectorAll('#snWalletDialog').length > 0), 600)); if (!has) walletApps(); }
    renderFlow(W.state());
  }
  function steps(active, done) { for (const li of $('eSteps').querySelectorAll('li')) { const s = li.dataset.step; if (s === active) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); li.dataset.done = String((done || []).includes(s)); } }
  function renderFlow(s) {
    const i = S.intent;
    $('eConnect').hidden = s.connected; $('eSign').hidden = !s.connected || Boolean(i); $('eSend').hidden = !(s.connected && i && i.status === 'OPEN'); $('eOpenReceipt').hidden = !(i && i.status !== 'OPEN');
    if (i) { $('eOpenReceipt').href = '/labs/early/receipt?intent=' + i.intentId; $('eAsset').disabled = true; $('eAmount').disabled = true; $('eAmount').value = E.formatUnits(i.typedData.message.amount, (S.cfg.assets.find((x) => x.token === i.typedData.message.token) || { decimals: 18 }).decimals); $('eAsset').value = i.typedData.message.token; }
    if (!s.connected) steps('connect', []);
    else if (!i) steps('sign', ['connect']);
    else if (i.status === 'OPEN') { steps('send', ['connect', 'sign']); if (i.observed) flow('A transfer was seen. Open the receipt to follow its confirmation.'); else flow('Your intent is stored. Now send the exact amount from your wallet to the creator’s verified wallet.'); }
    else steps('done', ['connect', 'sign', 'send']);
    if (i && s.connected && lc(s.account) !== lc(i.typedData.message.sender)) flow('This intent was signed by ' + short(i.typedData.message.sender) + '. Switch to that wallet to send, or open the receipt.', 'warn');
  }
  function walletApps() {
    const url = location.href;
    const host = location.host + location.pathname + location.search;
    const apps = [
      ['MetaMask', 'https://metamask.app.link/dapp/' + host],
      ['Coinbase Wallet', 'https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent(url)],
      ['Trust Wallet', 'https://link.trustwallet.com/open_url?coin_id=60&url=' + encodeURIComponent(url)],
    ];
    $('eWalletAppLinks').innerHTML = apps.map(([n, u]) => `<a class="sn-btn" rel="noreferrer" href="${esc(u)}">Open in ${esc(n)}</a>`).join('');
    $('eWalletApps').hidden = false;
  }
  async function signIntent() {
    if (S.busy) return;
    const c = S.creator, m = c.currentManifest, token = $('eAsset').value;
    const asset = S.cfg.assets.find((x) => x.token === token);
    const raw = asset ? E.parseUnits($('eAmount').value, asset.decimals) : null;
    if (!raw) { flow('Enter an amount with at most ' + (asset ? asset.decimals : 18) + ' decimals.', 'warn'); return; }
    S.busy = true; $('eSign').disabled = true;
    try {
      const sender = W.state().account;
      flow('Preparing what you mean…');
      const d = await post({ action: 'intent-draft', manifestHash: m.manifestHash, sender, token, amount: raw });
      if (!d.ok) throw new Error(errText(d, 'Could not prepare the intent.'));
      const td = d.body.typedData;
      if (lc(td.message.receiver) !== lc(m.receivingWallet) || lc(td.message.token) !== lc(token) || td.message.amount !== raw || td.domain.chainId !== 4663) throw new Error('The prepared intent does not match this page. Nothing was signed.');
      flow('Sign what you mean in your wallet. This is a free signature, not a payment.');
      const signature = await W.signTyped(td);
      let stored = null;
      for (let n = 0; n < 4 && !stored; n++) { const r = await post({ action: 'intent-store', intentId: d.body.intentId, signature }); if (r.ok) stored = r.body.intent; else if (r.status !== 503 && r.status !== 429) throw new Error(errText(r, 'The intent could not be stored.')); else await new Promise((res) => setTimeout(res, 1500 * (n + 1))); }
      if (!stored) throw new Error('SyncNet could not store your signed intent right now. Nothing was sent. Try again.');
      S.intent = stored;
      store.set(KEY(c.creatorId), { intentId: stored.intentId, at: Date.now() });
      renderFlow(W.state());
    } catch (e) { flow(rejected(e) ? 'You did not sign. Nothing was stored or sent.' : (e.message || 'Something went wrong.'), 'bad'); }
    finally { S.busy = false; $('eSign').disabled = false; }
  }
  async function sendTransfer() {
    if (S.busy || !S.intent) return;
    const i = S.intent, msg = i.typedData.message;
    if (lc(W.state().account) !== lc(msg.sender)) { flow('Switch to the wallet that signed this intent.', 'warn'); return; }
    if (nowSec() > Number(msg.expiry) - 120) { flow('This intent is about to expire. Sign a new one.', 'warn'); return; }
    // the calldata is rebuilt locally from the SIGNED intent and must equal what the server returned
    const data = E.transferCalldata(msg.receiver, msg.amount);
    if (data !== i.tx.data || lc(i.tx.to) !== lc(msg.token) || i.tx.value !== '0x0') { flow('The transfer does not match the signed intent. Nothing was sent.', 'bad'); return; }
    S.busy = true; $('eSend').disabled = true;
    try {
      flow('Review the transfer in your wallet: exact amount, to the creator’s verified wallet.');
      const pend = store.get(KEY(S.creator.creatorId)) || {};
      store.set(KEY(S.creator.creatorId), { ...pend, intentId: i.intentId, sending: true, at: Date.now() });
      let txHash;
      try { txHash = await W.sendTransaction({ to: msg.token, data, value: '0x0' }); }
      catch (e) { store.set(KEY(S.creator.creatorId), { ...pend, intentId: i.intentId }); throw new Error(rejected(e) ? 'You rejected the transaction. Nothing was sent.' : 'The wallet could not send the transaction: ' + String((e && e.message) || e).slice(0, 140)); }
      store.set(KEY(S.creator.creatorId), { intentId: i.intentId, txHash: lc(txHash), at: Date.now() });
      location.href = '/labs/early/receipt?intent=' + i.intentId + '&tx=' + lc(txHash);
    } catch (e) { flow(e.message, 'bad'); $('eSend').disabled = false; }
    finally { S.busy = false; }
  }

  // ---------------------------------------------------------------- receipt (private; resumes from the server)
  async function receiptPage(intentId) {
    show('eReceipt');
    if (!/^0x[0-9a-f]{64}$/.test(intentId)) { $('eRTitle').textContent = 'No intent'; status('Open a receipt from the creator page or My EARLY.', 'warn', 'eRStatus'); return; }
    const hint = lc(new URLSearchParams(location.search).get('tx') || '');
    $('eRVerify').addEventListener('click', () => verifyLoop(intentId, '', 1));
    $('eRTxBtn').addEventListener('click', () => { const h = lc($('eRTx').value.trim()); if (/^0x[0-9a-f]{64}$/.test(h)) verifyLoop(intentId, h, 1); else status('Paste a full transaction hash.', 'warn', 'eRStatus'); });
    $('eRCardBtn').addEventListener('click', () => makeCard(intentId));
    $('eRCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('eRShareUrl').value); $('eRCopy').textContent = 'Copied'; const sid = $('eRShareUrl').dataset.shareId; if (sid) post({ action: 'card-event', shareId: sid, event: 'link_copied' }).catch(() => {}); } catch { /* clipboard */ } });
    $('eRDownload').addEventListener('click', downloadReceipt);
    await verifyLoop(intentId, hint, 90);
  }
  async function renderReceipt(intentId) {
    const r = await api({ view: 'receipt', intent: intentId });
    if (!r.ok) return null;
    const d = r.body.receipt;
    $('eRTitle').textContent = d.status === 'FINALIZED' ? 'Verified and final' : d.status === 'CONFIRMED' ? 'Verified · finalizing' : d.status.replace(/_/g, ' ').toLowerCase();
    $('eRCard').hidden = false;
    $('eRName').textContent = (d.context.creatorTitleThen || 'Creator').toUpperCase();
    $('eRDate').textContent = 'Supported ' + fmtDate(d.context.earlyDate);
    $('eRAudience').textContent = audienceText(d.context.audienceThen);
    if (d.context.audienceThen && d.context.audienceThen.kind === 'followers') $('eRShare').querySelector('.sn-small').textContent = 'The card shows the creator, the date and the followers on X then. Your wallet, the amount and the transaction stay hidden.';
    $('eRVerified').textContent = d.status === 'FINALIZED' ? 'SYNC Proof verified' : 'SYNC Proof · finalizing';
    $('eRDownload').hidden = false; $('eRDetails').hidden = false;
    $('eRJson').textContent = JSON.stringify({ receiptId: d.receiptId, mode: d.mode, status: d.status, chain: d.fact, earlyDate: d.context.earlyDate, audienceThen: d.context.audienceThen, attestations: d.attestations.map((a) => ({ type: a.type, keyId: a.keyId, bundleDate: a.bundleDate, anchored: Boolean(a.inclusion) })), ordering: d.ordering.note }, null, 2);
    S.receipt = d;
    if (d.status === 'FINALIZED') $('eRCardBtn').hidden = false;
    return d;
  }
  async function verifyLoop(intentId, hint, maxRounds) {
    const my = ++S.polling;
    for (let n = 0; n < maxRounds && my === S.polling; n++) {
      const r = await post({ action: 'verify', intentId, ...(hint ? { txHash: hint } : {}) }).catch(() => ({ ok: false, status: 0, body: {} }));
      const b = r.body || {};
      if (r.ok && b.ok) { status(b.status === 'FINALIZED' ? 'Your support is verified and final.' : 'Your support is verified. Finality follows in about 15–20 minutes; your EARLY card unlocks then.', 'ok', 'eRStatus'); await renderReceipt(intentId); if (b.status !== 'FINALIZED') setTimeout(() => reconcileLoop(intentId), 60000); return; }
      if (r.ok && (b.status === 'AMBIGUOUS' || b.status === 'RECOVERY_AVAILABLE')) { chooseCandidate(intentId, b); return; }
      if (r.ok && (b.status === 'EXPIRED' || b.status === 'CLOSED')) { $('eRTitle').textContent = b.status === 'CLOSED' ? 'No matching transfer' : 'Expired'; status(b.message || '', 'warn', 'eRStatus'); $('eRRecover').hidden = b.status === 'CLOSED'; return; }
      if (r.status === 202) { $('eRTitle').textContent = b.status === 'PENDING_CONFIRMATION' ? 'Transfer seen · confirming' : 'Waiting for your transfer'; status(b.message || 'Checking Robinhood Chain…', undefined, 'eRStatus'); $('eRRecover').hidden = b.status === 'PENDING_CONFIRMATION'; }
      else if (r.status === 503 || r.status === 0 || r.status === 429) status('Robinhood Chain or SyncNet is not answering right now. Retrying…', 'warn', 'eRStatus');
      else { status(errText(r, 'The transfer could not be verified.'), 'bad', 'eRStatus'); return; }
      if (n < maxRounds - 1) await new Promise((res) => setTimeout(res, n < 5 ? 2500 : 10000));
    }
  }
  async function reconcileLoop(intentId) {
    for (let n = 0; n < 30; n++) { const r = await post({ action: 'reconcile', intentId }).catch(() => null); if (r && r.ok && r.body.status === 'FINALIZED') { status('Your support is verified and final.', 'ok', 'eRStatus'); await renderReceipt(intentId); return; } if (r && r.ok && r.body.status === 'INVALIDATED_BY_REORG') { status('Robinhood Chain reorganised the block with your transfer. Checking again…', 'warn', 'eRStatus'); return verifyLoop(intentId, '', 30); } await new Promise((res) => setTimeout(res, 60000)); }
  }
  function chooseCandidate(intentId, b) {
    $('eRTitle').textContent = b.status === 'AMBIGUOUS' ? 'Choose the transfer you meant' : 'Late transfer · recover it';
    status(b.message || '', 'warn', 'eRStatus');
    $('eRChoose').hidden = false;
    $('eRCandidates').innerHTML = b.candidates.map((c) => `<p class="early-row"><span class="sn-mono sn-small">${esc(short(c.txHash))} · block ${esc(c.blockNumber)}</span><button class="sn-btn" type="button" data-tx="${esc(c.txHash)}" data-log="${esc(String(c.logIndex))}">This one</button></p>`).join('');
    $('eRCandidates').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        if (!W.state().connected) await W.connect();
        const m = { schema: E.SCHEMA.finalize, intentId, txHash: btn.dataset.tx, logIndex: Number(btn.dataset.log), issuedAt: nowSec(), nonce: nonce() };
        status('Sign once to finalise this transfer…', undefined, 'eRStatus');
        const signature = await W.signTyped(E.typedData('SupportFinalize', m));
        const r = await post({ action: 'finalize', intentId, txHash: m.txHash, logIndex: m.logIndex, issuedAt: m.issuedAt, nonce: m.nonce, signature });
        if (!r.ok && r.status !== 202) throw new Error(errText(r, 'Could not finalise.'));
        $('eRChoose').hidden = true;
        await verifyLoop(intentId, m.txHash, 30);
      } catch (e) { status(rejected(e) ? 'You did not sign. Nothing changed.' : e.message, 'bad', 'eRStatus'); }
    }));
  }
  function downloadReceipt() {
    if (!S.receipt) return;
    const blob = new Blob([JSON.stringify({ receipt: S.receipt }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sync-proof-receipt-' + S.receipt.receiptId.slice(2, 14) + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function ensureSession() {
    if (session.get()) { const t = await api({ view: 'mine' }); if (t.ok) return true; session.set(''); }
    if (!W.state().connected) await W.connect();
    const wallet = W.state().account;
    const m = { schema: E.SCHEMA.session, wallet, issuedAt: nowSec(), nonce: nonce() };
    const signature = await W.signTyped(E.typedData('EarlySession', m));
    const r = await post({ action: 'session', wallet, issuedAt: m.issuedAt, nonce: m.nonce, signature });
    if (!r.ok) throw new Error(errText(r, 'Could not sign in.'));
    session.set(r.body.session);
    return true;
  }
  async function makeCard(intentId) {
    try {
      status('Signing in with your wallet (free signature)…', undefined, 'eRStatus');
      await ensureSession();
      const r = await post({ action: 'card-create', receiptId: S.receipt.receiptId });
      if (!r.ok) throw new Error(errText(r, 'Could not make the card.'));
      $('eRShare').hidden = false; $('eRShareUrl').value = location.origin + r.body.url; $('eRShareUrl').dataset.shareId = r.body.shareId;
      status('Your EARLY card is ready. Nothing about you is on it unless you decide otherwise later.', 'ok', 'eRStatus');
    } catch (e) { status(rejected(e) ? 'You did not sign. No card was made.' : e.message, 'bad', 'eRStatus'); }
  }

  // ---------------------------------------------------------------- mine (fan session)
  function minePage() {
    show('eMine');
    $('eMineSignIn').addEventListener('click', loadMine);
    if (session.get()) loadMine();
  }
  async function loadMine() {
    try {
      await ensureSession();
      const r = await api({ view: 'mine' });
      if (!r.ok) throw new Error(errText(r));
      const b = r.body;
      $('eMineLists').hidden = false; $('eMineSignIn').hidden = true;
      $('eMineReceipts').innerHTML = b.receipts.length ? b.receipts.map((x) => `<li class="you-row"><span class="sn-m-main"><strong>${esc(x.creatorTitleThen || 'Creator')}</strong><span class="sn-small sn-muted">Supported ${esc(fmtDate(x.earlyDate))} · ${esc(x.status.toLowerCase())}</span></span><span class="you-action"><a href="/labs/early/receipt?intent=${esc(x.intentId)}">Receipt →</a></span></li>`).join('') : '<li class="sn-empty">No receipts yet.</li>';
      // a signal for an X account is listed as "X account <id>" (we hold no profile data for an account that has not joined) and links to the canonical x/<id> page
      $('eMineSignals').innerHTML = b.signals.length ? b.signals.map((x) => { const isX = x.platform === 'x'; return `<li class="you-row"><span class="sn-m-main"><strong>${esc(isX ? 'X account ' + x.externalId : x.channelId)}</strong><span class="sn-small sn-muted">${esc(x.status.toLowerCase())}${x.creatorOnEarly ? ' · now on EARLY' : ''}</span></span><span class="you-action">${x.creatorOnEarly ? `<a href="/labs/early/c/${isX ? 'x/' + esc(x.externalId) : esc(x.channelId)}">Support →</a>` : ''}</span></li>`; }).join('') : '<li class="sn-empty">No signals.</li>';
      $('eMineIntents').innerHTML = b.intents.filter((x) => x.status !== 'CONSUMED').length ? b.intents.filter((x) => x.status !== 'CONSUMED').map((x) => `<li class="you-row"><span class="sn-m-main"><strong>${esc(x.status)}</strong><span class="sn-small sn-muted">${esc(short(x.intentId))}</span></span><span class="you-action"><a href="/labs/early/receipt?intent=${esc(x.intentId)}">Open →</a></span></li>`).join('') : '<li class="sn-empty">No open intents.</li>';
    } catch (e) { status(rejected(e) ? 'You did not sign.' : e.message, 'bad'); }
  }

  // ---------------------------------------------------------------- public card
  async function cardPage(shareId) {
    show('eCard');
    const r = await api({ view: 'card', shareId });
    if (!r.ok) { $('eCName').textContent = 'Card not found'; return; }
    const c = r.body.card, v = r.body.verification;
    $('eCName').textContent = (c.creator || 'Creator').toUpperCase();
    $('eCDate').textContent = 'Supported ' + fmtDate(c.supportedOn);
    $('eCAudience').textContent = audienceText(c.audienceThen);
    $('eCWhat').textContent = v.what;
    $('eCList').innerHTML = v.independentlyVerifiable.map((x) => `<li>${esc(x)}</li>`).join('');
    $('eCNot').textContent = v.notShown.length ? 'Not shown: ' + v.notShown.join('; ') + '.' : '';
    // the snapshot explanation applies only when a snapshot exists (approximate or hidden), never when it is unavailable
    $('eCAudNote').hidden = !(c.audienceThen && (c.audienceThen.state === 'approximate' || c.audienceThen.state === 'hidden'));
    if (c.audienceThen && c.audienceThen.kind === 'followers') $('eCAudNote').textContent = 'Follower count is an approximate, dated snapshot from X recorded by SyncNet. It never changes afterwards.';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
