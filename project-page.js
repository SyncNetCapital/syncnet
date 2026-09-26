/*
 * Project Page (/project/<address>) — one scrolling page, the same for visitors and operators.
 *
 *   header   ← Explore · name · origin · sync state · contract + Copy · external actions
 *   rows     HOME · CONTROL · MARKET · CONNECTIONS · ECONOMY — each only when it says something true and useful
 *   DETAILS  the Registry proofs, Passport technical data and origin evidence (v2-token.js, unchanged trust model)
 *
 * Authority never changes what the page SAYS, only which actions appear: the current Passport operator gets
 * Edit / Transfer / List / Review & adopt; a wallet that can establish the first Passport (on-chain deployer or
 * creator-fee recipient) gets SYNC PROJECT. Every fact comes from v2-token.js (read on-chain first) or from the
 * server APIs, which re-verify every signed action. Nothing here moves funds: SYNC PROJECT is one free EIP-712
 * signature (the Marketplace OperatorClaim) that the server checks against live factory records.
 */
(function () {
  'use strict';
  const UI = window.SyncNetUI, W = window.SyncNetWallet, Market = window.SyncNetMarket;
  const $ = (id) => document.getElementById(id);
  const esc = UI.esc, short = UI.short;
  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const HUB = 3;
  const SYNC_HELP = 'Verify that you control this project. Nothing moves on-chain.';
  let P = null;                       // facts announced by v2-token.js
  const S = { market: null, home: null, homeStatus: null, economy: null, busy: false };

  const me = () => { const s = W ? W.state() : null; return s && s.connected ? lc(s.account) : ''; };
  const operator = () => (P && P.passport ? lc(P.passport.operator) : '');
  /** operator | eligible (can establish the first Passport) | visitor */
  function role() {
    const a = me();
    if (!a || !P) return 'visitor';
    if (operator() === a) return 'operator';
    if (!P.passport && P.claimable && (a === P.deployer || a === P.feeRecipient)) return 'eligible';
    return 'visitor';
  }
  const syncState = () => (P && P.passport ? 'synced' : 'unclaimed');
  const status = (msg, tone) => { const el = $('pjStatus'); el.textContent = msg || ''; if (tone) el.dataset.tone = tone; else delete el.dataset.tone; };
  const nonce = () => { const a = new Uint8Array(32); crypto.getRandomValues(a); return '0x' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
  async function getJson(url) { const r = await fetch(url, { cache: 'no-store' }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || 'Unavailable right now.'), { status: r.status, body: j }); return j; }
  async function postJson(url, body) { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || 'The request was refused.'), { status: r.status, body: j }); return j; }
  const draftKey = (t) => 'syncnet_home_draft_' + t;
  const hasDraft = (t) => { try { return Boolean(localStorage.getItem(draftKey(t))); } catch { return false; } };

  // ------------------------------------------------------------------ header
  function renderHead() {
    const logo = $('pjLogo');
    if (logo && P.token) { const tmp = document.createElement('span'); tmp.innerHTML = UI.logoHtml(P.logoUri, P.symbol || P.name); const n = tmp.firstElementChild; n.id = 'pjLogo'; logo.replaceWith(n); }
    const verifiedOp = !P.passport && P.registryOperator;
    const stateText = verifiedOp ? 'Verified operator · not synced' : UI.LABEL[syncState()];
    $('pjSub').innerHTML = `<span id="tokenDescription" class="sn-mono">$${esc(P.symbol)}</span><span class="sep" aria-hidden="true">·</span><span>${esc(P.originLabel)}</span><span class="sep" aria-hidden="true">·</span><span id="pjState">${UI.stateHtml(syncState(), stateText)}</span>`;
    $('pjAddress').textContent = P.token;
    $('pjCopy').setAttribute('data-copy-text', P.token);
    $('pjCopy').setAttribute('aria-label', 'Copy contract address');
    $('pjContract').hidden = false;
    const acts = [];
    if (P.tradeUrl) acts.push(`<a href="${esc(P.tradeUrl)}" target="_blank" rel="noreferrer">Trade on PAR ↗</a>`);
    acts.push(`<a href="https://robinhoodchain.blockscout.com/address/${esc(P.token)}" target="_blank" rel="noreferrer">View on explorer ↗</a>`);
    $('pjActions').innerHTML = acts.join('');
  }

  // ------------------------------------------------------------------ rows
  const rowHtml = (key, label, value, action, note, panel) => `<li class="pj-row" data-row="${key}"><span class="pj-row-k" id="row-${key}">${esc(label)}</span><div class="pj-row-v" aria-labelledby="row-${key}">${value}</div><div class="pj-row-a">${action || ''}</div>${note ? `<p class="pj-note">${note}</p>` : ''}${panel || ''}</li>`;

  function homeRow() {
    const cfg = S.home, st = S.homeStatus;
    if (!cfg || !cfg.enabled || !st) return '';
    const r = role(), t = P.token;
    const site = st.site, ent = st.entitlement, intent = st.openIntent;
    const entOk = ent && (ent.status === 'ACTIVE' || ent.status === 'FINALIZED');
    const published = site && site.state === 'PUBLISHED';
    const byCurrent = published && operator() && lc(site.signer) === operator();
    const edit = `/home-editor.html?token=${esc(t)}`;
    const open = `<a href="/site/${esc(t)}" target="_blank" rel="noopener">Open home ↗</a>`;
    if (ent && ent.status === 'INVALIDATED_BY_REORG') {
      return rowHtml('home', 'Home', 'Suspended<small>The activation payment left the canonical chain. The home is paused until the same payment is confirmed again.</small>', r === 'operator' ? `<a href="${edit}">Check status →</a>` : '');
    }
    if (published && entOk && byCurrent) return rowHtml('home', 'Home', 'Live<small>Signed by the current Passport operator.</small>', r === 'operator' ? `<a href="${edit}">Edit →</a>` : open, r === 'operator' ? open : '');
    if (published && entOk) {
      if (r === 'operator') return rowHtml('home', 'Home', 'Previous operator’s home<small>Published before you became the operator. Its links stay disabled until you review and adopt it.</small>', `<a class="sn-btn primary" href="${edit}&review=1">REVIEW &amp; ADOPT</a>`);
      return rowHtml('home', 'Home', 'Awaiting confirmation<small>Published by a previous operator. Links stay disabled until the current operator confirms it.</small>', open);
    }
    if (r !== 'operator') {
      if (r === 'eligible') return rowHtml('home', 'Home', 'Needs Sync<small>A Project Home belongs to the Passport operator. Sync the project first.</small>', '');
      return '';
    }
    if (site && site.state === 'UNPUBLISHED') return rowHtml('home', 'Home', 'Unpublished<small>Your last version is kept and can be published again.</small>', `<a href="${edit}">Edit →</a>`);
    if (entOk) return rowHtml('home', 'Home', 'Draft<small>Activated · not published yet.</small>', `<a class="sn-btn primary" href="${edit}">Edit &amp; publish</a>`);
    if (intent && intent.observed) return rowHtml('home', 'Home', 'Publishing<small>Payment seen · confirming on Robinhood Chain. You can leave this page.</small>', `<a href="${edit}&step=pay">Check status →</a>`);
    if (intent && intent.status === 'OPEN' && Date.parse(intent.expiresAt) > Date.now()) return rowHtml('home', 'Home', 'Needs payment<small>Your quote is locked until ' + esc(new Date(intent.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '.</small>', `<a href="${edit}&step=pay">Continue →</a>`);
    if (hasDraft(t)) return rowHtml('home', 'Home', 'Draft<small>Saved in this browser. Not published.</small>', `<a href="${edit}">Edit →</a>`);
    return rowHtml('home', 'Home', 'No home yet<small>A simple public page for this project, signed by you. Preview is free.</small>', `<a href="${edit}">Create home →</a>`);
  }

  function controlRow() {
    if (P.origin === 'UNAVAILABLE') return rowHtml('control', 'Control', 'Unknown<small>Robinhood Chain could not be read right now.</small>', '');
    const r = role();
    if (P.passport) {
      const since = String(P.passport.operatorSince || '').slice(0, 10);
      const who = r === 'operator' ? 'You are the operator' : `Operator <span class="sn-mono">${esc(short(P.passport.operator))}</span>`;
      return rowHtml('control', 'Control', `<span id="pjControlState">${UI.stateHtml('synced')}</span><small>${who}${since ? ` · since <span class="sn-mono">${esc(since)}</span>` : ''}</small>`,
        r === 'operator' ? `<a href="/marketplace.html#sell=${esc(P.token)}">Transfer →</a>` : '');
    }
    if (!P.claimable) {
      const why = P.origin === 'PONS_V1' ? 'Earlier Pons launches cannot hold a Project Passport.' : 'SyncNet can sync PAR and Pons V2 launches only.';
      return rowHtml('control', 'Control', `${UI.stateHtml('unclaimed')}<small>${esc(why)}</small>`, '');
    }
    const label = P.registryOperator ? 'Verified operator · not synced' : 'Unclaimed';
    if (r === 'eligible') {
      const basis = me() === P.deployer ? 'the on-chain deployer' : 'the creator-fee recipient';
      return rowHtml('control', 'Control', `<span id="pjControlState">${UI.stateHtml('unclaimed', label)}</span><small>Your wallet is ${basis}.</small>`,
        `<button class="sn-btn primary" type="button" id="syncProject"${S.market === false ? ' disabled aria-disabled="true"' : ''}>SYNC PROJECT</button>`, esc(S.market === false ? 'Syncing is paused right now. Try again later.' : SYNC_HELP));
    }
    if (me()) return rowHtml('control', 'Control', `${UI.stateHtml('unclaimed', label)}<small>Only the deployer or the creator-fee recipient wallet can sync this project.</small>`, '');
    return rowHtml('control', 'Control', `${UI.stateHtml('unclaimed', label)}<small>Is this your project? Connect the deployer or creator-fee recipient wallet.</small>`, '<button type="button" data-connect>Connect</button>');
  }

  function marketRow() {
    const l = P.listing, r = role();
    if (l && l.status === 'ACTIVE') return rowHtml('market', 'Market', `<span class="is-for-sale">For sale</span> · <span class="sn-num">${esc(l.price)} ${esc(l.currency)}</span><small>An operator-signed listing on the SyncNet Marketplace.</small>`, `<a href="/marketplace.html#listing=${esc(l.id)}">View listing →</a>`);
    if (l && l.status) return rowHtml('market', 'Market', `Listing · ${esc(String(l.status).replace(/_/g, ' ').toLowerCase())}`, `<a href="/marketplace.html#listing=${esc(l.id)}">View listing →</a>`);
    if (r === 'operator') return rowHtml('market', 'Market', 'Not listed<small>Sell control of this project through a two-party Marketplace transfer.</small>', `<a href="/marketplace.html#sell=${esc(P.token)}">List →</a>`);
    return '';
  }

  function connectionsRow() {
    const n = P.directMarkets || 0, u = P.usedBy || 0;
    if (!n && !u) return '';
    const parts = [];
    if (n) parts.push(`<span class="sn-num">${n}</span> direct market${n === 1 ? '' : 's'}`);
    if (u) parts.push(`used by <span class="sn-num">${u}</span> project${u === 1 ? '' : 's'}`);
    const hub = u >= HUB ? '<small>Network hub</small>' : '';
    const note = P.origin === 'PAR' ? `<a href="/build.html?with=${esc(P.token)}">Create a project connected to $${esc(P.symbol)} →</a>` : '';
    return rowHtml('connections', 'Connections', parts.join(' · ').replace(/^./, (c) => c.toUpperCase()) + hub, `<a href="/network.html?token=${esc(P.token)}">View network →</a>`, note);
  }

  function economyRow() {
    const e = S.economy;
    if (!e || (!e.curator && !(e.recognized && e.recognized.length))) return '';
    const n = (e.recognized || []).length;
    const who = e.curator && e.curator.address ? `Curated by <span class="sn-mono">${esc(short(e.curator.address))}</span>` : 'No curator yet';
    return rowHtml('economy', 'Economy', `<span class="sn-num">${n}</span> recognised project${n === 1 ? '' : 's'}<small>${who}</small>`, `<a href="/economy.html?root=${esc(P.token)}">View economy →</a>`);
  }

  function render() {
    if (!P || P.invalid || P.unavailable) return;
    renderHead();
    $('projectRows').innerHTML = [homeRow(), controlRow(), marketRow(), connectionsRow(), economyRow()].join('');
    const b = $('syncProject'); if (b) b.addEventListener('click', syncProject);
    document.querySelectorAll('#projectRows [data-connect]').forEach((x) => x.addEventListener('click', () => W.connect().catch((e) => status(e.message, 'bad'))));
  }

  // ------------------------------------------------------------------ SYNC PROJECT (Marketplace OperatorClaim)
  async function syncProject() {
    if (S.busy || !P) return;
    const account = me();
    if (!account) { await W.connect(); return; }
    const basis = account === P.deployer ? 'deployer' : account === P.feeRecipient ? 'fee-recipient' : '';
    if (!basis || P.passport) { render(); return; }
    S.busy = true;
    const btn = $('syncProject'); if (btn) btn.disabled = true;
    try {
      const message = { token: P.token, operator: account, basis, nonce: nonce(), expiry: Math.floor(Date.now() / 1000) + 900 };
      status('Sign in your wallet to verify control. This is a free signature, not a transaction.');
      let signature;
      try { signature = await W.signTyped(Market.typedData('OperatorClaim', message)); }
      catch (e) { throw new Error(e && (e.code === 4001 || /reject|denied/i.test(String(e.message))) ? 'You rejected the signature. Nothing was saved.' : 'The wallet could not sign: ' + String((e && e.message) || e).slice(0, 140)); }
      const head = document.querySelector('#pjState .sn-state'), ctl = document.querySelector('#pjControlState .sn-state');
      [head, ctl].forEach((el) => { if (el) { el.dataset.state = 'syncing'; el.querySelector('.sn-glyph').outerHTML = UI.glyph('syncing'); el.querySelector('span').textContent = 'Syncing'; } });
      status('Syncing… SyncNet is checking your wallet against the launch record.');
      const r = await postJson('/api/marketplace', { action: 'claim', ...message, signature });
      P.passport = { operator: r.passport.operator, operatorSince: r.passport.operatorSince, history: r.passport.history };
      await Promise.all([head, ctl].map((el) => UI.animateSync(el)));
      render();
      status('Synced. Your Project Passport is recorded. Nothing moved on-chain.', 'ok');
      loadHome();
    } catch (e) {
      render();
      status(e.message || 'Sync failed.', 'bad');
    } finally { S.busy = false; }
  }

  // ------------------------------------------------------------------ data
  async function loadHome() {
    try {
      const cfg = await getJson('/api/project-home?view=config');
      S.home = cfg;
      S.homeStatus = cfg.enabled ? await getJson('/api/project-home?view=status&token=' + P.token) : null;
    } catch { S.home = null; S.homeStatus = null; }
    render();
  }
  async function load() {
    const [mk, eco] = await Promise.all([
      getJson('/api/marketplace?view=config').then((j) => j.enabled !== false).catch(() => null),
      getJson('/api/economies?view=economy&root=' + P.token).catch(() => null),
    ]);
    S.market = mk; S.economy = eco;
    render();
    loadHome();
  }

  function onProject(d) {
    if (P || !d) return;
    P = d;
    if (d.invalid || d.unavailable) return;
    P.token = lc(d.token);
    render();
    load();
    if (W) W.onChange(() => render());
  }
  function init() {
    if (location.hash === '#details') { const d = $('projectDetails'); if (d) d.open = true; }
    window.addEventListener('syncnet:project', (e) => onProject(e.detail));
    if (window.__snProject) onProject(window.__snProject);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
