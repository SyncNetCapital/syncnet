/*
 * Project Home editor (/home-editor.html?token=0x…[&review=1][&step=pay]) — progressive: Edit → Activate → Publish.
 *
 * EDIT     the V1 schema only (lib/syncnet-site.js): preset, accent, headline, about, logo, hero, one CTA, socials,
 *          section visibility. No HTML, CSS, Markdown, embeds or scripts. The draft lives in this browser only.
 * PREVIEW  Site.render({mode:'preview'}) — the SAME pure renderer the server uses — written into a sandboxed
 *          <iframe sandbox="allow-same-origin" srcdoc>: scripts, forms, popups and top navigation stay blocked (no
 *          allow-scripts); same-origin only so /site-img's Cross-Origin-Resource-Policy lets sanitised images load.
 *          Watermark "PREVIEW · NOT PUBLISHED", no clickable links, nothing stored or served by SyncNet, no public URL.
 *          The page CSP is unchanged and applies to the srcdoc document too (see docs/PROJECT_HOME.md).
 * ACTIVATE one-time $39 activation paid in $SYNC at the SYNCNET REFERENCE RATE: a signed ActivationRequest returns a
 *          locked exact amount (30 minutes); ONE ERC-20 transfer to the sink; the server verifies it from the chain.
 *          QUOTE READY → PAYMENT SEEN (confirming) → ACTIVATED → FINALIZED (later). The user may leave and return:
 *          recovery uses the server's own request state (status view) plus the tx hash remembered in this browser.
 * PUBLISH  a fresh SitePublish signature by the CURRENT Passport operator (free). REVIEW & ADOPT re-signs the exact
 *          configHash a previous operator published (free, no payment).
 * Authority, entitlement, amounts and facts are always decided by the server; this page only asks and shows.
 */
