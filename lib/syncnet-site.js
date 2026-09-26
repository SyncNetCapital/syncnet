/*
 * SyncNet Project Home — shared site module (browser + Netlify functions).
 *
 * One source of truth for the V1 content schema, normalize()/validate(), the canonical config serialization and its
 * configHash, the EIP-712 domain and types, and the PURE renderer. The browser signs exactly what the server verifies,
 * and the server renders exactly what was signed.
 *
 *   EIP-712 domain: { name: 'SyncNet Website', version: '1', chainId: 4663 }
 *   — deliberately NOT the Marketplace domain ('SyncNet Marketplace'): no Marketplace or Economy signature can be
 *   replayed here, and none of these can be replayed there (different domain separator AND different type hashes).
 *
 * Authority: a Project Home is written ONLY by the CURRENT Project Passport operator (checked at write time) and is
 * rendered as operator-verified ONLY while its signer is still the current operator (checked at render time).
 * Payment (entitlement) and signature (content authorisation) are separate concepts; nothing here involves funds.
 *
 * Content model V1: fixed presets, fixed accent palette, fixed section order, plain text only, one CTA with a fixed
 * label and an https destination, social HANDLES (SyncNet builds the URLs), sanitised-image CIDs only. No HTML,
 * Markdown, CSS, JS, iframes, embeds, SVG or remote images — the renderer emits zero JavaScript and no inline styles.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./syncnet-core.js'));
  else root.SyncNetSite = factory(root.SyncNetCore);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';
  if (!Core) throw new Error('SyncNetSite requires SyncNetCore.');

  const CHAIN_ID = 4663;
  const SCHEMA = 'syncnet.site.v1';
  const DOMAIN = Object.freeze({ name: 'SyncNet Website', version: '1', chainId: CHAIN_ID });
  const EIP712_DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }];
  const TYPES = Object.freeze({
    SitePublish: [
      { name: 'token', type: 'address' }, { name: 'operator', type: 'address' }, { name: 'configHash', type: 'bytes32' },
      { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
    SiteUnpublish: [
      { name: 'token', type: 'address' }, { name: 'operator', type: 'address' },
      { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
    // Authenticates "the current operator asks for a Project Home activation quote". Grants nothing by itself.
    ActivationRequest: [
      { name: 'token', type: 'address' }, { name: 'operator', type: 'address' },
      { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  });
  const MAX_SKEW = 300; // seconds between a signed issuedAt and the server clock

  const AUTHORITY_LABEL = 'SYNCED WEBSITE · PASSPORT OPERATOR VERIFIED';
  const PREVIOUS_LABEL = 'PUBLISHED BY PREVIOUS OPERATOR · AWAITING CONFIRMATION';
  const PREVIEW_LABEL = 'PREVIEW · NOT PUBLISHED';

  const PRESETS = Object.freeze(['CLEAN', 'DARK', 'TERMINAL']);
  const ACCENTS = Object.freeze(['BLUE', 'GREEN', 'AMBER', 'RED', 'VIOLET', 'SLATE']);
  const CTA_LABELS = Object.freeze(['TRADE', 'BUY', 'VIEW APP', 'READ DOCS', 'JOIN COMMUNITY', 'LEARN MORE']);
  const SECTIONS = Object.freeze(['hero', 'about', 'tokenFacts', 'origin', 'socials', 'passport']); // fixed order
  const SOCIALS = Object.freeze({
    x: { label: 'X', re: /^[A-Za-z0-9_]{1,15}$/, url: (h) => 'https://x.com/' + h },
    telegram: { label: 'Telegram', re: /^[A-Za-z][A-Za-z0-9_]{4,31}$/, url: (h) => 'https://t.me/' + h },
    discord: { label: 'Discord', re: /^[A-Za-z0-9-]{2,32}$/, url: (h) => 'https://discord.gg/' + h },
    farcaster: { label: 'Farcaster', re: /^[a-z0-9][a-z0-9-]{0,15}(?:\.eth)?$/, url: (h) => 'https://farcaster.xyz/' + h },
  });
  const LIMITS = Object.freeze({ headline: 80, about: 800, url: 300 });
  const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})$/; // same shape the uploader pins
  const KEYS = Object.freeze(['schema', 'token', 'preset', 'accent', 'headline', 'about', 'logoCid', 'heroCid', 'socials', 'cta', 'sections']);
  // Operator text may not claim an authority SyncNet never grants (matched on confusable skeletons).
  const RESERVED_CLAIMS = Object.freeze(['officialwebsite', 'officialsite', 'verifiedbysyncnet', 'syncnetverified', 'passportoperatorverified', 'syncnetofficial', 'officialsyncnet']);

  const isPlainObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
  const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || ''));
  const lc = (v) => String(v == null ? '' : v).toLowerCase();

  // ------------------------------------------------------------------ canonical serialization + hashing
  function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  const configHash = (config) => Core.keccak256Utf8(canonicalJson(config));

  function typedData(kind, message) {
    if (!TYPES[kind]) throw new Error('unknown SyncNet Website structure: ' + kind);
    return { types: { EIP712Domain: EIP712_DOMAIN, [kind]: TYPES[kind] }, primaryType: kind, domain: { ...DOMAIN }, message };
  }
  const digest = (kind, message) => Core.hashTypedData(typedData(kind, message));

  // ------------------------------------------------------------------ field policies
  function text(value, max, multiline, field, errors) {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') { errors.push({ field, code: 'type' }); return ''; }
    if (value.length > max * 4 + 64) { errors.push({ field, code: 'too_long' }); return ''; }
    // Unsafe characters are refused BEFORE whitespace normalisation (which would silently turn e.g. U+FEFF into a space).
    if (Core.findUnsafeChars(value.normalize('NFC').replace(/\r\n?/g, '\n'), { multiline: true }).length) { errors.push({ field, code: 'unsafe_chars' }); return ''; }
    let s = Core.normalizeText(value, { multiline });
    if (multiline) s = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n');
    if (Core.findUnsafeChars(s, { multiline }).length) { errors.push({ field, code: 'unsafe_chars' }); return ''; }
    if (Array.from(s).length > max) { errors.push({ field, code: 'too_long' }); return ''; }
    const sk = Core.confusableSkeleton(s);
    if (RESERVED_CLAIMS.some((c) => sk.includes(c))) { errors.push({ field, code: 'reserved_claim' }); return ''; }
    return s;
  }

  const RESERVED_HOST = /(^|\.)(localhost|local|internal|lan|home\.arpa|onion|test|example|invalid|intranet|corp)$/;
  /**
   * The only external-URL policy: https, ASCII only (an IDN must be entered in its xn-- form and is DISPLAYED in that
   * form), a public DNS name (no IP literal, no userinfo, no port, no reserved suffix), <= 300 characters.
   * Returns {ok, href (canonical), host, idn} or {ok:false, code}.
   */
  function checkUrl(input) {
    if (typeof input !== 'string') return { ok: false, code: 'type' };
    const s = input.trim();
    if (!s || s.length > LIMITS.url) return { ok: false, code: 'length' };
    if (/[^\x21-\x7e]/.test(s)) return { ok: false, code: 'non_ascii' }; // spaces, controls, bidi, zero-width, raw Unicode
    if (!/^https:\/\/[^/]/i.test(s)) return { ok: false, code: 'https_only' }; // javascript:, data:, http:, //host
    let u;
    try { u = new URL(s); } catch { return { ok: false, code: 'unparseable' }; }
    if (u.protocol !== 'https:') return { ok: false, code: 'https_only' };
    if (u.username || u.password || /@/.test(s.slice(8).split(/[/?#]/)[0])) return { ok: false, code: 'userinfo' };
    if (u.port !== '' || /^https:\/\/[^/?#]*:/i.test(s)) return { ok: false, code: 'port' };
    const host = u.hostname;
    if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false, code: 'ip_literal' };
    const labels = host.split('.');
    if (host.length > 253 || labels.length < 2) return { ok: false, code: 'host' };
    if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return { ok: false, code: 'host' };
    const tld = labels[labels.length - 1];
    if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]{1,59}$/.test(tld)) return { ok: false, code: 'host' };
    if (RESERVED_HOST.test(host)) return { ok: false, code: 'reserved_host' };
    if (u.href.length > LIMITS.url || /[^\x21-\x7e]/.test(u.href)) return { ok: false, code: 'length' };
    return { ok: true, href: u.href, host, idn: labels.some((l) => l.startsWith('xn--')) };
  }

  /**
   * normalize(input) -> {ok, config, errors}. The config is the canonical V1 object: unknown keys are REJECTED (never
   * silently dropped), every value is normalized, defaults are explicit. normalize(normalize(x).config) is a no-op.
   */
  function normalize(input) {
    const errors = [];
    if (!isPlainObject(input)) return { ok: false, config: null, errors: [{ field: 'config', code: 'type' }] };
    for (const k of Object.keys(input)) if (!KEYS.includes(k)) errors.push({ field: k, code: 'unknown_field' });
    if (input.schema !== undefined && input.schema !== SCHEMA) errors.push({ field: 'schema', code: 'unsupported' });
    const token = isAddr(input.token) ? lc(input.token) : (errors.push({ field: 'token', code: 'invalid' }), '');
    const preset = String(input.preset == null ? 'CLEAN' : input.preset).toUpperCase();
    if (!PRESETS.includes(preset)) errors.push({ field: 'preset', code: 'invalid' });
    const accent = String(input.accent == null ? 'BLUE' : input.accent).toUpperCase();
    if (!ACCENTS.includes(accent)) errors.push({ field: 'accent', code: 'invalid' });
    const headline = text(input.headline, LIMITS.headline, false, 'headline', errors);
    const about = text(input.about, LIMITS.about, true, 'about', errors);
    const cid = (v, field) => {
      if (v === undefined || v === null || v === '') return '';
      if (typeof v !== 'string' || !CID.test(v)) { errors.push({ field, code: 'invalid_cid' }); return ''; }
      return v;
    };
    const logoCid = cid(input.logoCid, 'logoCid');
    const heroCid = cid(input.heroCid, 'heroCid');
    const socials = {};
    const rawSocials = input.socials === undefined || input.socials === null ? {} : input.socials;
    if (!isPlainObject(rawSocials)) errors.push({ field: 'socials', code: 'type' });
    else {
      for (const k of Object.keys(rawSocials)) if (!SOCIALS[k]) errors.push({ field: 'socials.' + k, code: 'unknown_field' });
      for (const k of Object.keys(SOCIALS)) {
        let v = rawSocials[k];
        if (v === undefined || v === null) v = '';
        if (typeof v !== 'string') { errors.push({ field: 'socials.' + k, code: 'type' }); socials[k] = ''; continue; }
        v = v.trim().replace(/^@/, '');
        if (v && !SOCIALS[k].re.test(v)) { errors.push({ field: 'socials.' + k, code: 'invalid_handle' }); v = ''; }
        socials[k] = v;
      }
    }
    let cta = null;
    if (input.cta !== undefined && input.cta !== null) {
      if (!isPlainObject(input.cta) || Object.keys(input.cta).some((k) => k !== 'label' && k !== 'url')) errors.push({ field: 'cta', code: 'type' });
      else {
        const label = String(input.cta.label || '').toUpperCase();
        if (!CTA_LABELS.includes(label)) errors.push({ field: 'cta.label', code: 'invalid' });
        const u = checkUrl(input.cta.url);
        if (!u.ok) errors.push({ field: 'cta.url', code: u.code });
        if (CTA_LABELS.includes(label) && u.ok) cta = { label, url: u.href };
      }
    }
    const sections = {};
    const rawSections = input.sections === undefined || input.sections === null ? {} : input.sections;
    if (!isPlainObject(rawSections)) errors.push({ field: 'sections', code: 'type' });
    else {
      for (const k of Object.keys(rawSections)) if (!SECTIONS.includes(k)) errors.push({ field: 'sections.' + k, code: 'unknown_field' });
      for (const k of SECTIONS) {
        const v = rawSections[k];
        if (v !== undefined && typeof v !== 'boolean') errors.push({ field: 'sections.' + k, code: 'type' });
        sections[k] = v === undefined ? true : v === true;
      }
    }
    const config = { schema: SCHEMA, token, preset, accent, headline, about, logoCid, heroCid, socials, cta, sections };
    return errors.length ? { ok: false, config: null, errors } : { ok: true, config, errors: [] };
  }

  /** validate(config) -> {ok, errors, configHash}. ok only when the config is valid AND already canonical. */
  function validate(config) {
    const n = normalize(config);
    if (!n.ok) return { ok: false, errors: n.errors };
    if (canonicalJson(n.config) !== canonicalJson(config)) return { ok: false, errors: [{ field: 'config', code: 'not_canonical' }] };
    return { ok: true, errors: [], configHash: configHash(n.config) };
  }

  /** Every operator-authored external destination of a config: [{kind, label, href, host, idn}]. */
  function externalLinks(config) {
    const out = [];
    if (config.cta) { const u = checkUrl(config.cta.url); if (u.ok) out.push({ kind: 'cta', label: config.cta.label, href: u.href, host: u.host, idn: u.idn }); }
    for (const k of Object.keys(SOCIALS)) {
      const h = config.socials && config.socials[k];
      if (h && SOCIALS[k].re.test(h)) { const u = checkUrl(SOCIALS[k].url(h)); out.push({ kind: k, label: SOCIALS[k].label, handle: h, href: u.href, host: u.host, idn: false }); }
    }
    return out;
  }

  // ------------------------------------------------------------------ pure renderer (zero JavaScript)
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"'`=]/g, (c) => ESC[c]);
  // Text nodes additionally encode ':' so no user value can ever spell a URL scheme (javascript:, data:) in the markup.
  const escText = (v) => esc(v).replace(/:/g, '&#58;');
  const safeText = (v, max) => escText(Core.sanitizeForDisplay(String(v == null ? '' : v), { maxLength: max || 160 }));
  const shortAddr = (a) => (isAddr(a) ? lc(a).slice(0, 6) + '…' + lc(a).slice(-4) : '');
  const IMG_SRC = /^\/site-img\/[A-Za-z0-9]{46,121}$/;

  const STYLESHEET = [
    ':root{color-scheme:light dark}',
    '*{box-sizing:border-box}',
    'body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}',
    '.preset-clean{background:#f7f8fa;color:#111827}',
    '.preset-dark{background:#0b0f17;color:#e5e7eb}',
    '.preset-terminal{background:#050805;color:#b6f5c0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '.wrap{max-width:860px;margin:0 auto;padding:0 16px}',
    '.watermark{position:sticky;top:0;z-index:9;background:#b45309;color:#fff;text-align:center;font-weight:800;letter-spacing:.12em;padding:8px}',
    '.identity{padding:28px 0 20px;border-bottom:1px solid rgba(127,127,127,.35)}',
    '.authority{display:inline-block;font-size:12px;font-weight:800;letter-spacing:.12em;padding:6px 10px;border-radius:6px;border:1px solid currentColor}',
    '.authority.warn{color:#b45309;background:rgba(245,158,11,.12)}',
    '.authority small{display:block;font-weight:700}',
    '.idrow{display:flex;gap:14px;align-items:center;margin-top:14px}',
    '.idrow img{width:64px;height:64px;border-radius:12px;object-fit:cover;flex:none}',
    'h1{margin:0;font-size:30px;line-height:1.15}',
    '.ticker{font-weight:800;opacity:.8}',
    'dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:14px 0 0;font-size:14px}',
    'dt{opacity:.7}dd{margin:0}',
    'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}',
    'section{padding:22px 0;border-bottom:1px solid rgba(127,127,127,.2)}',
    'h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px;opacity:.75}',
    '.byop{font-size:12px;letter-spacing:.08em;opacity:.65;margin:0 0 8px}',
    '.headline{font-size:24px;font-weight:700;margin:0 0 14px}',
    '.hero img{display:block;width:100%;max-height:360px;object-fit:cover;border-radius:12px;margin-bottom:14px}',
    '.about p{margin:0 0 10px;white-space:pre-line}',
    '.ext{display:inline-block;font-weight:800;letter-spacing:.06em;padding:10px 16px;border-radius:8px;text-decoration:none;color:#fff}',
    '.ext.disabled{background:#6b7280;color:#f3f4f6;cursor:not-allowed}',
    '.host{display:inline-block;margin-left:10px;font-size:13px;opacity:.75}',
    'ul.links{list-style:none;padding:0;margin:0}ul.links li{margin:0 0 10px}',
    '.note{font-size:13px;opacity:.75}',
    'footer{padding:22px 0 40px;font-size:12px;opacity:.75}',
    '.accent-blue .ext:not(.disabled){background:#2563eb}.accent-blue .authority:not(.warn){color:#2563eb}',
    '.accent-green .ext:not(.disabled){background:#059669}.accent-green .authority:not(.warn){color:#059669}',
    '.accent-amber .ext:not(.disabled){background:#b45309}.accent-amber .authority:not(.warn){color:#d97706}',
    '.accent-red .ext:not(.disabled){background:#dc2626}.accent-red .authority:not(.warn){color:#dc2626}',
    '.accent-violet .ext:not(.disabled){background:#7c3aed}.accent-violet .authority:not(.warn){color:#7c3aed}',
    '.accent-slate .ext:not(.disabled){background:#475569}.accent-slate .authority:not(.warn){color:#64748b}',
    '@media (max-width:520px){h1{font-size:24px}.headline{font-size:20px}dl{grid-template-columns:1fr}.host{display:block;margin:6px 0 0}}',
  ].join('\n');

  function link(l, enabled) {
    const host = escText(l.host) + (l.idn ? ' (internationalised domain, shown in ASCII form)' : '');
    if (!enabled) return `<span class="ext disabled" aria-disabled="true">${escText(l.label)}</span><span class="host">${host} · link disabled until the current Passport operator confirms this site</span>`;
    return `<a class="ext" href="${esc(l.href)}" rel="nofollow noopener noreferrer ugc" target="_blank" referrerpolicy="no-referrer">${escText(l.label)}</a><span class="host">${host}</span>`;
  }

  /**
   * render({config, facts, authority, revision, mode, imageSrc}) -> complete HTML document (string). Pure: no I/O.
   *   config     a VALID canonical config (renderer re-validates; an invalid config renders nothing operator-authored)
   *   facts      SERVER-DERIVED project facts: {token, name, symbol, origin:{label, factory}, deployer, markets:[{pairToken, symbol}],
   *              onchainWebsite, passport:{operator, operatorSince}}
   *   authority  {signer} — the revision signer; compared here to facts.passport.operator (the CURRENT operator)
   *   mode       'published' | 'preview' (preview: watermark, noindex, and no link is ever clickable)
   *   imageSrc   cid -> same-origin path (default '/site-img/<cid>'); anything not matching that shape is dropped
   */
  function render(opts) {
    const o = opts || {};
    const preview = o.mode === 'preview';
    const facts = o.facts || {};
    const v = validate(o.config);
    const config = v.ok ? o.config : null;
    const operator = facts.passport && isAddr(facts.passport.operator) ? lc(facts.passport.operator) : '';
    const signer = o.authority && isAddr(o.authority.signer) ? lc(o.authority.signer) : '';
    const current = !preview && Boolean(operator) && signer === operator;
    const linksOn = current; // stale (previous operator), missing Passport, or preview: never clickable
    const imgSrc = (cid) => {
      if (!cid || !CID.test(cid)) return '';
      const src = typeof o.imageSrc === 'function' ? o.imageSrc(cid) : '/site-img/' + cid;
      return typeof src === 'string' && IMG_SRC.test(src) ? src : '';
    };
    const name = safeText(facts.name, 64) || 'Unnamed token';
    const symbol = safeText(facts.symbol, 16).toUpperCase();
    const token = isAddr(facts.token) ? lc(facts.token) : '';
    const preset = config ? config.preset.toLowerCase() : 'clean';
    const accent = config ? config.accent.toLowerCase() : 'slate';
    const S = config ? config.sections : {};
    const out = [];
    out.push('<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="referrer" content="no-referrer">');
    if (preview || !current) out.push('<meta name="robots" content="noindex, nofollow">');
    out.push(`<title>${name}${symbol ? ' ($' + symbol + ')' : ''} · Synced Website · SyncNet</title>`, `<style>${STYLESHEET}</style>`, '</head>');
    out.push(`<body class="preset-${preset} accent-${accent}">`);
    if (preview) out.push(`<div class="watermark">${PREVIEW_LABEL}</div>`);
    out.push('<div class="wrap">');
    // ---- verified identity (server-derived, always first, never operator-editable)
    out.push('<header class="identity">');
    if (preview) out.push(`<div class="authority warn">${PREVIEW_LABEL}<small>No authority implied. Not stored or served by SyncNet.</small></div>`);
    else if (current) out.push(`<div class="authority">${esc(AUTHORITY_LABEL)}</div>`);
    else out.push(`<div class="authority warn">SYNCED WEBSITE<small>${esc(PREVIOUS_LABEL)}</small></div>`);
    const logo = config ? imgSrc(config.logoCid) : '';
    out.push('<div class="idrow">' + (logo ? `<img src="${esc(logo)}" alt="" width="64" height="64" decoding="async">` : '') + `<div><h1>${name}</h1>${symbol ? `<span class="ticker">$${symbol}</span>` : ''}</div></div>`);
    out.push('<dl>');
    if (token) out.push(`<dt>Contract</dt><dd><code>${esc(token)}</code> · Robinhood Chain (${CHAIN_ID})</dd>`);
    if (facts.origin && facts.origin.label) out.push(`<dt>Verified origin</dt><dd>${safeText(facts.origin.label, 32)} · read by SyncNet from the factory record${isAddr(facts.origin.factory) ? ` <code>${esc(shortAddr(facts.origin.factory))}</code>` : ''}</dd>`);
    out.push(`<dt>Project Passport</dt><dd>${operator ? `Operator <code>${esc(operator)}</code>` : 'No current operator'}</dd>`);
    out.push('</dl>');
    out.push('</header>');
    // ---- operator-authored content, fixed order, each block labelled as such
    if (config) {
      const links = externalLinks(config);
      const cta = links.find((l) => l.kind === 'cta');
      const hero = imgSrc(config.heroCid);
      if (S.hero && (config.headline || cta || hero)) {
        out.push('<section class="hero">', '<p class="byop">Written by the Passport operator</p>');
        if (hero) out.push(`<img src="${esc(hero)}" alt="" decoding="async">`);
        if (config.headline) out.push(`<p class="headline">${escText(config.headline)}</p>`);
        if (cta) out.push('<p>' + link(cta, linksOn) + '</p>');
        out.push('</section>');
      }
      if (S.about && config.about) {
        out.push('<section class="about">', '<h2>About</h2>', '<p class="byop">Written by the Passport operator</p>');
        for (const para of config.about.split(/\n{2,}/)) out.push(`<p>${escText(para)}</p>`);
        out.push('</section>');
      }
    }
    if (!config || S.tokenFacts) {
      out.push('<section>', '<h2>Token facts</h2>', '<p class="byop">Read by SyncNet from Robinhood Chain</p>', '<dl>');
      out.push(`<dt>Name</dt><dd>${name}</dd>`);
      if (symbol) out.push(`<dt>Ticker</dt><dd>$${symbol}</dd>`);
      if (token) out.push(`<dt>Contract</dt><dd><code>${esc(token)}</code></dd>`);
      out.push(`<dt>Chain</dt><dd>Robinhood Chain (${CHAIN_ID})</dd>`, '</dl>', '</section>');
    }
    if (!config || S.origin) {
      out.push('<section>', '<h2>Origin / markets</h2>', '<p class="byop">Read by SyncNet from the launch factory</p>', '<dl>');
      if (facts.origin && facts.origin.label) out.push(`<dt>Launchpad</dt><dd>${safeText(facts.origin.label, 32)}</dd>`);
      if (facts.origin && isAddr(facts.origin.factory)) out.push(`<dt>Factory</dt><dd><code>${esc(lc(facts.origin.factory))}</code></dd>`);
      if (isAddr(facts.deployer)) out.push(`<dt>Deployer</dt><dd><code>${esc(lc(facts.deployer))}</code></dd>`);
      for (const m of (Array.isArray(facts.markets) ? facts.markets : []).slice(0, 8)) {
        if (isAddr(m.pairToken)) out.push(`<dt>Market</dt><dd>paired with ${m.symbol ? '$' + safeText(m.symbol, 16) + ' ' : ''}<code>${esc(lc(m.pairToken))}</code></dd>`);
      }
      out.push('</dl>');
      if (facts.onchainWebsite) {
        out.push(`<p class="note">On-chain website field (written in the token contract, not verified by SyncNet, not a link): <code>${safeText(facts.onchainWebsite, 120)}</code></p>`);
      }
      out.push('</section>');
    }
    if (config && S.socials) {
      const socials = externalLinks(config).filter((l) => l.kind !== 'cta');
      if (socials.length) {
        out.push('<section>', '<h2>Socials</h2>', '<p class="byop">Handles provided by the Passport operator</p>', '<ul class="links">');
        for (const l of socials) out.push('<li>' + link({ ...l, label: l.label + ' · ' + l.handle }, linksOn) + '</li>');
        out.push('</ul>', '</section>');
      }
    }
    if (!config || S.passport) {
      out.push('<section>', '<h2>Project Passport</h2>', '<dl>');
      out.push(`<dt>Current operator</dt><dd>${operator ? `<code>${esc(operator)}</code>` : 'none'}</dd>`);
      if (facts.passport && facts.passport.operatorSince) out.push(`<dt>Operator since</dt><dd>${safeText(facts.passport.operatorSince, 40)}</dd>`);
      if (signer && !preview) out.push(`<dt>Site signed by</dt><dd><code>${esc(signer)}</code>${current ? '' : ' (not the current operator)'}</dd>`);
      out.push('</dl>', '<p class="note">A Project Passport proves SyncNet-recognised operational authority over this project. It does not prove the identity of the historical or original team.</p>', '</section>');
    }
    out.push('<footer>');
    if (!preview && o.revision && /^0x[0-9a-f]{64}$/.test(String(o.revision.configHash || ''))) out.push(`<p>Config ${esc(o.revision.configHash)}${o.revision.issuedAt ? ' · signed ' + esc(new Date(Number(o.revision.issuedAt) * 1000).toISOString()) : ''}</p>`);
    out.push('<p>Hosted by SyncNet as a Project Home. Operator-authored text and links are the Passport operator’s; token facts are read from Robinhood Chain. A Project Home stays active for as long as SyncNet operates the Project Home service.</p>');
    out.push('</footer>', '</div>', '</body>', '</html>');
    return out.join('\n');
  }

  return Object.freeze({
    CHAIN_ID, SCHEMA, DOMAIN, TYPES, MAX_SKEW, AUTHORITY_LABEL, PREVIOUS_LABEL, PREVIEW_LABEL, PRESETS, ACCENTS, CTA_LABELS,
    SECTIONS, SOCIALS, LIMITS, CID, RESERVED_CLAIMS, STYLESHEET,
    canonicalJson, configHash, typedData, digest, checkUrl, normalize, validate, externalLinks, render, escapeHtml: esc, escapeText: escText,
  });
});
