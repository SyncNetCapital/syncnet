/*
 * SyncNet UI helpers shared by every page: the sync-state glyph, the top-bar wallet control, current-page marking,
 * copy buttons and small formatting helpers. Plain script, no framework.
 *
 * SYNC STATE answers exactly one question — what is this project's control state? — with three values:
 *   UNCLAIMED  two parallel lines (not converged)
 *   SYNCING    two lines converging (only while a sync is actually in progress)
 *   SYNCED     one resulting line
 * The SHAPE carries the state; colour never does. Other dimensions (for sale, home live, network hub) are separate.
 */
(function () {
  'use strict';
  const GLYPH = {
    unclaimed: '<path d="M1.5 3.2H16.5"/><path d="M1.5 8.8H16.5"/>',
    syncing: '<path d="M1.5 3H5.5C8.5 3 9 5.4 11.4 5.6"/><path d="M1.5 9H5.5C8.5 9 9 6.6 11.4 6.4"/><path d="M13.6 6H16.5"/>',
    synced: '<path class="is-strong" d="M1.5 6H16.5"/>',
  };
  const LABEL = { unclaimed: 'Unclaimed', syncing: 'Syncing', synced: 'Synced' };
  function glyph(stateName, cls) {
    const s = GLYPH[stateName] ? stateName : 'unclaimed';
    return `<svg class="sn-glyph${cls ? ' ' + cls : ''}" viewBox="0 0 18 12" aria-hidden="true" focusable="false" data-glyph="${s}">${GLYPH[s]}</svg>`;
  }
  function stateHtml(stateName, text) {
    const s = GLYPH[stateName] ? stateName : 'unclaimed';
    return `<span class="sn-state" data-state="${s}">${glyph(s)}<span>${esc(text || LABEL[s])}</span></span>`;
  }
  /** The ceremonial transition when a project actually becomes SYNCED: two lines → converging → one line. */
  function animateSync(el) {
    if (!el) return Promise.resolve();
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const set = (s) => { const svg = el.querySelector('.sn-glyph'); if (svg) { svg.innerHTML = GLYPH[s]; svg.dataset.glyph = s; } el.dataset.state = s; const t = el.querySelector('span'); if (t) t.textContent = LABEL[s]; };
    if (reduce) { set('synced'); return Promise.resolve(); }
    set('syncing');
    return new Promise((r) => setTimeout(() => { set('synced'); r(); }, 650));
  }

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (a) => (/^0x[0-9a-fA-F]{40}$/.test(String(a || '')) ? String(a).slice(0, 6) + '…' + String(a).slice(-4) : String(a || ''));
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim());
  /** Neutral logo fallback: the project's own initial, never the SyncNet mark. */
  function logoHtml(uri, letter, cls) {
    const Ipfs = window.SyncNetIpfs;
    const img = uri && Ipfs ? Ipfs.imgHtml(uri, { letter, alt: '' }) : '';
    return `<span class="sn-logo${cls ? ' ' + cls : ''}" aria-hidden="true">${img || esc(String(letter || '·').charAt(0).toUpperCase())}</span>`;
  }

  // ---- top bar
  function markCurrent() {
    const p = location.pathname;
    const key = p === '/' || p === '/index.html' || p === '/for-sale' || p.startsWith('/project/') || p.startsWith('/token/') || p === '/network.html' ? 'explore'
      : p === '/build.html' ? 'create' : p === '/you.html' || p === '/home-editor.html' ? 'you' : '';
    document.querySelectorAll('[data-nav]').forEach((a) => { if (a.dataset.nav === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  }
  function wireWallet() {
    const W = window.SyncNetWallet;
    const btn = document.querySelector('[data-wallet]');
    const you = document.querySelector('.sn-nav .sn-you');
    if (!W || !btn) return;
    W.onChange((s) => {
      if (s.connected) {
        btn.innerHTML = `<span class="sn-mono">${esc(short(s.account))}</span>`;
        btn.setAttribute('aria-label', 'Wallet ' + s.account + ' — open My Projects');
        btn.dataset.connected = 'true';
        if (you) you.hidden = false;
      } else {
        btn.textContent = 'Connect';
        btn.removeAttribute('aria-label');
        btn.dataset.connected = 'false';
        if (you) you.hidden = true;
      }
    });
    btn.addEventListener('click', async () => {
      if (W.state().connected) { location.href = '/you.html'; return; }
      try { await W.connect(); } catch (e) { alertInline(e.message || 'The wallet did not connect.'); }
    });
  }
  function alertInline(msg) {
    let el = document.getElementById('snTopNote');
    if (!el) { el = document.createElement('div'); el.id = 'snTopNote'; el.setAttribute('role', 'status'); el.className = 'sn-wrap sn-small sn-dim'; el.style.padding = '10px 0'; document.querySelector('.sn-top')?.after(el); }
    el.textContent = msg;
  }
  function wireCopy() {
    document.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-copy-text]');
      if (!b) return;
      try { await navigator.clipboard.writeText(b.getAttribute('data-copy-text')); const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = t; }, 1200); } catch { /* clipboard may be unavailable */ }
    });
  }
  function wireTopSearch() {
    const f = document.querySelector('.sn-top-search');
    if (!f) return;
    f.addEventListener('submit', (e) => {
      const q = f.querySelector('input').value.trim();
      if (isAddr(q)) { e.preventDefault(); location.href = '/project/' + q.toLowerCase(); }
      else if (!q) e.preventDefault();
    });
  }
  function init() { markCurrent(); wireWallet(); wireCopy(); wireTopSearch(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.SyncNetUI = Object.freeze({ glyph, stateHtml, animateSync, esc, short, isAddr, logoHtml, LABEL });
})();