(function () {
  'use strict';
  const UI = window.SyncNetUI, W = window.SyncNetWallet, Site = window.SyncNetSite, Chain = window.SyncNetChain, Origins = window.SyncNetOrigins;
  const $ = (id) => document.getElementById(id);
  const esc = UI.esc, short = UI.short;
  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const SYNC = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
  const CHAIN_ID = 4663;
  const MIN_PAY_SECONDS = 90; // never start a payment this close to the end of the rate lock
  const UPLOAD_SESSION_KEY = 'syncnet_upload_session'; // shared with the Builder
  const params = new URLSearchParams(location.search);
  const token = lc(params.get('token'));
  const rpc = Chain.makeRpc(Chain.ROBINHOOD.rpcUrl, { timeoutMs: 10000, retries: 1 });
  const S = { account: '', facts: null, passport: null, cfg: null, st: null, config: null, lastValid: null, published: null, uploads: null, busy: false, polling: 0, finalTimer: 0, countdown: 0, booted: '' };

  // ------------------------------------------------------------------ small helpers
  const nonce = () => { const a = new Uint8Array(32); crypto.getRandomValues(a); return '0x' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
  const nowSec = () => Math.floor(Date.now() / 1000);
  const status = (m, tone, el) => { const x = el || $('heStatus'); x.textContent = m || ''; if (tone) x.dataset.tone = tone; else delete x.dataset.tone; };
  const payStatus = (m, tone) => status(m, tone, $('hePayStatus'));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage may be blocked */ } },
  };
  const DRAFT = 'syncnet_home_draft_' + token, PAY = 'syncnet_home_pay_' + token;
  async function api(params2) { const r = await fetch('/api/project-home?' + new URLSearchParams(params2), { cache: 'no-store' }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || 'Project Home is unavailable right now.'), { status: r.status, body: j }); return j; }
  async function post(body) {
    const r = await fetch('/api/project-home', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: j };
  }
  const errText = (res, fallback) => (res && res.body && res.body.error) || fallback || 'The request was refused.';
  async function sign(kind, message) {
    try { return await W.signTyped(Site.typedData(kind, message)); }
    catch (e) { throw new Error(e && (e.code === 4001 || /reject|denied/i.test(String(e.message))) ? 'You rejected the signature. Nothing changed.' : 'The wallet could not sign: ' + String((e && e.message) || e).slice(0, 140)); }
  }
  function steps(active) {
    const order = ['edit', 'activate', 'publish'];
    document.querySelectorAll('#heSteps li').forEach((li) => {
      const i = order.indexOf(li.dataset.step), a = order.indexOf(active);
      if (i === a) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      li.dataset.done = String(i < a);
    });
  }
  function paySteps(done) { // done: 'quote' | 'seen' | 'active' | 'final'
    const order = ['quote', 'seen', 'active', 'final'], k = order.indexOf(done);
    document.querySelectorAll('#hePaySteps li').forEach((li) => {
      const i = order.indexOf(li.dataset.p);
      if (i === k) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      li.dataset.done = String(i <= k);
    });
  }
  const entOk = () => Boolean(S.st && S.st.entitlement && (S.st.entitlement.status === 'ACTIVE' || S.st.entitlement.status === 'FINALIZED'));

  // ------------------------------------------------------------------ facts for the preview (the server re-reads its own at publish time)
  async function loadFacts() {
    const [meta, project] = await Promise.all([Chain.readTokenMetadata(rpc, token).catch(() => null), Origins.resolveProject(rpc, token).catch(() => null)]);
    let markets = [];
    if (project && project.origin === 'PAR') {
      try { const launch = await Chain.readLaunch(rpc, token); markets = (await Chain.readMarkets(rpc, token, launch)).slice(0, 5).map((m) => ({ pairToken: lc(m.pairToken), symbol: '' })); } catch { markets = []; }
    } else if (project && project.origin === 'PONS_V2' && project.pair) markets = [{ pairToken: lc(project.pair.address), symbol: project.pair.native ? 'ETH' : '' }];
    return {
      token, name: (meta && meta.name) || '', symbol: (meta && meta.symbol) || '',
      origin: project && project.supported !== false ? { launchpad: project.origin, label: project.label, factory: project.factory } : null,
      deployer: project ? lc(project.deployer) : '', markets, onchainWebsite: meta && meta.socials ? String(meta.socials.website || '') : '', passport: null,
    };
  }

  // ------------------------------------------------------------------ form <-> config
  function defaults() { return { schema: Site.SCHEMA, token, preset: 'CLEAN', accent: 'BLUE', headline: '', about: '', logoCid: '', heroCid: '', socials: { x: '', telegram: '', discord: '', farcaster: '' }, cta: null, sections: { hero: true, about: true, tokenFacts: true, origin: true, socials: true, passport: true } }; }
  function fill(c) {
    const f = $('heForm');
    f.querySelectorAll('input[name="preset"]').forEach((r) => { r.checked = r.value === c.preset; });
    $('heAccent').value = c.accent; $('heHeadline').value = c.headline; $('heAbout').value = c.about;
    $('heCtaLabel').value = c.cta ? c.cta.label : ''; $('heCtaUrl').value = c.cta ? c.cta.url : '';
    f.querySelectorAll('[data-social]').forEach((i) => { i.value = (c.socials && c.socials[i.dataset.social]) || ''; });
    f.querySelectorAll('[data-section]').forEach((i) => { i.checked = !c.sections || c.sections[i.dataset.section] !== false; });
    S.images = { logoCid: c.logoCid || '', heroCid: c.heroCid || '' };
    imageNames();
  }
  function raw() {
    const f = $('heForm');
    const socials = {}; f.querySelectorAll('[data-social]').forEach((i) => { socials[i.dataset.social] = i.value.trim(); });
    const sections = {}; f.querySelectorAll('[data-section]').forEach((i) => { sections[i.dataset.section] = i.checked; });
    const label = $('heCtaLabel').value, url = $('heCtaUrl').value.trim();
    return {
      schema: Site.SCHEMA, token, preset: (f.querySelector('input[name="preset"]:checked') || {}).value || 'CLEAN', accent: $('heAccent').value,
      headline: $('heHeadline').value, about: $('heAbout').value, logoCid: S.images.logoCid, heroCid: S.images.heroCid,
      socials, cta: label || url ? { label, url } : null, sections,
    };
  }
  const FIELD = { headline: 'Headline', about: 'About', 'cta.label': 'Button', 'cta.url': 'Button link', cta: 'Button', 'socials.x': 'X handle', 'socials.telegram': 'Telegram', 'socials.discord': 'Discord invite code', 'socials.farcaster': 'Farcaster', logoCid: 'Logo', heroCid: 'Hero image' };
  const CODE = { too_long: 'is too long', invalid_handle: 'is not a valid handle', invalid: 'needs a choice', https_only: 'must start with https://', reserved_claim: 'uses a claim SyncNet never grants (such as “official website”)', unsafe_chars: 'contains characters that are not allowed', invalid_url: 'is not a valid web address', invalid_cid: 'is not a sanitised image' };
  function onChange() {
    const n = Site.normalize(raw());
    const list = $('heErrors');
    if (n.ok) { S.config = n.config; S.lastValid = n.config; list.innerHTML = ''; store.set(DRAFT, n.config); }
    else { S.config = null; list.innerHTML = n.errors.slice(0, 6).map((e) => `<li>${esc(FIELD[e.field] || e.field)} ${esc(CODE[e.code] || 'is not valid')}.</li>`).join(''); }
    $('heHeadlineCount').textContent = `${Array.from($('heHeadline').value).length} / ${Site.LIMITS.headline}`;
    $('heAboutCount').textContent = `${Array.from($('heAbout').value).length} / ${Site.LIMITS.about} · plain text · a blank line starts a new paragraph`;
    preview(S.lastValid);
    refreshBar();
  }
  function preview(config) {
    const facts = { ...S.facts, passport: S.passport ? { operator: S.passport.operator, operatorSince: S.passport.operatorSince } : null };
    $('hePreview').srcdoc = Site.render({ config, facts, authority: { signer: S.account }, mode: 'preview' });
  }

  // ------------------------------------------------------------------ images: the existing sanitizer/upload path only
  function imageNames() {
    $('heLogoName').textContent = S.images.logoCid ? 'Sanitised · ' + S.images.logoCid.slice(0, 10) + '…' : 'None';
    $('heHeroName').textContent = S.images.heroCid ? 'Sanitised · ' + S.images.heroCid.slice(0, 10) + '…' : 'None';
    document.querySelectorAll('[data-clear]').forEach((b) => { b.hidden = !S.images[b.dataset.clear]; });
  }
  function uploadSession() { try { const t = sessionStorage.getItem(UPLOAD_SESSION_KEY) || ''; const p = t.split('.'); const exp = Number(p[0] === 'v2' ? p[3] : p[1] || 0); if (t && exp * 1000 > Date.now() + 60000) return t; sessionStorage.removeItem(UPLOAD_SESSION_KEY); } catch { /* ignore */ } return ''; }
  async function uploadsOpen() {
    if (uploadSession()) return true;
    try { const r = await fetch('/api/ipfs-upload', { cache: 'no-store' }); const j = await r.json().catch(() => ({})); return Boolean(r.ok && j.public === true); } catch { return false; }
  }
  async function walletSession() {
    const c = await fetch('/api/upload-auth?address=' + encodeURIComponent(S.account), { cache: 'no-store' }); const cj = await c.json().catch(() => ({}));
    if (!c.ok || !cj.message) throw new Error(cj.error || 'Image upload sign-in is not available right now.');
    let signature;
    try { signature = await W.personalSign(cj.message); } catch (e) { throw new Error(e && e.code === 4001 ? 'You rejected the upload sign-in. Nothing was uploaded.' : 'The wallet could not sign the upload sign-in.'); }
    const r = await fetch('/api/upload-auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: S.account, message: cj.message, signature }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.session) throw new Error(j.error || 'Upload sign-in failed.');
    try { sessionStorage.setItem(UPLOAD_SESSION_KEY, j.session); } catch { /* ignore */ }
    return j.session;
  }
  async function normalizeImage(f, kind) {
    if (f.type === 'image/gif') return { blob: f, type: 'image/gif', name: f.name };
    const bmp = await createImageBitmap(f);
    let w, h, cw, ch;
    if (kind === 'logo') { const out = Math.min(512, Math.max(bmp.width, bmp.height)); const k = Math.min(out / bmp.width, out / bmp.height); w = Math.round(bmp.width * k); h = Math.round(bmp.height * k); cw = ch = out; }
    else { const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height)); w = cw = Math.round(bmp.width * k); h = ch = Math.round(bmp.height * k); }
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(bmp, Math.round((cw - w) / 2), Math.round((ch - h) / 2), w, h);
    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not process the image.'))), 'image/png'));
    return { blob, type: 'image/png', name: String(f.name || kind).replace(/\.[^.]+$/, '') + '.png' };
  }
  const b64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onerror = () => reject(new Error('Could not read the image.')); r.onload = () => resolve(String(r.result || '').split(',')[1] || ''); r.readAsDataURL(blob); });
  async function upload(kind, file) {
    const field = kind === 'logo' ? 'logoCid' : 'heroCid';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { status('Use a PNG, JPG, GIF or WebP image.', 'bad'); return; }
    if (file.size > 3 * 1024 * 1024) { status('That image is over 3 MB.', 'bad'); return; }
    try {
      status('Preparing the image…');
      const img = await normalizeImage(file, kind);
      let session = uploadSession();
      if (!session) { status('Sign the upload sign-in in your wallet (free, no transaction)…'); session = await walletSession(); }
      status('Uploading through the SyncNet image sanitizer…');
      const r = await fetch('/api/ipfs-upload', { method: 'POST', headers: { 'content-type': 'application/json', 'x-syncnet-upload-session': session }, body: JSON.stringify({ name: img.name, type: img.type, size: img.blob.size, data: await b64(img.blob) }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 403) { try { sessionStorage.removeItem(UPLOAD_SESSION_KEY); } catch { /* ignore */ } throw new Error(j.error || 'Image uploads are not open on this deployment.'); }
      if (!r.ok) throw new Error(j.error || 'The upload did not complete. Retrying is safe.');
      if (typeof j.cid !== 'string' || !Site.CID.test(j.cid)) throw new Error('The upload did not return a sanitised image.');
      S.images[field] = j.cid;
      imageNames();
      status(`Image sanitised and uploaded (${esc(j.type || img.type)} ${j.width || ''}×${j.height || ''}).`, 'ok');
      onChange();
    } catch (e) { status(e.message || 'Upload failed.', 'bad'); }
  }

  // ------------------------------------------------------------------ primary action bar (at most one primary action)
  function refreshBar() {
    const bar = $('heBar'), btn = $('hePrimary'), note = $('heBarNote'), un = $('heUnpublish');
    bar.hidden = false;
    const site = S.st && S.st.site;
    const mine = site && site.state === 'PUBLISHED' && lc(site.signer) === S.account;
    un.hidden = !(site && site.state === 'PUBLISHED');
    btn.disabled = false; btn.hidden = false; note.textContent = '';
    const ent = S.st && S.st.entitlement;
    if (ent && ent.status === 'INVALIDATED_BY_REORG') { btn.textContent = 'Check payment again'; btn.dataset.act = 'reverify'; note.textContent = 'The activation payment left the canonical chain. Publishing is paused until it is confirmed again.'; steps('activate'); return; }
    if (entOk()) {
      steps('publish');
      btn.dataset.act = 'publish';
      btn.textContent = mine ? 'PUBLISH CHANGES' : 'PUBLISH';
      if (!S.config) { btn.disabled = true; note.textContent = 'Fix the highlighted fields to publish.'; }
      else if (mine && site.configHash === Site.configHash(S.config)) { btn.disabled = true; note.textContent = 'Published. No changes to publish.'; }
      else note.textContent = 'Publishing is a free signature. The home is signed by your wallet.';
      return;
    }
    steps(($('hePay').hidden) ? 'edit' : 'activate');
    btn.dataset.act = 'activate';
    btn.textContent = 'Continue to activation';
    if (!S.cfg.payments) { btn.disabled = true; note.textContent = 'Activation is not open yet. Your draft is saved in this browser and the preview is free.'; }
    else if (!$('hePay').hidden) btn.hidden = true; // the payment panel below carries the next action
  }
  async function onPrimary() {
    const act = $('hePrimary').dataset.act;
    if (act === 'activate') { $('hePay').hidden = false; refreshBar(); renderQuoteArea(); $('hePay').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); $('hePayTitle').focus && $('hePayTitle').setAttribute('tabindex', '-1'); $('hePayTitle').focus(); }
    else if (act === 'publish') await publish();
    else if (act === 'reverify') { const e = S.st.entitlement; $('hePay').hidden = false; await verifyLoop(e.requestId, e.txHash); }
  }

  // ------------------------------------------------------------------ publish / unpublish / adopt (fresh signatures, no payment)
  async function publish(configHash) {
    if (S.busy) return;
    S.busy = true; $('hePrimary').disabled = true;
    try {
      const adopting = Boolean(configHash);
      const hash = adopting ? configHash : Site.configHash(S.config);
      const message = { token, operator: S.account, configHash: hash, issuedAt: nowSec(), nonce: nonce() };
      status('Sign in your wallet to publish. This is a free signature, not a transaction.');
      const signature = await sign('SitePublish', message);
      status('Publishing…');
      const body = { action: 'publish', token, operator: S.account, issuedAt: message.issuedAt, nonce: message.nonce, signature };
      if (adopting) body.configHash = hash; else body.config = S.config;
      const r = await post(body);
      if (!r.ok) throw new Error(errText(r, 'Publishing failed.'));
      await refreshStatus();
      status(adopting ? 'Adopted. Your home is live and its links work again.' : 'Published. Your home is live.', 'ok');
      $('heStatus').insertAdjacentHTML('beforeend', ` <a href="/site/${esc(token)}" target="_blank" rel="noopener">Open home ↗</a>`);
      if (adopting) { $('heReview').hidden = true; $('heGrid').classList.remove('is-review'); document.querySelector('.he-controls').hidden = false; fill(S.reviewConfig); showEditor(); }
    } catch (e) { status(e.message, 'bad'); }
    finally { S.busy = false; refreshBar(); }
  }
  async function unpublish() {
    if (S.busy) return;
    if (!confirm('Unpublish this Project Home? The public page stops showing it. Your last version is kept and can be published again for free.')) return;
    S.busy = true;
    try {
      const message = { token, operator: S.account, issuedAt: nowSec(), nonce: nonce() };
      const signature = await sign('SiteUnpublish', message);
      const r = await post({ action: 'unpublish', token, operator: S.account, issuedAt: message.issuedAt, nonce: message.nonce, signature });
      if (!r.ok) throw new Error(errText(r, 'Unpublishing failed.'));
      await refreshStatus();
      status('Unpublished. Your last version is kept.', 'ok');
    } catch (e) { status(e.message, 'bad'); }
    finally { S.busy = false; refreshBar(); }
  }

  // ------------------------------------------------------------------ activation payment
  function fmtLeft(s) { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function renderQuoteArea() {
    const box = $('heQuote');
    const intent = S.st && S.st.openIntent;
    const pend = store.get(PAY);
    clearInterval(S.countdown);
    if (intent && intent.status === 'OPEN' && Date.parse(intent.expiresAt) > Date.now() && !(pend && pend.requestId === intent.requestId && pend.txHash)) { renderQuote(intent); return; }
    if (S.polling) return;
    paySteps('');
    box.innerHTML = `<p class="sn-small sn-dim">Get a quote to lock the exact $SYNC amount for 30 minutes. Asking for a quote is a free signature.</p>
<p style="margin:14px 0 0"><button class="sn-btn primary" type="button" id="heQuoteBtn">Get quote</button></p>
<p class="sn-small sn-muted">SYNCNET REFERENCE RATE${S.cfg.rate ? ` · 1 $SYNC ≈ $${esc(S.cfg.rate.syncUsdReferenceRate)} (version ${esc(S.cfg.rate.rateVersion)})` : ''}. A SyncNet-reviewed rate, not an on-chain price.</p>`;
    $('heQuoteBtn').addEventListener('click', getQuote);
  }
  async function getQuote() {
    if (S.busy) return;
    S.busy = true;
    try {
      const message = { token, operator: S.account, issuedAt: nowSec(), nonce: nonce() };
      payStatus('Sign in your wallet to request a quote (free, no transaction).');
      const signature = await sign('ActivationRequest', message);
      const r = await post({ action: 'intent', token, operator: S.account, issuedAt: message.issuedAt, nonce: message.nonce, signature });
      if (!r.ok) {
        if (r.body && r.body.code === 'payment_pending') { payStatus(errText(r), 'warn'); await refreshStatus(); resume(); return; }
        throw new Error(errText(r, 'The quote could not be created.'));
      }
      payStatus('');
      S.st.openIntent = r.body.intent;
      renderQuote(r.body.intent);
    } catch (e) { payStatus(e.message, 'bad'); }
    finally { S.busy = false; }
  }
  function renderQuote(i) {
    paySteps('quote');
    const box = $('heQuote');
    box.innerHTML = `<dl class="sn-kv he-quote">
<dt>Amount</dt><dd><span class="sn-amount" id="heAmount">${esc(i.exactTaggedSyncDisplay)} $SYNC</span> <button class="sn-textbtn sn-small" type="button" data-copy-text="${esc(i.exactTaggedSyncDisplay)}">Copy</button></dd>
<dt>To</dt><dd><span class="sn-mono">${esc(i.sink)}</span> <span class="sn-small sn-muted">Project Home sink</span></dd>
<dt>Price</dt><dd>$${esc(i.priceUsd)} · one-time</dd>
<dt>Rate</dt><dd>SYNCNET REFERENCE RATE · Your rate is locked for 30 minutes<br><span class="sn-small sn-muted">1 $SYNC = $${esc(i.syncUsdReferenceRate)} · version ${esc(i.rateVersion)}</span></dd>
<dt>Locked for</dt><dd><span class="sn-mono" id="heLeft">—</span></dd></dl>
<p class="sn-warn-line">Send only the exact quoted amount before the quote expires. Late or duplicate payments cannot be automatically refunded.</p>
<p style="margin:16px 0 0"><button class="sn-btn primary" type="button" id="hePayBtn">PAY WITH $SYNC</button></p>
<p class="sn-small sn-muted">One $SYNC transfer that you review in your wallet. Non-refundable after activation.</p>`;
    $('hePayBtn').addEventListener('click', () => pay(i));
    const tick = () => {
      const left = Math.floor((Date.parse(i.expiresAt) - Date.now()) / 1000);
      const el = $('heLeft'); if (el) el.textContent = fmtLeft(left);
      const b = $('hePayBtn');
      if (b && left < MIN_PAY_SECONDS) { b.disabled = true; clearInterval(S.countdown); payStatus(left <= 0 ? 'This quote expired. Nothing was paid. Get a new quote.' : 'This quote is about to expire. Get a new quote before paying.', 'warn'); if (left <= 0) { S.st.openIntent = null; renderQuoteArea(); } }
    };
    tick(); S.countdown = setInterval(tick, 1000);
  }
  function transferData(to, amountWei) {
    const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
    return '0xa9059cbb' + pad(lc(to)) + pad(BigInt(amountWei).toString(16));
  }
  async function pay(i) {
    if (S.busy) return;
    const pend = store.get(PAY);
    if (pend && pend.requestId === i.requestId && pend.txHash) { resume(); return; } // never a second transfer for one quote
    const left = Math.floor((Date.parse(i.expiresAt) - Date.now()) / 1000);
    if (left < MIN_PAY_SECONDS) { payStatus('This quote is too close to expiry. Get a new quote.', 'warn'); return; }
    if (lc(i.canonicalSync) !== SYNC || Number(i.chainId) !== CHAIN_ID || !S.cfg.sink || lc(i.sink) !== lc(S.cfg.sink) || lc(i.token) !== token) { payStatus('This quote does not match the payment configuration. Nothing was sent.', 'bad'); return; }
    S.busy = true; $('hePayBtn').disabled = true;
    try {
      payStatus('Review the $SYNC transfer in your wallet…');
      let txHash;
      try { txHash = await W.sendTransaction({ to: SYNC, data: transferData(i.sink, i.exactTaggedSyncAmount), value: '0x0' }); }
      catch (e) { throw new Error(e && (e.code === 4001 || /reject|denied/i.test(String(e.message))) ? 'You rejected the transaction. Nothing was sent.' : 'The wallet could not send the transaction: ' + String((e && e.message) || e).slice(0, 140)); }
      store.set(PAY, { requestId: i.requestId, txHash: lc(txHash), at: Date.now() });
      clearInterval(S.countdown);
      await verifyLoop(i.requestId, lc(txHash));
    } catch (e) { payStatus(e.message, 'bad'); const b = $('hePayBtn'); if (b) b.disabled = false; }
    finally { S.busy = false; }
  }
  /** Poll the server's verification until the payment is ACTIVE (or a definite answer). Safe to leave and return. */
  async function verifyLoop(requestId, txHash) {
    const my = ++S.polling;
    $('heQuote').innerHTML = `<dl class="sn-kv"><dt>Transaction</dt><dd><a class="sn-mono" href="https://robinhoodchain.blockscout.com/tx/${esc(txHash)}" target="_blank" rel="noreferrer">${esc(short(txHash))} ↗</a></dd></dl>`;
    for (let n = 0; n < 120 && my === S.polling; n++) {
      const r = await post({ action: 'verify', requestId, txHash }).catch(() => ({ ok: false, status: 0, body: {} }));
      const b = r.body || {};
      if (r.ok && b.ok) {
        store.set(PAY, null);
        await refreshStatus();
        paySteps(b.status === 'FINALIZED' ? 'final' : 'active');
        payStatus(b.status === 'FINALIZED' ? 'Activated and finalized. You can publish now.' : 'Activated. You can publish now. Finality is confirmed later on its own.', 'ok');
        S.polling = 0; refreshBar(); watchFinality();
        return;
      }
      if (r.status === 202) {
        if (b.status === 'PENDING_CONFIRMATION') { paySteps('seen'); payStatus('Payment seen · confirming on Robinhood Chain. You can leave this page and come back.'); }
        else payStatus(b.status === 'NOT_MINED' ? 'Waiting for the transaction to be mined…' : 'The chain is settling. Checking again…');
      } else if (r.status === 503 || r.status === 0 || r.status === 429) payStatus('Robinhood Chain or SyncNet is not answering right now. Retrying…', 'warn');
      else {
        // A definite refusal (wrong amount, mined after expiry, already used, failed tx…). Nothing is retried blindly.
        store.set(PAY, null);
        S.polling = 0;
        payStatus(errText(r, 'The payment could not be verified.'), 'bad');
        await refreshStatus(); renderQuoteArea();
        return;
      }
      await new Promise((res) => setTimeout(res, n < 12 ? 5000 : 15000));
    }
    if (my === S.polling) { S.polling = 0; payStatus('Still confirming. Your payment is remembered: come back later or check again.', 'warn'); $('heQuote').insertAdjacentHTML('beforeend', '<p><button class="sn-btn" type="button" id="heCheckAgain">Check again</button></p>'); $('heCheckAgain').addEventListener('click', () => verifyLoop(requestId, txHash)); }
  }
  /** UI-triggered finality: while this page is open, ask the server to reconcile an ACTIVE payment (permissionless). */
  function watchFinality() {
    clearTimeout(S.finalTimer);
    const e = S.st && S.st.entitlement;
    if (!e || e.kind !== 'paid' || e.status !== 'ACTIVE') return;
    let tries = 0;
    const run = async () => {
      const r = await post({ action: 'reconcile', token }).catch(() => null);
      if (r && r.ok && r.body.status && r.body.status !== S.st.entitlement.status) { await refreshStatus(); refreshBar(); if (S.st.entitlement && S.st.entitlement.status === 'FINALIZED') { paySteps('final'); payStatus('Finalized.', 'ok'); return; } if (S.st.entitlement && S.st.entitlement.status === 'INVALIDATED_BY_REORG') { payStatus('The activation payment left the canonical chain. Publishing is paused until it is confirmed again.', 'bad'); return; } }
      if (++tries < 20) S.finalTimer = setTimeout(run, 60000);
    };
    S.finalTimer = setTimeout(run, 2000);
  }
  /** Recovery: resume from this browser's tx record, or from the server's own observed payment for the open request. */
  function resume() {
    const pend = store.get(PAY);
    const intent = S.st && S.st.openIntent;
    if (entOk()) { store.set(PAY, null); return false; }
    if (pend && pend.txHash) { $('hePay').hidden = false; refreshBar(); verifyLoop(pend.requestId, pend.txHash); return true; }
    if (intent && intent.observed && intent.observed.txHash) { $('hePay').hidden = false; refreshBar(); verifyLoop(intent.requestId, intent.observed.txHash); return true; }
    return false;
  }
  async function recover() {
    const tx = lc($('heTxHash').value.trim());
    if (!/^0x[0-9a-f]{64}$/.test(tx)) { payStatus('Enter a 0x transaction hash (66 characters).', 'bad'); return; }
    const ids = [...new Set([S.st.openIntent && S.st.openIntent.requestId, ...(S.st.intents || [])].filter(Boolean))];
    if (!ids.length) { payStatus('There is no payment request for this project yet.', 'bad'); return; }
    payStatus('Checking…');
    for (const id of ids) {
      const r = await post({ action: 'verify', requestId: id, txHash: tx }).catch(() => null);
      if (!r) continue;
      if (r.ok || r.status === 202) { store.set(PAY, { requestId: id, txHash: tx, at: Date.now() }); await verifyLoop(id, tx); return; }
      if (r.body && r.body.code === 'no_matching_payment') continue;
      payStatus(errText(r), 'bad'); return;
    }
    payStatus('That transaction does not match any payment request for this project.', 'bad');
  }

  // ------------------------------------------------------------------ boot
  async function refreshStatus() { S.st = await api({ view: 'status', token }); S.passport = S.st.passport; return S.st; }
  function gate(html) { const g = $('heGate'); g.innerHTML = html; g.hidden = false; $('heGrid').hidden = true; $('heBar').hidden = true; $('hePay').hidden = true; $('heReview').hidden = true; }
  function showEditor() { $('heGate').hidden = true; $('heGrid').hidden = false; onChange(); }
  async function startingConfig() {
    const saved = store.get(DRAFT);
    if (saved) { const n = Site.normalize(saved); if (n.ok && n.config.token === token) return n.config; }
    const site = S.st.site;
    if (site && site.revisionId && lc(site.signer) === S.account) {
      try { const r = await api({ view: 'revision', id: site.revisionId }); if (r.revision && r.revision.config) return r.revision.config; } catch { /* start fresh */ }
    }
    return defaults();
  }
  async function review() {
    const site = S.st.site;
    const r = await api({ view: 'revision', id: site.revisionId });
    const rev = r.revision;
    $('heReviewNote').innerHTML = `Published by <span class="sn-mono">${esc(short(rev.signer))}</span>, a previous operator, on <span class="sn-mono">${esc(String(rev.publishedAt).slice(0, 10))}</span>. Its links stay disabled until you adopt it.`;
    $('heReview').hidden = false; $('heGrid').hidden = false; $('heGate').hidden = true;
    document.querySelector('.he-controls').hidden = true;
    $('heGrid').classList.add('is-review'); steps('publish');
    S.lastValid = rev.config; S.reviewConfig = rev.config;
    preview(rev.config);
    $('heAdopt').onclick = () => publish(site.configHash);
    $('heEditInstead').onclick = () => { $('heReview').hidden = true; $('heGrid').classList.remove('is-review'); document.querySelector('.he-controls').hidden = false; fill(rev.config); showEditor(); };
  }

  async function boot(account) {
    if (!/^0x[0-9a-f]{40}$/.test(token)) { gate('<p>This link does not name a valid project.</p>'); return; }
    if (S.booted === account) return;
    S.booted = account; S.account = account;
    status('Loading…');
    try {
      S.cfg = await api({ view: 'config' });
      if (!S.cfg.enabled) { status(''); gate('<p>Project Home is not open yet.</p><p class="sn-small sn-muted">Nothing can be activated or published on this deployment right now.</p>'); return; }
      if (!account) { status(''); gate('<p>Connect the Passport operator wallet to edit this Project Home.</p><p style="margin:14px 0 0"><button class="sn-btn primary" type="button" id="heConnect">Connect</button></p>'); $('heConnect').addEventListener('click', () => W.connect().catch((e) => status(e.message, 'bad'))); return; }
      const [facts] = await Promise.all([S.facts ? Promise.resolve(S.facts) : loadFacts(), refreshStatus()]);
      S.facts = facts;
      $('heTitle').textContent = (facts.name || 'Project') + ' · Home';
      document.title = (facts.name || 'Project') + ' Home — SyncNet';
      status('');
      if (!S.passport) { gate(`<p>Sync this project first. A Project Home belongs to the Project Passport operator.</p><p style="margin:14px 0 0"><a class="sn-btn primary" href="/project/${esc(token)}">Open project</a></p>`); return; }
      if (lc(S.passport.operator) !== account) { gate(`<p>Only the current Passport operator can edit this Project Home.</p><p class="sn-small sn-muted">Connected: <span class="sn-mono">${esc(short(account))}</span> · Operator: <span class="sn-mono">${esc(short(S.passport.operator))}</span></p>`); return; }
      const site = S.st.site;
      if (site && site.state === 'PUBLISHED' && lc(site.signer) !== account && entOk()) {
        await review(); $('heBar').hidden = true; return; // a previous operator's home: review & adopt (or edit instead) first
      }
      fill(await startingConfig());
      showEditor();
      if (params.get('step') === 'pay' && !entOk()) { $('hePay').hidden = false; refreshBar(); }
      if (!resume() && !$('hePay').hidden) renderQuoteArea();
      watchFinality();
      if (!(await uploadsOpen())) { document.querySelectorAll('.he-file input').forEach((i) => { i.disabled = true; }); document.querySelectorAll('.he-file').forEach((l) => l.setAttribute('aria-disabled', 'true')); $('heImgNote').textContent = 'Image uploads are not open on this deployment. Your home works without images.'; }
    } catch (e) { status(e.message || 'Project Home is unavailable right now.', 'bad'); }
  }

  function init() {
    $('heBack').href = '/project/' + token;
    $('heForm').addEventListener('input', onChange);
    $('heForm').addEventListener('change', onChange);
    $('heForm').addEventListener('submit', (e) => e.preventDefault());
    $('heLogoFile').addEventListener('change', (e) => { upload('logo', e.target.files[0]); e.target.value = ''; });
    $('heHeroFile').addEventListener('change', (e) => { upload('hero', e.target.files[0]); e.target.value = ''; });
    document.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => { S.images[b.dataset.clear] = ''; imageNames(); onChange(); }));
    $('hePrimary').addEventListener('click', onPrimary);
    $('heUnpublish').addEventListener('click', unpublish);
    $('heRecover').addEventListener('click', recover);
    S.images = { logoCid: '', heroCid: '' };
    let first = true;
    W.onChange((s) => {
      const a = s.connected ? lc(s.account) : '';
      // wait briefly for the silent restore of a remembered wallet before asking to connect
      if (first && !a) { first = false; setTimeout(() => { if (!W.state().connected) boot(''); }, 900); return; }
      first = false;
      boot(a);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
