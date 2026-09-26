/*
 * You / My Projects — the projects this wallet operates (current Project Passport operator) and the PAR launches it
 * can sync (on-chain deployer or creator-fee recipient with no Passport yet). Discovered automatically; nothing is
 * typed in. One status and one next action per row. Reads only: every action happens on the Project Page, the
 * Project Home editor or the Marketplace, where the server re-verifies it.
 */
(function () {
  'use strict';
  const UI = window.SyncNetUI, W = window.SyncNetWallet, Chain = window.SyncNetChain, Core = window.SyncNetCore;
  const $ = (id) => document.getElementById(id);
  const esc = UI.esc, short = UI.short;
  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(lc(a));
  const SYNC = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
  const disp = (v, n) => (Core ? Core.sanitizeForDisplay(String(v == null ? '' : v), { maxLength: n || 48 }) : String(v || '').slice(0, n || 48));
  const logoOk = (v) => { const s = String(v || '').trim(); return /^ipfs:\/\//.test(s) || s.startsWith('/assets/') ? s : ''; };
  const rowsOf = (b) => { if (Array.isArray(b)) return b; for (const k of ['launches', 'items', 'data', 'rows', 'results']) if (Array.isArray(b && b[k])) return b[k]; return []; };
  async function getJson(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
  const status = (m, tone) => { const el = $('youStatus'); el.textContent = m || ''; if (tone) el.dataset.tone = tone; else delete el.dataset.tone; };
  const rpc = Chain ? Chain.makeRpc(Chain.ROBINHOOD.rpcUrl, { timeoutMs: 8000, retries: 1 }) : null;
  let seq = 0;

  function fmtSync(wei) {
    try { const w = BigInt(wei || 0); const i = w / 10n ** 18n; const f = ((w % 10n ** 18n) / 10n ** 16n).toString().padStart(2, '0'); return i.toLocaleString('en-US') + '.' + f; } catch { return '—'; }
  }

  function renderWallet(s) {
    const box = $('youWallet');
    if (!s.connected) {
      box.innerHTML = '<p class="sn-lede">Connect a wallet to see the projects you operate and the ones you can sync.</p><p style="margin:20px 0 0"><button class="sn-btn primary" type="button" id="youConnect">Connect</button></p><p class="sn-small sn-muted" style="margin:12px 0 0">Connecting shares your address only. Nothing is signed or sent.</p>';
      $('youConnect').addEventListener('click', () => W.connect().catch((e) => status(e.message, 'bad')));
      $('youListWrap').hidden = true;
      status('');
      return;
    }
    box.innerHTML = `<dl class="sn-kv you-kv"><dt>Wallet</dt><dd><span class="sn-mono">${esc(s.account)}</span></dd><dt>$SYNC</dt><dd><span class="sn-mono" id="youSync">…</span></dd></dl><p style="margin:10px 0 0"><button class="sn-textbtn sn-small" type="button" id="youDisconnect">Disconnect</button></p>`;
    $('youDisconnect').addEventListener('click', () => W.disconnect());
    if (rpc) Chain.readBalance(rpc, SYNC, s.account).then((b) => { const el = $('youSync'); if (el) el.textContent = b == null ? '—' : fmtSync(b); }).catch(() => { const el = $('youSync'); if (el) el.textContent = '—'; });
  }

  /** The single next step for a project, most urgent first. */
  function decide(it, homeOn) {
    const t = esc(it.token), h = it.home, editor = `/home-editor.html?token=${t}`;
    if (!it.passport) return { state: 'unclaimed', text: 'Unclaimed · you can sync it', action: `<a href="/project/${t}">Sync project →</a>` };
    if (h && h.state === 'awaiting') return { state: 'synced', text: 'Home needs your review', action: `<a class="sn-btn primary" href="${editor}&review=1">REVIEW &amp; ADOPT</a>` };
    if (it.listing) return { state: 'synced', text: `<span class="sn-copper">For sale</span> · <span class="sn-num">${esc(it.listing.price)} ${esc(it.listing.currency)}</span>`, action: `<a href="/marketplace.html#listing=${esc(it.listing.id)}">View listing →</a>` };
    if (h && h.state === 'paused') return { state: 'synced', text: 'Home suspended', action: `<a href="${editor}">Check status →</a>` };
    if (h && h.state === 'live') return { state: 'synced', text: 'Synced · Home live', action: `<a href="${editor}">Edit home →</a>` };
    if (h && h.state === 'unpublished') return { state: 'synced', text: 'Synced · Home unpublished', action: `<a href="${editor}">Edit home →</a>` };
    if (h && h.activated) return { state: 'synced', text: 'Synced · Home activated', action: `<a href="${editor}">Publish home →</a>` };
    if (homeOn) return { state: 'synced', text: 'Synced', action: `<a href="${editor}">Create home →</a>` };
    return { state: 'synced', text: 'Synced', action: `<a href="/project/${t}">Open →</a>` };
  }

  function render(items, homeOn) {
    const list = $('youList');
    $('youListWrap').hidden = false;
    if (!items.length) {
      list.innerHTML = '<li class="sn-empty">No projects found for this wallet yet. Find a project you operate, or create a new one.</li>';
      return;
    }
    list.innerHTML = items.map((it) => {
      const d = decide(it, homeOn);
      const name = it.name || it.symbol || short(it.token);
      return `<li class="you-row" data-token="${esc(it.token)}"><a class="sn-proj" href="/project/${esc(it.token)}">${UI.logoHtml(it.logo, it.symbol || it.name)}<span class="sn-m-main"><span class="sn-proj-name">${esc(name)}</span>${it.symbol ? `<span class="sn-proj-ticker">$${esc(it.symbol)}</span>` : ''}</span></a>
<span class="you-status" data-state="${d.state}">${UI.glyph(d.state)}<span class="you-status-text">${d.text}</span></span><span class="you-action">${d.action}</span></li>`;
    }).join('');
  }

  async function load(account) {
    const my = ++seq;
    status('Finding your projects…');
    const [wallet, launches, homeCfg] = await Promise.all([
      getJson('/api/marketplace?view=wallet&address=' + account).catch(() => null),
      getJson('/api/par-launches-all').then(rowsOf).catch(() => []),
      getJson('/api/project-home?view=config').catch(() => null),
    ]);
    if (my !== seq) return;
    const items = new Map();
    const put = (t, patch) => { const cur = items.get(t) || { token: t, name: '', symbol: '', logo: '', passport: null, listing: null, home: null, eligible: false }; for (const [k, v] of Object.entries(patch)) if (v) cur[k] = v; items.set(t, cur); return cur; };
    for (const p of (wallet && wallet.passports) || []) put(lc(p.token), { passport: p });
    const meta = new Map();
    for (const l of launches) {
      const t = lc(l.token || l.tokenAddress || l.address);
      if (!isAddr(t)) continue;
      meta.set(t, { name: disp(l.name || l.tokenName, 48), symbol: disp(l.symbol || l.tokenSymbol, 16).replace(/^\$/, '').toUpperCase(), logo: logoOk(l.logoUrl || l.logo) });
      if (lc(l.deployer) === account || lc(l.creatorFeeRecipient || l.feeRecipient) === account) put(t, { eligible: true });
    }
    // Launches this wallet could sync: keep only those with no Passport yet (an existing operator is not "yours").
    const unknown = [...items.values()].filter((i) => !i.passport).map((i) => i.token);
    for (let k = 0; k < unknown.length; k += 100) {
      const pp = await getJson('/api/marketplace?view=passports&tokens=' + unknown.slice(k, k + 100).join(',')).catch(() => null);
      if (!pp) { status('Some projects could not be checked right now.', 'warn'); break; }
      for (const t of unknown.slice(k, k + 100)) { const p = pp.passports && pp.passports[t]; if (p) { if (lc(p.operator) === account) items.get(t).passport = p; else items.delete(t); } }
    }
    for (const l of (wallet && wallet.listings) || []) if (l.status === 'ACTIVE' && items.has(lc(l.token))) items.get(lc(l.token)).listing = l;
    const synced = [...items.values()].filter((i) => i.passport).map((i) => i.token);
    const homeOn = Boolean(homeCfg && homeCfg.enabled);
    if (homeOn && synced.length) {
      const hh = await getJson('/api/project-home?view=homes&tokens=' + synced.slice(0, 100).join(',')).catch(() => null);
      for (const t of synced) if (hh && hh.homes && hh.homes[t]) items.get(t).home = hh.homes[t];
    }
    for (const it of items.values()) { const m = meta.get(it.token); if (m) Object.assign(it, { name: it.name || m.name, symbol: it.symbol || m.symbol, logo: it.logo || m.logo }); }
    const missing = [...items.values()].filter((i) => !i.name && !i.symbol).slice(0, 12);
    if (rpc) await Promise.all(missing.map(async (it) => { try { const m = await Chain.readTokenMetadata(rpc, it.token); it.name = disp(m.name, 48); it.symbol = disp(m.symbol, 16).toUpperCase(); } catch { /* shown by address */ } }));
    if (my !== seq) return;
    const sorted = [...items.values()].sort((a, b) => Boolean(b.passport) - Boolean(a.passport) || lc(a.name || a.symbol).localeCompare(lc(b.name || b.symbol)));
    render(sorted, homeOn);
    if (!wallet) status('The Marketplace could not be reached, so synced projects may be missing. Try again shortly.', 'warn');
    else if (!/could not/.test($('youStatus').textContent)) status('');
  }

  function init() {
    let last = '';
    W.onChange((s) => {
      renderWallet(s);
      const a = s.connected ? lc(s.account) : '';
      if (a && a !== last) load(a);
      last = a;
      if (!a) seq++;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
