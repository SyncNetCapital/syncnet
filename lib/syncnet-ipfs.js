/*
 * SyncNet IPFS display utility — the ONE way token/project images are rendered anywhere on SyncNet.
 *
 * DISPLAY ONLY. The stored/on-chain metadata is always the original ipfs://<CID> URI and is never
 * rewritten by this module; gateway URLs exist only inside <img src> attributes at render time.
 *
 * Fallback order for ipfs:// URIs (a browser <img> load can fail on any single gateway even when the
 * CID is pinned and valid — rate limits, regional blocks, in-wallet webviews):
 *   1. https://gateway.pinata.cloud/ipfs/<CID>   (SyncNet's pinning provider serves its own pins)
 *   2. https://ipfs.io/ipfs/<CID>
 *   3. https://dweb.link/ipfs/<CID>
 *   4. a deterministic inline SVG placeholder (never a broken-image icon)
 * The chain is driven by one capture-phase document error listener (installed by watch(), auto-run on
 * load), so it works for every image the pages insert, whenever they insert it.
 *
 * Non-IPFS values are never transformed: /assets/* and https:// pass through unchanged, everything
 * else (http://, javascript:, data:, malformed ipfs://) renders nothing / the placeholder.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncNetIpfs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GATEWAYS = Object.freeze(['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/']);
  // Display-shape check only (the authoritative CID validation lives in /api/ipfs-check). Strict enough
  // that no host, port, query, "..", "%" or whitespace can reach a gateway URL.
  const IPFS_RE = /^ipfs:\/\/([A-Za-z0-9]{20,120})((?:\/[A-Za-z0-9._~-]{1,100}){0,10})$/;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** ipfs://CID[/path] -> {cid, path} | null. Anything else -> null. */
  function parse(uri) {
    const m = IPFS_RE.exec(String(uri == null ? '' : uri).trim());
    return m ? { cid: m[1], path: m[2] || '' } : null;
  }

  function gatewaySrc(cidPath, index) {
    const i = Math.min(Math.max(index | 0, 0), GATEWAYS.length - 1);
    return GATEWAYS[i] + cidPath;
  }

  /**
   * The first display URL for any stored image value:
   *   ipfs://CID[/path] -> first gateway; /assets/... and https://... -> unchanged; anything else -> ''.
   */
  function display(value) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return '';
    if (v.startsWith('/assets/')) return v;
    const p = parse(v);
    if (p) return gatewaySrc(p.cid + p.path, 0);
    try {
      const u = new URL(v);
      return u.protocol === 'https:' ? u.href : '';
    } catch {
      return '';
    }
  }

  /** Deterministic inline-SVG placeholder (data: URI): same seed -> same tile, on-brand, never a broken icon. */
  function placeholder(seed, letter) {
    const s = String(seed || 'syncnet');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    const hue = 150 + (h % 120); // teal→cyan→blue band, matches the SyncNet accent language
    const ch = esc(String(letter || '').trim().charAt(0).toUpperCase() || '◆');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#000"/><rect x="3" y="3" width="90" height="90" fill="none" stroke="hsl(${hue},85%,55%)" stroke-width="2"/><rect x="12" y="12" width="${12 + (h % 24)}" height="4" fill="hsl(${hue},85%,55%)"/><text x="48" y="63" font-family="Arial,Helvetica,sans-serif" font-size="42" font-weight="700" fill="hsl(${hue},85%,62%)" text-anchor="middle">${ch}</text></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  /** Escaped <img> HTML with the fallback chain wired via data attributes. '' when the value renders nothing. */
  function imgHtml(value, opts) {
    const o = opts || {};
    const src = display(value);
    if (!src) return '';
    const p = parse(String(value == null ? '' : value).trim());
    const cls = o.className ? ` class="${esc(o.className)}"` : '';
    const ipfsAttrs = p ? ` data-ipfs="${esc(p.cid + p.path)}" data-ipfs-gw="0" data-ipfs-letter="${esc(String(o.letter || '').charAt(0))}"` : '';
    return `<img src="${esc(src)}" alt="${esc(o.alt || '')}"${cls}${ipfsAttrs}>`; // eager: the fallback chain must run even for images rendered into hidden panels
  }

  /** Wires an existing <img> element to the same fallback chain (builder previews). Hides it when nothing renders. */
  function bind(img, value, opts) {
    if (!img) return '';
    const o = opts || {};
    const src = display(value);
    delete img.dataset.ipfs; delete img.dataset.ipfsGw; delete img.dataset.ipfsFailed;
    if (!src) { img.removeAttribute('src'); return ''; }
    const p = parse(String(value == null ? '' : value).trim());
    if (p) { img.dataset.ipfs = p.cid + p.path; img.dataset.ipfsGw = '0'; img.dataset.ipfsLetter = String(o.letter || '').charAt(0); }
    img.src = src;
    return src;
  }

  let watching = null;
  /** One capture-phase error listener drives every gateway fallback + the final placeholder. */
  function watch(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || watching === d) return;
    watching = d;
    d.addEventListener('error', (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG' || !img.dataset || img.dataset.ipfs == null || img.dataset.ipfsFailed) return;
      const cidPath = img.dataset.ipfs;
      const next = (parseInt(img.dataset.ipfsGw, 10) || 0) + 1;
      if (next < GATEWAYS.length) {
        img.dataset.ipfsGw = String(next);
        img.src = gatewaySrc(cidPath, next);
        return;
      }
      // Every trusted gateway failed in this browser: deterministic placeholder, original URI untouched.
      img.dataset.ipfsFailed = '1';
      img.src = placeholder(cidPath, img.dataset.ipfsLetter);
      try { img.dispatchEvent(new CustomEvent('syncnet:ipfs-exhausted', { bubbles: true, detail: { cidPath } })); } catch { /* older browsers: placeholder already shown */ }
    }, true);
  }
  if (typeof document !== 'undefined') watch(document);

  return Object.freeze({ GATEWAYS, parse, display, placeholder, imgHtml, bind, watch });
});
