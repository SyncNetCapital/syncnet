/*
 * Project Home editor (/home-editor.html?token=0x…[&review=1][&step=pay]) — progressive: Edit → Activate → Publish.
 *
 * EDIT     the V1 schema only (lib/syncnet-site.js): preset, accent, headline, about, logo, hero, one CTA, socials,
 *          section visibility. No HTML, CSS, Markdown, embeds or scripts. The draft lives in this browser only.
 * PREVIEW  Site.render({mode:'preview'}) — the SAME pure renderer the server uses — written into a sandboxed
 *          <iframe sandbox="allow-same-origin" srcdoc>: scripts, forms, popups and top navigation stay blocked (the
 *          sandbox grants no script permission); same-origin only so /site-img's Cross-Origin-Resource-Policy lets sanitised images load.
 *          Watermark "PREVIEW · NOT PUBLISHED", no clickable links, nothing stored or served by SyncNet, no public URL.
 *          The page CSP is unchanged and applies to the srcdoc document too (see docs/PROJECT_HOME.md).
 * ACTIVATE one-time $12 activation paid in $SYNC at the SYNCNET REFERENCE RATE: a signed ActivationRequest returns a
 *          locked exact amount (30 minutes); ONE ERC-20 transfer to the sink; the server verifies it from the chain.
 *          QUOTE READY → PAYMENT SEEN (confirming) → ACTIVATED → FINALIZED (later). The user may leave and return:
 *          recovery uses the server's own request state (status view) plus the tx hash remembered in this browser.
 *          The quote request signs the current Terms of Use version (Site.TERMS_VERSION); the quote box is the final
 *          review (project, token, price, exact amount, sink, expiry) and Pay stays disabled until the Terms checkbox is
 *          ticked. RECEIPT: rebuilt on every visit from the server's durable activation record (status view).
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
  // FREE BETA (server config): no payment UI at all; the first publish creates the project's free-beta activation.
  const beta = () => Boolean(S.cfg && S.cfg.freeBeta);
  // A $SYNC transfer request handed to the wallet whose outcome this browser never learned (page reloaded or closed
  // while the wallet prompt was open). Wallets keep such requests and can still send them later, so while one may be
  // open NO new quote or payment is offered: that is how a stale quote got paid next to a fresh one.
  const walletRequestOpen = () => { const p = store.get(PAY); return Boolean(p && p.sending && !p.txHash); };
  const OPEN_REQUEST_MSG = 'A $SYNC transfer request from this browser may still be open in your wallet (for a quote of {amt} $SYNC). Open your wallet and REJECT any pending Project Home transfer before paying again. Approving it would send a second, non-activating payment.';

  // ------------------------------------------------------------------ facts for the preview (the server re-reads its own at publish time)
  async function loadFacts() {
    const registry = new Map();
    try { const j = await (await fetch('/syncnet-projects.json', { cache: 'no-store' })).json(); for (const p of j.projects || []) if (p && p.registry && p.registry.canonical === true && /^0x[0-9a-fA-F]{40}$/.test(String(p.token || ''))) registry.set(lc(p.token), { symbol: String(p.symbol || '').toUpperCase(), logo: String((p.profile && p.profile.image) || '') }); } catch { /* registry optional */ }
    const [meta, project] = await Promise.all([Chain.readTokenMetadata(rpc, token).catch(() => null), Origins.resolveProject(rpc, token).catch(() => null)]);
    let markets = [];
    if (project && project.origin === 'PAR') {
      try { const launch = await Chain.readLaunch(rpc, token); markets = (await Chain.readMarkets(rpc, token, launch)).slice(0, 5).map((m) => ({ pairToken: lc(m.pairToken), symbol: '' })); } catch { markets = []; }
      // Human-readable pair symbols (display only; the server re-reads its own at publish): registry, else the pair's symbol().
      await Promise.all(markets.map(async (m) => { m.symbol = (registry.get(m.pairToken) || {}).symbol || ((await Origins.pairInfo(rpc, m.pairToken).catch(() => null)) || {}).symbol || ''; }));
    } else if (project && project.origin === 'PONS_V2' && project.pair) markets = [{ pairToken: lc(project.pair.address), symbol: project.pair.native ? 'ETH' : '' }];
    let fee = null;
    if (project && project.supported !== false) { try { fee = await Origins.classifyFeeRight(rpc, project); } catch { fee = null; } }
    return {
      feeMode: fee && fee.kind === 'vault' ? String(fee.vault || '') : fee && fee.kind === 'wallet' ? 'creator' : '', feeRecipient: fee && fee.kind === 'wallet' ? lc(fee.recipient) : '',
      logo: (registry.get(token) || {}).logo || '',
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
    $('heAccent').value = c.accent === 'SLATE' ? 'SLATE' : 'BLUE' /* SyncNet offers cyan or monochrome only */; $('heHeadline').value = c.headline; $('heAbout').value = c.about;
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
    const dot = $('heAccentDot'); if (dot) dot.dataset.accent = $('heAccent').value;
  }
  /** The preview canvas shows the site at its REAL width (1280px desktop, 390px phone), scaled to fit. Only the frame's
   *  box is transformed; the sandboxed document is untouched. */
  const DEVICE_W = { desktop: 1280, mobile: 390 };
  function fitPreview() {
    const box = $('heCanvas'), f = $('hePreview');
    if (!box || !f || !box.clientWidth) return;
    const w = DEVICE_W[S.device] || 1280;
    const avail = box.clientWidth - (S.device === 'mobile' ? 32 : 0);
    const k = Math.min(1, avail / w);
    box.dataset.device = S.device;
    f.style.width = w + 'px';
    f.style.height = Math.ceil(box.clientHeight / k) + 'px';
    f.style.transform = `scale(${k})`;
    f.style.left = S.device === 'mobile' ? Math.max(0, Math.round((box.clientWidth - w * k) / 2)) + 'px' : '0px';
  }
  function setDevice(d) {
    S.device = d;
    document.querySelectorAll('[data-device]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.device === d)));
    fitPreview();
  }

  // ------------------------------------------------------------------ images: the existing sanitizer/upload path only
  function imageNames() {
    $('heLogoName').textContent = S.images.logoCid ? 'Sanitised · ' + S.images.logoCid.slice(0, 10) + '…' : 'None';
    $('heHeroName').textContent = S.images.heroCid ? 'Sanitised · ' + S.images.heroCid.slice(0, 10) + '…' : 'None';
    // Thumbnails of the SANITISED image only (same-origin /site-img/<cid>, the path the published home uses).
    for (const [field, id] of [['logoCid', 'heLogoThumb'], ['heroCid', 'heHeroThumb']]) {
      const t = $(id), cid = S.images[field];
      if (!t) continue;
      t.innerHTML = cid && Site.CID.test(cid) ? `<img src="/site-img/${esc(cid)}" alt="">` : '';
      t.dataset.empty = String(!cid);
    }
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
    if (S.st && S.st.suspension) { steps(entOk() ? 'publish' : 'edit'); btn.dataset.act = ''; btn.textContent = 'PUBLISH'; btn.disabled = true; note.textContent = 'SyncNet has suspended this Project Home, so publishing and activation are paused. Your activation, revision history and Project Passport are unchanged. To ask about it, use Contact → Report.'; return; }
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
    if (beta()) {
      steps('publish');
      btn.dataset.act = 'publish';
      btn.textContent = 'PUBLISH FREE BETA';
      note.textContent = 'Project Home is currently free during beta. Publish your Project Home at no activation cost. Free-beta activations stay with the project.';
      if (!S.config) { btn.disabled = true; note.textContent = 'Project Home is currently free during beta. Fix the highlighted fields to publish.'; }
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
      await refreshStatus(); renderReceipt();
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
    if (walletRequestOpen()) {
      const p = store.get(PAY);
      box.innerHTML = `<p class="sn-warn-line">${esc(OPEN_REQUEST_MSG.replace('{amt}', p.amount || 'an earlier'))}</p>
<p style="margin:14px 0 0"><button class="sn-btn" type="button" id="heClearPending">I rejected it in my wallet</button></p>`;
      $('heClearPending').addEventListener('click', () => { if (confirm('Only continue if your wallet shows NO pending Project Home transfer. Continue?')) { store.set(PAY, null); renderQuoteArea(); } });
      return;
    }
    box.innerHTML = `<p class="sn-small sn-dim">Step 1 · Get a quote to lock the exact $SYNC amount for 30 minutes. Asking for a quote is a free signature. It records which <a href="/terms.html" target="_blank" rel="noopener">Terms of Use</a> version (${esc(Site.TERMS_VERSION)}) applies to this activation and does not send a payment.</p>
<p style="margin:14px 0 0"><button class="sn-btn primary" type="button" id="heQuoteBtn">Get quote</button></p>
<p class="sn-small sn-muted">SYNCNET REFERENCE RATE · read from the canonical SYNC/USDG market on Robinhood Chain when you request a quote, then locked for 30 minutes. A SyncNet reference rate, not a price feed.</p>`;
    $('heQuoteBtn').addEventListener('click', getQuote);
  }
  async function getQuote() {
    if (S.busy) return;
    if (walletRequestOpen()) { renderQuoteArea(); return; }
    S.busy = true;
    try {
      const message = { token, operator: S.account, issuedAt: nowSec(), nonce: nonce(), termsVersion: Site.TERMS_VERSION };
      payStatus('Sign in your wallet to request a quote (free, no transaction). The signature records which Terms of Use version (' + Site.TERMS_VERSION + ') applies to this activation; it does not send a payment.');
      const signature = await sign('ActivationRequest', message);
      const r = await post({ action: 'intent', token, operator: S.account, issuedAt: message.issuedAt, nonce: message.nonce, termsVersion: message.termsVersion, signature });
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
    if (i.termsVersion !== Site.TERMS_VERSION) { // a quote issued before the current Terms: re-sign (same quote, same amount)
      box.innerHTML = `<p class="sn-warn-line">This quote was requested before the current <a href="/terms.html" target="_blank" rel="noopener">Terms of Use</a> (version ${esc(Site.TERMS_VERSION)}). Sign the quote request again to record the current version. The amount and the lock stay the same.</p>
<p style="margin:14px 0 0"><button class="sn-btn primary" type="button" id="heQuoteBtn">Sign to record the current Terms version</button></p>`;
      $('heQuoteBtn').addEventListener('click', getQuote);
      return;
    }
    const exp = new Date(i.expiresAt);
    const local = exp.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const utc = exp.toISOString().slice(0, 16).replace('T', ' ');
    box.innerHTML = `<p class="sn-small sn-dim">Step 2 · Final review. Check every line, accept the Terms, then pay in your wallet.</p>
<dl class="sn-kv he-quote">
<dt>Project</dt><dd>${esc((S.facts && S.facts.name) || 'Project')}<br><span class="sn-mono" id="heQuoteToken">${esc(i.token)}</span></dd>
<dt>Price</dt><dd>$${esc(i.priceUsd)} · one-time · paid in $SYNC</dd>
<dt>Amount</dt><dd><span class="sn-amount" id="heAmount">${esc(i.exactTaggedSyncDisplay)} $SYNC</span> <button class="sn-textbtn sn-small" type="button" data-copy-text="${esc(i.exactTaggedSyncDisplay)}">Copy</button></dd>
<dt>To</dt><dd><span class="sn-mono" id="heQuoteSink">${esc(i.sink)}</span> <span class="sn-small sn-muted">Project Home sink</span></dd>
<dt>Rate</dt><dd>SYNCNET REFERENCE RATE · Your rate is locked for 30 minutes<br><span class="sn-small sn-muted">1 $SYNC = $${esc(i.syncUsdReferenceRate)} · ${i.rateSource && i.rateSource.block ? `canonical SYNC/USDG market · block ${esc(i.rateSource.block)}` : `version ${esc(i.rateVersion)}`}</span></dd>
<dt>Locked for</dt><dd><span class="sn-mono" id="heLeft">—</span><br><span class="sn-small sn-muted" id="heExpires">Expires ${esc(local)} (your time) · ${esc(utc)} UTC</span></dd>
<dt>Allocation</dt><dd>60% burned · 40% converted to USDG for the SyncNet treasury</dd>
<dt>Refunds</dt><dd>Non-refundable after successful activation. The activation belongs to this project (the token).</dd></dl>
<p class="sn-warn-line">Send only the exact quoted amount before the quote expires. Late or duplicate payments cannot be automatically refunded.</p>
<p class="he-accept"><label><input type="checkbox" id="heAccept"><span>I have read and accept the <a href="/terms.html" target="_blank" rel="noopener">Terms of Use</a> and understand that this is a one-time USD 12 Project Home activation paid in SYNC and is non-refundable after successful activation.</span></label></p>
<p style="margin:16px 0 0"><button class="sn-btn primary he-paybtn" type="button" id="hePayBtn" disabled>PAY NOW · ${esc(i.exactTaggedSyncDisplay)} SYNC</button></p>
<p class="he-paynote"><strong>One-time payment · Non-refundable after successful activation</strong></p>
<p class="sn-small sn-muted">Step 3 · One $SYNC transfer that you review in your wallet. Step 4 · SyncNet verifies it on Robinhood Chain and shows your receipt.</p>`;
    $('hePayBtn').addEventListener('click', () => pay(i));
    const accept = $('heAccept');
    const tick = () => {
      const left = Math.floor((Date.parse(i.expiresAt) - Date.now()) / 1000);
      const el = $('heLeft'); if (el) el.textContent = fmtLeft(left);
      const b = $('hePayBtn');
      if (b && left >= MIN_PAY_SECONDS && !S.busy) b.disabled = !(accept && accept.checked); // Pay only after the Terms are accepted
      if (b && left < MIN_PAY_SECONDS) { b.disabled = true; clearInterval(S.countdown); payStatus(left <= 0 ? 'This quote expired. Nothing was paid. Get a new quote.' : 'This quote is about to expire. Get a new quote before paying.', 'warn'); if (left <= 0) { S.st.openIntent = null; renderQuoteArea(); } }
    };
    accept.addEventListener('change', tick);
    tick(); S.countdown = setInterval(tick, 1000);
  }
  function transferData(to, amountWei) {
    const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
    return '0xa9059cbb' + pad(lc(to)) + pad(BigInt(amountWei).toString(16));
  }
  async function pay(i) {
    if (S.busy) return;
    const pend = store.get(PAY);
    if (pend && pend.txHash) { resume(); return; } // a transfer is already on its way (ANY quote): verify it, never send another
    if (walletRequestOpen()) { renderQuoteArea(); return; } // an earlier wallet request may still be open
    const left = Math.floor((Date.parse(i.expiresAt) - Date.now()) / 1000);
    if (left < MIN_PAY_SECONDS) { payStatus('This quote is too close to expiry. Get a new quote.', 'warn'); return; }
    if (!$('heAccept') || !$('heAccept').checked || i.termsVersion !== Site.TERMS_VERSION) { payStatus('Accept the Terms of Use to pay.', 'warn'); return; }
    if (lc(i.canonicalSync) !== SYNC || Number(i.chainId) !== CHAIN_ID || !S.cfg.sink || lc(i.sink) !== lc(S.cfg.sink) || lc(i.token) !== token) { payStatus('This quote does not match the payment configuration. Nothing was sent.', 'bad'); return; }
    S.busy = true; $('hePayBtn').disabled = true;
    try {
      payStatus('Review the $SYNC transfer in your wallet…');
      let txHash;
      store.set(PAY, { requestId: i.requestId, sending: true, amount: i.exactTaggedSyncDisplay, expiresAt: i.expiresAt, at: Date.now() });
      try { txHash = await W.sendTransaction({ to: SYNC, data: transferData(i.sink, i.exactTaggedSyncAmount), value: '0x0' }); }
      catch (e) { store.set(PAY, null); throw new Error(e && (e.code === 4001 || /reject|denied/i.test(String(e.message))) ? 'You rejected the transaction. Nothing was sent.' : 'The wallet could not send the transaction: ' + String((e && e.message) || e).slice(0, 140)); }
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
        payStatus(b.status === 'FINALIZED' ? 'Activated and finalized. You can publish now. Your receipt is below.' : 'Activated. You can publish now. Finality is confirmed later on its own. Your receipt is below.', 'ok');
        S.polling = 0; refreshBar(); renderReceipt(); watchFinality();
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
      if (r && r.ok && r.body.status && r.body.status !== S.st.entitlement.status) { await refreshStatus(); refreshBar(); renderReceipt(); if (S.st.entitlement && S.st.entitlement.status === 'FINALIZED') { paySteps('final'); payStatus('Finalized.', 'ok'); return; } if (S.st.entitlement && S.st.entitlement.status === 'INVALIDATED_BY_REORG') { payStatus('The activation payment left the canonical chain. Publishing is paused until it is confirmed again.', 'bad'); return; } }
      if (++tries < 20) S.finalTimer = setTimeout(run, 60000);
    };
    S.finalTimer = setTimeout(run, 2000);
  }
  /** Recovery: resume from this browser's tx record, or from the server's own observed payment for the open request. */
  function resume() {
    const pend = store.get(PAY);
    const intent = S.st && S.st.openIntent;
    if (entOk()) { store.set(PAY, null); return false; }
    if (beta()) return false; // no payment UI during the free beta (a payment sent earlier stays recorded server-side)
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

  // ------------------------------------------------------------------ receipt (from the server's durable activation record)
  /** The receipt data, or null when this project has no PAID activation. Only server-recorded values are used. */
  function receiptData() {
    const e = S.st && S.st.entitlement;
    if (!e || e.kind !== 'paid' || !e.txHash) return null;
    return {
      schema: 'syncnet.project-home.receipt.v1', issuer: 'SyncNet', product: 'SyncNet Project Home activation (one-time)',
      project: { name: (S.facts && S.facts.name) || '', token: e.token }, chainId: e.chainId,
      priceUsd: (Number(e.priceUsdCents) / 100).toFixed(2), priceVersion: e.priceVersion,
      syncPaid: e.exactSyncDisplay, syncPaidWei: e.exactAmount, payer: e.payer, paidTo: e.sink, canonicalSync: e.canonicalSync,
      txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, blockTime: e.blockTimestamp ? new Date(e.blockTimestamp * 1000).toISOString() : null,
      activatedAt: e.activatedAt, finalizedAt: e.finalizedAt || null, status: e.status,
      syncnetReferenceRate: { syncUsd: e.syncUsdReferenceRate, rateVersion: e.rateVersion },
      requestId: e.requestId, termsVersionAccepted: e.termsVersion || null,
      entitlement: 'Belongs to the project (token), not to the paying wallet.',
      allocation: { burnPercent: 60, treasuryPercent: 40, treasuryAsset: 'USDG' },
      refund: 'Non-refundable after successful activation.',
      source: location.origin + '/api/project-home?view=status&token=' + e.token,
    };
  }
  function renderReceipt() {
    const r = receiptData(), sec = $('heReceipt');
    const e = S.st && S.st.entitlement;
    $('heReceiptTitle').textContent = 'Receipt · SyncNet Project Home activation';
    document.querySelector('.he-receipt-actions').hidden = false;
    if (!r && e && e.kind === 'beta') { // not a payment receipt: no amount, no payer, no transaction exists
      $('heReceiptTitle').textContent = 'FREE BETA ACTIVATION';
      document.querySelector('.he-receipt-actions').hidden = true;
      $('heReceiptBody').innerHTML = `<dl class="sn-kv">
<dt>Project</dt><dd>${esc((S.facts && S.facts.name) || '—')}</dd>
<dt>Token contract</dt><dd><span class="sn-mono">${esc(e.token)}</span></dd>
<dt>Entitlement</dt><dd>FREE BETA · belongs to the project (token), not to a wallet</dd>
<dt>Activated</dt><dd>${esc(String(e.activatedAt || '').replace('T', ' ').slice(0, 19))} UTC</dd>
<dt>Status</dt><dd>${esc(e.status)}</dd>
<dt>Payment</dt><dd>None. Free-beta activations stay with the project after the beta ends.</dd></dl>`;
      sec.hidden = false;
      return;
    }
    if (!r) { sec.hidden = true; return; }
    const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
    const mono = (v) => `<span class="sn-mono">${esc(v == null ? '—' : v)}</span>`;
    const statusText = { ACTIVE: 'ACTIVE · paid and confirmed (finality follows)', FINALIZED: 'FINALIZED · paid and final', INVALIDATED_BY_REORG: 'PAUSED · the payment left the canonical chain; awaiting re-confirmation' }[r.status] || r.status;
    $('heReceiptBody').innerHTML = `<dl class="sn-kv">
${row('Product', esc(r.product))}
${row('Project', esc(r.project.name || '—'))}
${row('Token contract', mono(r.project.token))}
${row('Price', 'USD ' + esc(r.priceUsd) + ' · one-time')}
${row('SYNC paid', mono(r.syncPaid + ' SYNC'))}
${row('Payer wallet', mono(r.payer))}
${row('Paid to', mono(r.paidTo) + ' <span class="sn-small sn-muted">Project Home sink</span>')}
${row('Transaction', `<a class="sn-mono" href="https://robinhoodchain.blockscout.com/tx/${esc(r.txHash)}" target="_blank" rel="noreferrer">${esc(r.txHash)} ↗</a>`)}
${row('Block', mono(r.blockNumber) + (r.blockTime ? ' · ' + esc(r.blockTime.replace('T', ' ').slice(0, 19)) + ' UTC' : ''))}
${row('Activation recorded', esc(String(r.activatedAt || '').replace('T', ' ').slice(0, 19)) + ' UTC')}
${row('SyncNet reference rate', '1 SYNC = $' + esc(r.syncnetReferenceRate.syncUsd) + ' · version ' + esc(r.syncnetReferenceRate.rateVersion))}
${row('Quote ID', mono(r.requestId))}
${row('Terms accepted', r.termsVersionAccepted ? `<a href="/terms.html" target="_blank" rel="noopener">Terms of Use</a> version ${esc(r.termsVersionAccepted)} (version recorded in the signed quote request)` : 'Not recorded (quote issued before Terms versions were signed)')}
${row('Status', esc(statusText))}
${row('Entitlement', esc(r.entitlement))}
${row('Allocation', '60% burned · 40% converted to USDG for the SyncNet treasury')}
${row('Refunds', esc(r.refund))}
</dl>
<p class="sn-small sn-muted">Issued by SyncNet from its activation record, which anyone can re-check at <span class="sn-mono">/api/project-home?view=status&amp;token=${esc(r.project.token)}</span> and against the transaction on Robinhood Chain.</p>`;
    sec.hidden = false;
  }
  function downloadReceipt() {
    const r = receiptData();
    if (!r) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...r, generatedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'syncnet-project-home-receipt-' + r.project.token + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------------ boot
  async function refreshStatus() { S.st = await api({ view: 'status', token }); S.passport = S.st.passport; return S.st; }
  function gate(html) { const g = $('heGate'); g.innerHTML = html; g.hidden = false; $('heGrid').hidden = true; $('heBar').hidden = true; $('hePay').hidden = true; $('heReview').hidden = true; }
  function showEditor() { $('heGate').hidden = true; $('heGrid').hidden = false; onChange(); requestAnimationFrame(fitPreview); }
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
    preview(rev.config); requestAnimationFrame(fitPreview);
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
      if (S.cfg.price && Number.isInteger(S.cfg.price.priceUsdCents)) { const c = S.cfg.price.priceUsdCents; $('hePrice').textContent = '$' + (c % 100 ? (c / 100).toFixed(2) : String(c / 100)); }
      if (!S.cfg.enabled) { status(''); gate('<p>Project Home is not open yet.</p><p class="sn-small sn-muted">Nothing can be activated or published on this deployment right now.</p>'); return; }
      if (!account) { status(''); gate('<p>Connect the Passport operator wallet to edit this Project Home.</p><p style="margin:14px 0 0"><button class="sn-btn primary" type="button" id="heConnect">Connect</button></p>'); $('heConnect').addEventListener('click', () => W.connect().catch((e) => status(e.message, 'bad'))); return; }
      const [facts] = await Promise.all([S.facts ? Promise.resolve(S.facts) : loadFacts(), refreshStatus()]);
      S.facts = facts;
      $('heTitle').textContent = (facts.name || 'Project') + ' · Home';
      document.title = (facts.name || 'Project') + ' Home — SyncNet';
      status('');
      renderReceipt(); // any connected wallet can reopen the receipt, operator or not
      if (!S.passport) { gate(`<p>Sync this project first. A Project Home belongs to the Project Passport operator.</p><p style="margin:14px 0 0"><a class="sn-btn primary" href="/project/${esc(token)}">Open project</a></p>`); return; }
      if (lc(S.passport.operator) !== account) { gate(`<p>Only the current Passport operator can edit this Project Home.</p><p class="sn-small sn-muted">Connected: <span class="sn-mono">${esc(short(account))}</span> · Operator: <span class="sn-mono">${esc(short(S.passport.operator))}</span></p>`); return; }
      const site = S.st.site;
      if (site && site.state === 'PUBLISHED' && lc(site.signer) !== account && entOk()) {
        await review(); $('heBar').hidden = true; return; // a previous operator's home: review & adopt (or edit instead) first
      }
      fill(await startingConfig());
      showEditor();
      if (params.get('step') === 'pay' && !entOk() && !beta()) { $('hePay').hidden = false; refreshBar(); }
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
    $('hePrintReceipt').addEventListener('click', () => { document.body.classList.add('he-printing'); addEventListener('afterprint', () => document.body.classList.remove('he-printing'), { once: true }); window.print(); });
    $('heDownloadReceipt').addEventListener('click', downloadReceipt);
    S.images = { logoCid: '', heroCid: '' };
    S.device = matchMedia('(max-width: 959px)').matches ? 'mobile' : 'desktop';
    document.querySelectorAll('[data-device]').forEach((b) => b.addEventListener('click', () => setDevice(b.dataset.device)));
    setDevice(S.device);
    if (window.ResizeObserver) new ResizeObserver(() => fitPreview()).observe($('heCanvas')); else addEventListener('resize', fitPreview);
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
