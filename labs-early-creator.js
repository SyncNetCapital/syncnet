/*
 * EARLY creator setup and dashboard (docs §12, §16.3/16.4):
 *   1 connect the receiving wallet → sign CreatorLinkRequest → 2 YouTube OAuth (round trip; the callback returns a
 *   creator session in the URL fragment, kept in sessionStorage only) → 3 choose accepted assets + minimums, sign the
 *   CreatorManifest with the receiving wallet → 4 live. Dashboard: status, private aggregate of interest signals,
 *   pause/resume (session), change wallet (fresh YouTube + new wallet signature, 48 h), cancel a pending change.
 */
(function () {
  'use strict';
  const UI = window.SyncNetUI, W = window.SyncNetWallet, E = window.SyncNetEarly;
  const $ = (id) => document.getElementById(id);
  const esc = UI.esc, short = UI.short;
  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const sess = { get() { try { return sessionStorage.getItem('syncnet_early_creator_session') || ''; } catch { return ''; } }, set(v) { try { if (v) sessionStorage.setItem('syncnet_early_creator_session', v); else sessionStorage.removeItem('syncnet_early_creator_session'); } catch { /* blocked */ } } };
  const S = { cfg: null, me: null, busy: false, noYt: false, xBtn: null };
  // X is offered ONLY when the server's own config enables it (the server enforces the gate on every request regardless)
  const xOauth = () => Boolean(S.cfg && Array.isArray(S.cfg.platforms) && S.cfg.platforms.includes('x') && S.cfg.platformServices && S.cfg.platformServices.x && S.cfg.platformServices.x.oauth);
  const LINKED = { get() { try { return sessionStorage.getItem('syncnet_early_link_platform') || ''; } catch { return ''; } }, set(v) { try { sessionStorage.setItem('syncnet_early_link_platform', v); } catch { /* blocked */ } } };
  const isX = (o) => Boolean(o) && o.platform === 'x';
  const status = (m, tone) => { const el = $('cStatus'); el.textContent = m || ''; if (tone) el.dataset.tone = tone; else delete el.dataset.tone; };
  const rejected = (e) => e && (e.code === 4001 || /reject|denied/i.test(String(e.message)));
  const nonce = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); };
  const nowSec = () => Math.floor(Date.now() / 1000);
  async function api(params) { const r = await fetch('/api/early?' + new URLSearchParams(params), { cache: 'no-store', headers: sess.get() ? { 'x-syncnet-early-session': sess.get() } : {} }); const j = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, body: j }; }
  async function post(body) { const r = await fetch('/api/early', { method: 'POST', headers: { 'content-type': 'application/json', ...(sess.get() ? { 'x-syncnet-early-session': sess.get() } : {}) }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, body: j }; }
  const errText = (r, f) => (r && r.body && r.body.error) || f || 'The request was refused.';
  const ERRORS = { denied: 'YouTube access was not granted. Nothing was changed.', no_channel: 'That Google account has no YouTube channel. Sign in with the account that owns your channel.', state: 'The sign-in link expired or was reused. Start again.', unavailable: 'YouTube sign-in is not available right now. Try again later.', closed: 'Creator onboarding is not open on this deployment.' };
  const ERRORS_X = { denied: 'X access was not granted. Nothing was changed.', no_account: 'That X account could not be read. Try again.', state: 'The sign-in link expired or was reused. Start again.', unavailable: 'X sign-in is not available right now. Try again later.', closed: 'Creator onboarding is not open on this deployment.' };
  function steps(active, done) { for (const li of $('cSteps').querySelectorAll('li')) { const s = li.dataset.step; if (s === active) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); li.dataset.done = String((done || []).includes(s)); } }
  const show = (id) => { for (const s of ['cWallet', 'cManifest', 'cDash']) $(s).hidden = s !== id; };

  async function init() {
    // the OAuth callback returns #s=<session> or #e=<code>; the fragment never reaches the server
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (h.get('s')) { sess.set(h.get('s')); history.replaceState(null, '', location.pathname); }
    if (h.get('e')) { const xr = LINKED.get() === 'x'; status((xr ? ERRORS_X : ERRORS)[h.get('e')] || 'Sign-in failed.', 'bad'); history.replaceState(null, '', location.pathname); }
    const cfg = await api({ view: 'config' }).catch(() => null);
    S.cfg = cfg && cfg.body ? cfg.body : null;
    if (!S.cfg || !S.cfg.enabled) { $('cGate').hidden = false; return; }
    if (!S.cfg.oauth && !xOauth()) { $('cGate').hidden = false; $('cGate').firstElementChild.textContent = 'YouTube sign-in is not configured on this deployment yet.'; return; }
    S.noYt = !S.cfg.oauth;
    if (xOauth()) addXLink();
    W.onChange(renderWallet);
    $('cConnect').addEventListener('click', () => W.connect().catch((e) => status(e.message, 'bad')));
    $('cLink').addEventListener('click', () => link('youtube'));
    $('cSign').addEventListener('click', () => signManifest(false));
    $('dPause').addEventListener('click', () => pause(true)); $('dResume').addEventListener('click', () => pause(false));
    $('dRotate').addEventListener('click', () => { $('dRotatePanel').hidden = !$('dRotatePanel').hidden; renderRotate(); });
    $('dRotateSign').addEventListener('click', () => signManifest(true));
    $('dCancelRotation').addEventListener('click', cancelRotation);
    $('dCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('dPage').href); $('dCopy').textContent = 'Copied'; } catch { /* clipboard */ } });
    if (sess.get()) { const me = await api({ view: 'me' }); if (me.ok) { S.me = me.body; return me.body.creator ? dashboard() : manifestStep(); } sess.set(''); }
    show('cWallet'); steps('wallet', []);
  }
  function renderWallet(s) { $('cWalletAddr').textContent = s.connected ? s.account : ''; $('cLink').hidden = !s.connected || S.noYt; if (S.xBtn) S.xBtn.hidden = !s.connected; $('cConnect').hidden = s.connected; }
  /** "Continue with X" + its one-line note, after the existing YouTube button and note; created only when X is enabled. */
  function addXLink() {
    const yt = $('cLink').parentElement, ytNote = yt.nextElementSibling;
    if (S.noYt) { yt.hidden = true; ytNote.hidden = true; }
    ytNote.insertAdjacentHTML('afterend', '<p><button class="sn-btn primary" type="button" id="cLinkX" hidden>Continue with X</button></p><p class="sn-small sn-muted">Continuing signs a free message with your wallet, then opens X to confirm which account you control (read-only access, nothing is posted).</p>');
    S.xBtn = $('cLinkX'); S.xBtn.addEventListener('click', () => link('x'));
  }
  const stepName = (name) => { const li = $('cSteps').querySelector('[data-step="youtube"]'); if (li && li.lastChild) li.lastChild.textContent = ' ' + name; };
  async function link(platform) {
    if (S.busy) return; S.busy = true;
    const x = platform === 'x';
    try {
      const wallet = W.state().account;
      const m = { schema: E.SCHEMA.creatorLink, wallet, issuedAt: nowSec(), nonce: nonce() };
      status('Sign the free link request in your wallet…');
      const signature = await W.signTyped(E.typedData('CreatorLinkRequest', m));
      const r = await post(x ? { action: 'creator-link', platform: 'x', wallet, issuedAt: m.issuedAt, nonce: m.nonce, signature } : { action: 'creator-link', wallet, issuedAt: m.issuedAt, nonce: m.nonce, signature });
      if (!r.ok) throw new Error(errText(r, x ? 'Could not start X sign-in.' : 'Could not start YouTube sign-in.'));
      LINKED.set(platform);
      if (x) stepName('X');
      steps('youtube', ['wallet']);
      status(x ? 'Opening X to confirm your account (read-only)…' : 'Opening Google to confirm your channel (read-only)…');
      location.href = r.body.startUrl;
    } catch (e) { status(rejected(e) ? 'You did not sign. Nothing was changed.' : e.message, 'bad'); }
    finally { S.busy = false; }
  }
  function assetRows(current) {
    const assets = S.cfg.assets;
    return assets.map((a) => { const cur = current && current.find((x) => x.token === a.token); return `<label class="early-asset-row"><input type="checkbox" data-token="${esc(a.token)}" ${cur ? 'checked' : ''}> <strong>${esc(a.symbol)}</strong> <span class="sn-small sn-muted">minimum</span> <input class="sn-input" data-min="${esc(a.token)}" inputmode="decimal" value="${cur ? esc(E.formatUnits(cur.minAmount, a.decimals)) : (a.decimals === 6 ? '1' : '1')}" aria-label="Minimum ${esc(a.symbol)}"></label>`; }).join('');
  }
  function readAssets() {
    const out = [];
    for (const cb of document.querySelectorAll('input[type="checkbox"][data-token]')) {
      if (!cb.checked) continue;
      const a = S.cfg.assets.find((x) => x.token === cb.dataset.token);
      const raw = E.parseUnits(document.querySelector(`input[data-min="${cb.dataset.token}"]`).value, a.decimals);
      if (!raw) throw new Error('Enter a valid minimum for ' + a.symbol + '.');
      out.push({ token: a.token, minAmount: raw });
    }
    if (!out.length) throw new Error('Choose at least one asset.');
    return out;
  }
  function manifestStep() {
    show('cManifest'); steps('manifest', ['wallet', 'youtube']);
    const me = S.me;
    if (isX(me)) {
      // X: the person-facing line is the current @username (display metadata); the immutable numeric id is never the headline
      stepName('X');
      $('cYou').innerHTML = `${UI.logoHtml('', me.display ? me.display.title : 'C')}<div><strong>${esc(me.display && me.display.title ? me.display.title : 'X account')}</strong><br><span class="sn-small sn-muted">${esc(me.display && me.display.handle ? me.display.handle : 'X account')} · wallet ${esc(short(me.linkWallet))}</span></div>`;
      document.querySelector('#cManifest > p.sn-dim').textContent = 'What fans can send you. Minimums are yours to choose. Identity is your X account id; your username and name can change freely.';
    } else $('cYou').innerHTML = `${UI.logoHtml('', me.display ? me.display.title : 'C')}<div><strong>${esc(me.display ? me.display.title : me.channelId)}</strong><br><span class="sn-small sn-muted">${esc(me.channelId)} · wallet ${esc(short(me.linkWallet))}</span></div>`;
    $('cAssets').innerHTML = assetRows(null);
    if (!me.linkFresh) status(isX(me) ? 'Your X verification has expired. Start again from step 1.' : 'Your YouTube verification has expired. Start again from step 1.', 'warn');
  }
  async function signManifest(rotation) {
    if (S.busy) return; S.busy = true;
    try {
      const me = S.me;
      if (!W.state().connected) await W.connect();
      const wallet = W.state().account;
      if (!rotation && lc(wallet) !== lc(me.linkWallet)) throw new Error('Sign with the wallet you linked (' + short(me.linkWallet) + ').');
      const accepted = readAssets();
      const allow = new Map(S.cfg.assets.map((a) => [a.token, a]));
      const na = E.normalizeAcceptedAssets(accepted, allow);
      if (!na.ok) throw new Error(na.error);
      const cur = rotation && me.creator ? me.creator.currentManifest : null;
      if (rotation && cur && lc(wallet) === lc(cur.receivingWallet)) throw new Error('Connect the NEW wallet first (this is the current one).');
      // the signed v1 struct names the immutable id in `channelId` for every platform; for X that is the numeric user id (never a username)
      const x = isX(me), id = x ? me.externalId : me.channelId;
      const m = { schema: E.SCHEMA.manifest, creatorId: x ? E.creatorIdOf(id, 'x') : E.creatorIdOf(me.channelId), platform: x ? 'x' : 'youtube', channelId: id, chainId: 4663, receivingWallet: wallet, acceptedAssetsHash: na.hash, manifestVersion: cur ? cur.manifestVersion + 1 : 1, previousManifestHash: cur ? cur.manifestHash : E.ZERO32, issuedAt: nowSec(), nonce: nonce() };
      status('Sign the manifest in your wallet (free)…');
      const signature = await W.signTyped(E.typedData('CreatorManifest', m));
      const ident = x ? { platform: 'x', externalId: m.channelId } : { channelId: m.channelId };
      const r = await post({ action: 'creator-manifest', creatorId: m.creatorId, ...ident, receivingWallet: wallet, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: m.manifestVersion, previousManifestHash: m.previousManifestHash, issuedAt: m.issuedAt, nonce: m.nonce, signature });
      if (!r.ok) throw new Error(errText(r, 'The manifest was refused.'));
      status(rotation ? r.body.warning : (r.body.signalsNote || 'You are live.'), 'ok');
      const me2 = await api({ view: 'me' }); if (me2.ok) S.me = me2.body;
      dashboard();
    } catch (e) { status(rejected(e) ? 'You did not sign. Nothing was changed.' : e.message, 'bad'); }
    finally { S.busy = false; }
  }
  function dashboard() {
    show('cDash'); steps('live', ['wallet', 'youtube', 'manifest']);
    const c = S.me.creator, d = S.me.display || c.display, x = isX(c);
    if (x) stepName('X');
    $('dTitle').textContent = d.title || (x ? 'X account' : c.channelId); $('dHandle').textContent = d.handle || (x ? 'X account' : c.channelId);
    if (d.avatarUrl) $('dAvatar').innerHTML = `<img src="${esc(d.avatarUrl)}" alt="">`; else $('dAvatar').textContent = (d.title || '·').charAt(0).toUpperCase();
    const page = x ? '/labs/early/c/x/' + c.externalId : '/labs/early/c/' + c.channelId;
    $('dPage').href = page; $('dPage').textContent = location.origin + page;
    $('dWallet').textContent = c.currentManifest ? c.currentManifest.receivingWallet : '—';
    $('dStatus').textContent = c.status + (c.paused ? ' · support paused' : '');
    const n = c.signalsWaitingAtJoin;
    $('dSignals').textContent = n == null ? '—' : n === 1 ? '1 signed interest signal was waiting when you joined.' : n + ' signed interest signals were waiting when you joined.';
    $('dPause').hidden = c.paused; $('dResume').hidden = !c.paused;
    const rot = c.rotation && c.status === 'ROTATION_PENDING';
    $('dRotation').hidden = !rot; $('dCancelRotation').hidden = !rot; $('dRotate').hidden = Boolean(rot);
    if (rot) $('dRotationText').textContent = 'Receiving wallet changes on ' + new Date(c.rotation.effectiveAt * 1000).toUTCString() + ' to ' + short(c.rotation.newWallet) + '. Until then support goes to your current wallet. Your current wallet can cancel this change.';
  }
  function renderRotate() {
    const plat = isX(S.me) ? 'X' : 'YouTube';
    $('dRotateFresh').textContent = S.me.linkFresh ? 'Your ' + plat + ' verification is fresh. Connect the new wallet, choose assets, sign.' : 'A wallet change needs a fresh ' + plat + ' verification: reload this page and sign in with ' + plat + ' again first.';
    if (!document.querySelector('#dRotatePanel .early-asset-row')) $('dRotatePanel').insertAdjacentHTML('afterbegin', `<div id="dRotateAssets">${assetRows(S.me.creator.currentManifest ? S.me.creator.currentManifest.acceptedAssets : null)}</div>`);
  }
  async function pause(on) {
    const r = await post({ action: on ? 'creator-pause' : 'creator-resume' });
    if (!r.ok) { status(errText(r), 'bad'); return; }
    const me = await api({ view: 'me' }); if (me.ok) { S.me = me.body; dashboard(); }
    status(on ? 'Support paused. Fans cannot start new support until you resume.' : 'Support resumed.', 'ok');
  }
  async function cancelRotation() {
    try {
      const c = S.me.creator;
      // session cancel (the account holder); the current wallet can also cancel with a signature from the creator page
      const r = await post({ action: 'rotation-cancel', creatorId: c.creatorId, pendingManifestHash: c.rotation.pendingManifestHash });
      if (!r.ok) throw new Error(errText(r));
      const me = await api({ view: 'me' }); if (me.ok) { S.me = me.body; dashboard(); }
      status('The wallet change was cancelled.', 'ok');
    } catch (e) { status(e.message, 'bad'); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
