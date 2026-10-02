/*
 * Economics UI — fills every [data-econ] element from SyncNetEconomics (lib/syncnet-economics.js).
 * Used by /stats and the Explore economics strip. Public data only: no wallet, no secrets, no writes.
 *
 * Rules: an unknown value is "—" (never 0); loading is marked data-state="loading"; a failed source marks only the
 * figures that depend on it as data-state="error" so the rest of the page still renders.
 */
(function () {
  'use strict';
  const E = window.SyncNetEconomics;
  const nodes = Array.from(document.querySelectorAll('[data-econ]'));
  if (!E || !nodes.length) return;

  const UNIT = { burned: 'SYNC', net: 'NET', usdg: 'USDG', net24: 'NET', usdg24: 'USDG' };
  const SOURCE = { burned: 'chain', net: 'index', usdg: 'index', net24: 'index', usdg24: 'index' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function setNode(el, data) {
    const key = el.dataset.econ, v = data[key];
    if (!(key in UNIT)) return;
    const failed = data.errors[SOURCE[key]];
    if (v) {
      el.dataset.state = 'ready';
      el.innerHTML = esc(E.formatAmount(v)) + ' <span class="ec-unit">' + UNIT[key] + '</span>';
    } else {
      el.dataset.state = failed ? 'error' : 'unavailable';
      el.textContent = '—';
      el.title = failed ? 'Temporarily unavailable' : 'Not available';
    }
  }
  const rel = (sec) => {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
    return d < 90 ? 'just now' : d < 5400 ? Math.round(d / 60) + ' min ago' : d < 129600 ? Math.round(d / 3600) + ' h ago' : Math.round(d / 86400) + ' d ago';
  };
  const abs = (sec) => new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  function renderEvents(list, data) {
    const ul = document.getElementById('econRecent');
    if (!ul) return;
    if (data.errors.index) { ul.innerHTML = '<li class="ec-empty">Recent distributions are temporarily unavailable.</li>'; return; }
    const rows = data.events.slice(0, 8);
    ul.innerHTML = rows.length ? rows.map((e) => {
      const url = E.txUrl(e.txHash);
      return '<li><span class="ec-ev-kind">' + e.symbol + ' distributed</span><span class="ec-ev-amt mono">' + esc(E.formatUnits(e.amount, e.decimals)) + ' ' + e.symbol + '</span>'
        + '<time datetime="' + new Date(e.timestamp * 1000).toISOString() + '" title="' + abs(e.timestamp) + '">' + rel(e.timestamp) + '</time>'
        + (url ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer" aria-label="View ' + e.symbol + ' distribution transaction on the explorer">tx ↗</a>' : '<span></span>') + '</li>';
    }).join('') : '<li class="ec-empty">No recent NET or USDG distributions in the indexed window.</li>';
  }

  function render(data) {
    nodes.forEach((el) => setNode(el, data));
    document.querySelectorAll('[aria-busy]').forEach((el) => el.setAttribute('aria-busy', 'false'));
    renderEvents(null, data);
    const upd = document.getElementById('econUpdated');
    if (upd) {
      const t = new Date(data.fetchedAt);
      upd.textContent = (data.errors.chain && data.errors.index) ? 'Last updated: —' : 'Last updated ' + t.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    }
    const idx = document.getElementById('econIndexAsOf');
    if (idx) idx.textContent = data.lastAt ? 'Latest indexed distribution round: ' + abs(data.lastAt) + '.' : '';
    const status = document.getElementById('econStatus');
    if (status) {
      const down = [data.errors.chain && 'on-chain supply read', data.errors.index && 'PAR indexer'].filter(Boolean);
      status.hidden = !down.length;
      status.textContent = down.length ? 'Some figures are temporarily unavailable (' + down.join(' and ') + '). They show "—" instead of a number.' : '';
    }
  }

  nodes.forEach((el) => { el.dataset.state = 'loading'; el.textContent = '—'; });
  E.load().then(render);
  const retry = document.getElementById('econRetry');
  if (retry) retry.addEventListener('click', () => { nodes.forEach((el) => { el.dataset.state = 'loading'; el.textContent = '—'; }); E.load({ force: true }).then(render); });
})();
