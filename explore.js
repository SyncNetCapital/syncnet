/*
 * Explore — the home page. Find a project; everything else happens on its Project Page.
 *
 * Rows keep independent dimensions apart:
 *   SYNC STATE   Unclaimed / Synced (a Project Passport exists)            — shape glyph + label
 *   MARKET       For sale (an ACTIVE operator-signed listing), Home live  — copper only for "For sale"
 *   CONNECTIONS  direct markets + projects using it as a market; "Network hub" when widely used
 * Data: PAR launch history (/api/par-launches-all), the reviewed Registry (/syncnet-projects.json), live Marketplace
 * listings, and batch Passport / Home state. Search never implies an on-chain action: it opens a Project Page.
 */
(function () {
  'use strict';
  const UI = window.SyncNetUI, Core = window.SyncNetCore;
  const $ = (id) => document.getElementById(id);
  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(lc(a));
  const disp = (v, n) => (Core ? Core.sanitizeForDisplay(String(v == null ? '' : v), { maxLength: n || 48 }) : String(v || '').slice(0, n || 48));
  const esc = UI.esc;
  const HUB = 3; // used as a market by at least this many launches → "Network hub"
  const PAGE = 30;
  const NEW_DAYS = 7;
  const state = { rows: new Map(), passports: {}, homes: {}, filter: 'all', q: '', shown: PAGE, loaded: false, error: '' };

  const rowsOf = (b) => { if (Array.isArray(b)) return b; for (const k of ['launches', 'items', 'data', 'rows', 'results']) if (Array.isArray(b && b[k])) return b[k]; return []; };
  const tokenOf = (x) => lc((x && (x.token || x.tokenAddress || x.address)) || '');
  const marketsOf = (x) => (Array.isArray(x && x.markets) && x.markets.length ? x.markets : x && (x.pairToken || x.quoteToken) ? [x] : []);
  const pairOf = (m) => lc((m && (m.pairToken || m.quoteToken || m.pairTokenAddress || m.quoteTokenAddress)) || '');
  const logoOk = (v) => { const s = String(v || '').trim(); return /^ipfs:\/\//.test(s) || s.startsWith('/assets/') ? s : ''; };
  const time = (v) => { const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v); return Number.isFinite(t) ? t : 0; };
  async function getJson(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }

  function upsert(token, patch) {
    if (!isAddr(token)) return null;
    const cur = state.rows.get(token) || { token, name: '', symbol: '', origin: '', logo: '', createdAt: 0, markets: [], usedBy: 0, listing: null, featured: false };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) cur[k] = v;
    state.rows.set(token, cur);
    return cur;
  }

  async function load() {
    const [launches, registry, listings] = await Promise.all([
      getJson('/api/par-launches-all').then(rowsOf).catch(() => []),
      getJson('/syncnet-projects.json').then((j) => (Array.isArray(j.projects) ? j.projects : [])).catch(() => []),
      getJson('/api/marketplace?view=listings').then((j) => (Array.isArray(j.listings) ? j.listings : [])).catch(() => []),
    ]);
    const usedBy = new Map();
    for (const l of launches) {
      const t = tokenOf(l);
      if (!isAddr(t)) continue;
      const pairs = marketsOf(l).map(pairOf).filter(isAddr);
      for (const p of pairs) usedBy.set(p, (usedBy.get(p) || 0) + 1);
      upsert(t, { name: disp(l.name || l.tokenName, 48), symbol: disp(l.symbol || l.tokenSymbol, 16).replace(/^\$/, '').toUpperCase(), origin: 'PAR', logo: logoOk(l.logoUrl || l.logo), createdAt: time(l.createdAt), markets: pairs });
    }
    for (const p of registry) {
      const t = lc(p.token);
      if (!isAddr(t) || !(p.registry && p.registry.canonical !== false)) continue;
      upsert(t, { name: disp((p.profile && p.profile.name) || p.name, 48), symbol: disp(p.symbol, 16).toUpperCase(), logo: logoOk(p.profile && p.profile.image), featured: true });
    }
    for (const l of listings) {
      if (l.status !== 'ACTIVE') continue;
      const s = l.snapshot || {};
      upsert(lc(l.token), { name: disp(s.name, 48), symbol: disp(s.symbol, 16).toUpperCase(), logo: logoOk(s.logo), origin: (l.origin && l.origin.label) || 'PAR', listing: { id: l.id, price: l.price, currency: l.currency } });
    }
    for (const [t, n] of usedBy) { const r = state.rows.get(t); if (r) r.usedBy = n; }
    state.loaded = true;
    state.degraded = !launches.length;
    await enrich(pool());
  }

  /** Candidate rows for the current filter/search (before sync-state enrichment). */
  function pool() {
    const all = [...state.rows.values()].filter((r) => r.name || r.symbol);
    if (state.q) {
      const q = lc(state.q).replace(/^\$/, '');
      return all.filter((r) => lc(r.symbol).includes(q) || lc(r.name).includes(q))
        .sort((a, b) => (lc(b.symbol) === q) - (lc(a.symbol) === q) || (lc(b.name) === q) - (lc(a.name) === q) || b.createdAt - a.createdAt).slice(0, 60);
    }
    return all.sort((a, b) => b.featured - a.featured || Boolean(b.listing) - Boolean(a.listing) || b.createdAt - a.createdAt).slice(0, 200);
  }

  /** Batch Passport + Home state for rows we have not asked about yet. Failure leaves rows Unclaimed-unknown (never guessed). */
  async function enrich(rows) {
    const need = rows.map((r) => r.token).filter((t) => !(t in state.passports));
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      const [pp, hh] = await Promise.all([
        getJson('/api/marketplace?view=passports&tokens=' + chunk.join(',')).catch(() => null),
        getJson('/api/project-home?view=homes&tokens=' + chunk.join(',')).catch(() => null),
      ]);
      for (const t of chunk) {
        state.passports[t] = pp && pp.passports ? pp.passports[t] || null : undefined;
        if (hh && hh.homes && hh.homes[t]) state.homes[t] = hh.homes[t];
      }
    }
  }

  function visible() {
    let rows = pool();
    const synced = (r) => Boolean(state.passports[r.token]);
    if (!state.q) {
      if (state.filter === 'synced') rows = rows.filter(synced);
      else if (state.filter === 'sale') rows = rows.filter((r) => r.listing);
      else if (state.filter === 'new') { const cut = Date.now() - NEW_DAYS * 864e5; const recent = rows.filter((r) => r.createdAt >= cut); rows = (recent.length ? recent : rows.filter((r) => r.createdAt)).sort((a, b) => b.createdAt - a.createdAt); }
      else rows = rows.slice().sort((a, b) => b.featured - a.featured || synced(b) - synced(a) || Boolean(b.listing) - Boolean(a.listing) || b.createdAt - a.createdAt);
    }
    return rows;
  }

  function rowHtml(r) {
    const passport = state.passports[r.token];
    const syncState = passport ? 'synced' : 'unclaimed';
    const home = state.homes[r.token];
    const conn = (r.markets ? r.markets.length : 0) + (r.usedBy || 0);
    const hub = r.usedBy >= HUB;
    const market = [r.listing ? '<span class="sn-copper">For sale</span>' : '', home && home.state === 'live' ? 'Home live' : ''].filter(Boolean).join(' · ');
    const connText = hub ? `Network hub · <span class="sn-num">${conn}</span>` : conn ? `<span class="sn-num">${conn}</span>` : '—';
    const mobileFacts = [r.listing ? '<span class="sn-copper">For sale</span>' : '', home && home.state === 'live' ? 'Home live' : '', hub ? 'Network hub' : conn ? `${conn} connection${conn === 1 ? '' : 's'}` : ''].filter(Boolean).slice(0, 2).join(' · ');
    const name = r.name || r.symbol || UI.short(r.token);
    const letter = (r.symbol || r.name || '·').charAt(0);
    const label = `${name}${r.symbol ? ' ($' + r.symbol + ')' : ''}, ${UI.LABEL[syncState]}${r.listing ? ', for sale' : ''}`;
    return `<li><a class="sn-row" href="/project/${esc(r.token)}" aria-label="${esc(label)}">
<span class="sn-proj">${UI.logoHtml(r.logo, letter)}<span class="sn-m-main"><span class="sn-proj-name">${esc(name)}</span>${r.symbol ? `<span class="sn-proj-ticker">$${esc(r.symbol)}</span>` : ''}${r.origin ? `<span class="sn-proj-origin sn-d-col">${esc(r.origin)}</span>` : ''}
<span class="sn-m-only">${UI.stateHtml(syncState)}</span>${mobileFacts ? `<span class="sn-m-only sn-small sn-dim">${mobileFacts}</span>` : ''}</span></span>
<span class="sn-d-col">${UI.stateHtml(syncState)}</span>
<span class="sn-cell sn-d-col">${market || '<span class="sn-muted">—</span>'}</span>
<span class="sn-cell sn-d-col">${connText}</span>
<span class="sn-chev" aria-hidden="true">›</span></a></li>`;
  }

  function render() {
    const list = $('exploreList'), more = $('exploreMore'), st = $('exploreStatus');
    if (!state.loaded) return;
    const rows = visible();
    if (!rows.length) {
      const why = state.q ? (UI.isAddr(state.q) ? 'Press → to open this contract.' : `No project matches “${esc(disp(state.q, 40))}”. Try the full contract address.`)
        : state.filter === 'sale' ? 'Nothing is listed for sale right now.' : state.filter === 'synced' ? 'No synced projects to show yet.' : state.degraded ? 'Project history is temporarily unavailable. Search by contract still works.' : 'No projects to show.';
      list.innerHTML = `<li class="sn-empty">${why}</li>`;
      more.hidden = true;
    } else {
      list.innerHTML = rows.slice(0, state.shown).map(rowHtml).join('');
      more.hidden = rows.length <= state.shown;
    }
    st.textContent = state.q ? `${rows.length} result${rows.length === 1 ? '' : 's'} for “${disp(state.q, 40)}”` : state.degraded ? 'PAR launch history is temporarily unavailable; showing recorded and listed projects.' : '';
  }

  function setFilter(f, push) {
    state.filter = f; state.shown = PAGE;
    document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === f)));
    if (push) {
      const url = f === 'sale' ? '/for-sale' : f === 'all' ? '/' : '/?view=' + f;
      history.replaceState(null, '', url);
    }
    render();
  }

  let timer = null;
  async function onQuery(q) {
    state.q = q.trim(); state.shown = PAGE;
    if (!UI.isAddr(state.q)) { await enrich(pool()); }
    render();
  }

  function init() {
    const form = $('exploreSearch'), input = $('exploreQ');
    const params = new URLSearchParams(location.search);
    const initial = params.get('q') || '';
    const view = location.pathname === '/for-sale' ? 'sale' : params.get('view');
    if (['synced', 'sale', 'new'].includes(view)) setFilter(view, false);
    document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { input.value = ''; state.q = ''; setFilter(b.dataset.filter, true); }));
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => onQuery(input.value), 160); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) { input.focus(); return; }
      if (UI.isAddr(q)) { location.href = '/project/' + lc(q); return; }
      await onQuery(q);
      const rows = visible();
      if (rows.length === 1) location.href = '/project/' + rows[0].token;
      else { const first = $('exploreList').querySelector('a'); if (first) first.focus(); }
    });
    $('exploreMore').addEventListener('click', () => { state.shown += PAGE; render(); });
    if (initial) input.value = initial;
    if (params.get('find')) input.focus(); // from My Projects: "+ Find another project"
    load().then(() => (initial ? onQuery(initial) : render())).catch(() => { state.loaded = true; state.degraded = true; render(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
