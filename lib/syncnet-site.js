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
    // Authenticates "the current operator asks for a Project Home activation quote; Terms of Use version termsVersion
    // applies to it". Sends no payment and grants nothing by itself; explicit acceptance is the pre-payment checkbox.
    ActivationRequest: [
      { name: 'token', type: 'address' }, { name: 'operator', type: 'address' },
      { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'termsVersion', type: 'string' },
    ],
  });
  // The Terms of Use version an activation request signs: the "Last updated" date of /terms.html. Change it together
  // with any change to the Terms; the server accepts only this exact value.
  const TERMS_VERSION = '2026-09-28';
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
  // A project's already-resolved logo from the reviewed registry: a same-origin, repo-reviewed asset (CSP img-src 'self').
  const REGISTRY_LOGO = /^\/assets\/[a-z0-9][a-z0-9-]{0,63}\.(?:webp|png)$/;
  // Quote assets SyncNet recognises BY ADDRESS (never by symbol): a pair token at one of these addresses is shown with
  // its canonical symbol; any other pair token shows the symbol its own contract reports.
  const KNOWN_ASSETS = Object.freeze({
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG', '0xca9c78dd337a67f6e0077f65f5e9218719d30edf': 'NET',
    '0x6368e007b9f0b941560ed1f3bceb20247f5eca37': 'SYNC', '0x0000000000000000000000000000000000000000': 'ETH',
  });
  const FEE_MODES = Object.freeze({
    holders: ['Creator fees fund holder rewards', 'PAR’s distributor pays holders in the traded assets, in rounds. Not guaranteed.'],
    burn: ['Creator fees fund buyback & burn', 'Sent to PAR’s burn vault. Buyback rounds are run by PAR.'],
    floor: ['Creator fees support a price floor', 'Sent to PAR’s floor vault.'],
    creator: ['Creator fees go to a wallet', 'The recipient is listed under Verified details.'],
  });

  /*
   * One static stylesheet (its SHA-256 is the only style the CSP allows). Three presets that differ in type, surface,
   * rhythm and structure, not only colour: CLEAN (bone, serif display, generous editorial space), DARK (warm near-black,
   * heavy sans display, cinematic image band) and TERMINAL (mono, compact, framed, prompt-marked). SyncNet identity:
   * cyan is the ONLY accent (a deeper cyan on bone for contrast); SLATE renders monochrome; every other stored accent
   * value renders cyan. States use marks and borders, never a second colour. No url(), fonts, gradients, glow or shadow.
   */
  const STYLESHEET = [
    ':root{color-scheme:light dark}',
    '*{box-sizing:border-box}',
    'html{-webkit-text-size-adjust:100%;text-size-adjust:100%}',
    'body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 var(--sans);overflow-wrap:anywhere;-webkit-font-smoothing:antialiased;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Times New Roman",serif;--disp:var(--sans);--r:3px}',
    '.preset-clean{--bg:#f4f1ea;--fg:#141312;--fg2:#46443f;--fg3:#716e67;--line:rgba(20,19,18,.12);--line2:rgba(20,19,18,.26);--surf:#ebe7de;--warn:#141312;--disp:var(--serif)}',
    '.preset-dark{--bg:#0d0c0b;--fg:#ece6d8;--fg2:#b7b0a2;--fg3:#8d8679;--line:rgba(236,230,216,.12);--line2:rgba(236,230,216,.26);--surf:#161412;--warn:#ffffff}',
    '.preset-terminal{--bg:#0a0a0a;--fg:#e4e2dc;--fg2:#a8a6a0;--fg3:#7a7873;--line:rgba(228,226,220,.14);--line2:rgba(228,226,220,.3);--surf:#121212;--warn:#ffffff;--disp:var(--mono);--sans:var(--mono);--r:0;font-size:15px;line-height:1.55}',
    '.accent-blue,.accent-green,.accent-amber,.accent-red,.accent-violet{--acc:#6fd3df}.accent-slate{--acc:#ece6d8}',
    '.preset-clean.accent-blue,.preset-clean.accent-green,.preset-clean.accent-amber,.preset-clean.accent-red,.preset-clean.accent-violet{--acc:#17707c}.preset-clean.accent-slate{--acc:#141312}',
    '.preset-dark,.preset-terminal{--on-acc:#0d0c0b}.preset-clean{--on-acc:#f7f4ee}',
    '.wrap{width:min(100% - 40px,1120px);margin:0 auto}',
    'code{font-family:var(--mono);font-size:.86em;letter-spacing:0}',
    'h1,h2,p,dl,dd,figure,ul{margin:0}ul{padding:0;list-style:none}',
    // preview watermark + authority bar
    '.watermark{position:sticky;top:0;z-index:9;background:#141312;color:#ece6d8;border-bottom:1px solid #6fd3df;text-align:center;font:600 12px/1 var(--sans);letter-spacing:.16em;padding:10px 12px}',
    '.bar{border-bottom:1px solid var(--line);font:500 11px/1.4 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--fg3)}',
    '.bar .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 20px;min-height:40px;padding:9px 0}',
    '.authority{display:inline-flex;align-items:center;gap:10px;color:var(--fg);font-weight:600}',
    '.authority::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--acc)}',
    '.authority.warn{color:var(--warn)}.authority.warn::before{background:none;border:1px dashed currentColor;border-radius:0;width:9px;height:9px}',
    '.authority small{font-size:inherit;font-weight:500;color:var(--fg3);letter-spacing:.1em}',
    // site header: identity
    '.identity .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px 24px;flex-wrap:wrap;padding:22px 0}',
    '.brand{display:flex;align-items:center;gap:14px;min-width:0}',
    '.brand img,.mark{width:44px;height:44px;flex:none;border-radius:var(--r);object-fit:cover;display:block}',
    '.mark{display:grid;place-items:center;background:var(--surf);border:1px solid var(--line);font:600 20px/1 var(--disp);color:var(--fg)}',
    'h1{font:650 18px/1.2 var(--sans);letter-spacing:-.005em}',
    '.ticker{display:block;font:500 12px/1.4 var(--mono);letter-spacing:.06em;color:var(--fg3);margin-top:3px}',
    '.kicker{font:500 12px/1.4 var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--fg3)}',
    // hero
    '.hero{border-top:1px solid var(--line)}',
    '.hero .wrap{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);gap:40px 64px;align-items:center;padding:clamp(56px,9vw,128px) 0 clamp(48px,7vw,96px)}',
    '.hero.solo .wrap{grid-template-columns:minmax(0,1fr)}',
    '.headline{font:500 clamp(42px,6.4vw,88px)/1.02 var(--disp);letter-spacing:-.022em;color:var(--fg);max-width:15ch}',
    '.headline.name{max-width:12ch}',
    '.actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:clamp(28px,4vw,44px)}',
    '.cta-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px}',
    '.ext{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border-radius:var(--r);font:650 13px/1 var(--sans);letter-spacing:.1em;text-transform:uppercase;text-decoration:none;background:var(--acc);color:var(--on-acc);border:1px solid var(--acc)}',
    '.ext:hover{filter:brightness(1.06)}',
    '.ext:focus-visible{outline:2px solid var(--fg);outline-offset:3px}',
    '.ext.social{background:transparent;color:var(--fg);border-color:var(--line2);font-weight:550;letter-spacing:.04em;text-transform:none;font-size:14px;padding:0 16px;min-height:44px}',
    '.ext.social:hover{border-color:var(--fg);filter:none}',
    '.ext.social b{font-weight:650;margin-right:8px}.ext.social em{font-style:normal;font-weight:500;color:var(--fg2)}.ext.social.disabled em{color:inherit}',
    '.ext.disabled{background:transparent;color:var(--fg3);border:1px dashed var(--line2);cursor:not-allowed}',
    '.host{font:500 12px/1.4 var(--mono);color:var(--fg3)}',
    '.socials{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}',
    '.byop{font:500 11px/1.4 var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--fg3);margin-top:28px}',
    '.disabled-note{font-size:13px;color:var(--warn);margin-top:14px;max-width:52ch;padding-left:12px;border-left:2px solid var(--line2)}',
    '.media img{display:block;width:100%;aspect-ratio:4/5;object-fit:cover;object-position:50% 30%;border-radius:var(--r);background:var(--surf)}',
    '.media figcaption{display:none}',
    '.tile{aspect-ratio:4/5;display:grid;place-items:center;align-content:center;gap:18px;background:var(--surf);border:1px solid var(--line);border-radius:var(--r);padding:32px}',
    '.tile img{width:min(72%,300px);aspect-ratio:1;object-fit:cover;border-radius:var(--r)}',
    '.tile .glyph{font:500 clamp(96px,12vw,168px)/1 var(--disp);color:var(--fg);letter-spacing:-.04em}',
    '.tile .tick{font:600 13px/1 var(--mono);letter-spacing:.14em;color:var(--fg2)}',
    '.tile dl,.tile .file{display:none}',
    // sections
    '.sec{border-top:1px solid var(--line)}',
    '.sec>.wrap{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,9fr);gap:20px 64px;padding:clamp(44px,6vw,80px) 0}',
    'h2{font:600 12px/1.5 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--fg3);padding-top:.5em}',
    '.prose{max-width:62ch}',
    '.prose p{margin:0 0 1.1em;white-space:pre-line;color:var(--fg2)}',
    '.prose p.lead{font:400 clamp(24px,2.7vw,34px)/1.3 var(--disp);letter-spacing:-.01em;color:var(--fg);margin-bottom:.9em}',
    '.prose .byop{margin-top:10px}',
    '.pairs li{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:4px 24px;padding:18px 0;border-bottom:1px solid var(--line)}',
    '.pairs li:first-child{padding-top:0}',
    '.pair{font:500 clamp(22px,2.4vw,30px)/1.2 var(--disp);letter-spacing:-.01em}',
    '.pair i{font-style:normal;color:var(--fg3);padding:0 .2em}',
    '.via{font:500 12px/1.4 var(--sans);letter-spacing:.1em;text-transform:uppercase;color:var(--fg3)}',
    '.econ{margin-top:32px;padding:22px 24px;border:1px solid var(--line);border-radius:var(--r);background:var(--surf)}',
    '.econ p{margin:0}.econ .t{font:500 19px/1.35 var(--disp);color:var(--fg)}.econ .n{margin-top:6px;font-size:14px;color:var(--fg2)}',
    '.src{margin-top:18px;font-size:13px;color:var(--fg3)}',
    '.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border-top:1px solid var(--line2)}',
    '.facts>div{padding:18px 20px 18px 0;border-bottom:1px solid var(--line)}',
    '.facts dt{font:600 11px/1.4 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--fg3);margin-bottom:8px}',
    '.facts dd{font-size:16px;color:var(--fg)}',
    '.facts dd code{display:block;margin-top:2px;color:var(--fg3)}',
    '.ok{color:var(--acc)}.warnt{color:var(--warn);font-weight:600}.warnt::before{content:"! "}',
    '.note{margin-top:22px;font-size:14px;color:var(--fg2);max-width:70ch}',
    // verified details (collapsed)
    '.verify>.wrap{padding:0}',
    'details{border-top:1px solid var(--line)}',
    'summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px;min-height:64px;padding:22px 0;cursor:pointer;list-style:none;font:600 12px/1.5 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--fg2)}',
    'summary::-webkit-details-marker{display:none}',
    'summary::before{content:"+";font:500 16px/1 var(--mono);color:var(--fg3);width:14px}',
    'details[open] summary::before{content:"\\2212"}',
    'summary span{font-weight:500;letter-spacing:.02em;text-transform:none;color:var(--fg3)}',
    '.kv{display:grid;grid-template-columns:minmax(140px,max-content) minmax(0,1fr);gap:12px 32px;padding:4px 0 36px;font-size:14px}',
    '.kv dt{color:var(--fg3)}.kv dd{color:var(--fg2)}',
    '.addr{user-select:all;-webkit-user-select:all;color:var(--fg);font-size:13px}',
    '.kv .note{margin:0;font-size:13px}',
    'footer{border-top:1px solid var(--line);color:var(--fg3);font-size:13px}',
    'footer .wrap{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,9fr);gap:10px 64px;padding:36px 0 56px}',
    'footer .made{font:600 12px/1.5 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--fg2)}',
    'footer p{max-width:70ch}',
    // CLEAN: editorial, bone, serif display
    '.preset-clean .headline{font-weight:400;letter-spacing:-.028em}',
    '.preset-clean .tile .glyph{font-style:italic}',
    '.preset-clean .ext:not(.social):not(.disabled){background:var(--fg);border-color:var(--fg);color:var(--bg)}',
    '.preset-clean .ext:not(.social):not(.disabled):hover{background:var(--acc);border-color:var(--acc);filter:none}',
    '.preset-clean .authority::before{border-radius:0}',
    '.preset-clean .pair{font-style:italic}',
    // DARK: cinematic band, heavy sans display
    '.preset-dark .headline{font-weight:700;letter-spacing:-.035em;line-height:.98}',
    '.preset-dark .prose p.lead{font-weight:450}',
    '.preset-dark .hero.has-img .wrap{grid-template-columns:minmax(0,1fr)}',
    '.preset-dark .hero.has-img .media{margin-top:clamp(8px,2vw,16px)}',
    '.preset-dark .hero.has-img .media img{aspect-ratio:16/9;object-position:50% 20%;border-radius:0}',
    '.preset-dark .hero.has-img .headline{max-width:18ch}',
    '.preset-dark .tile{background:#141210;border-color:var(--line)}',
    '.preset-dark .tile .glyph{font-weight:800}',
    // TERMINAL: mono, compact, framed, prompt-marked
    '.preset-terminal .bar{letter-spacing:.06em}',
    '.preset-terminal .authority::before{content:"[ok]";width:auto;height:auto;border-radius:0;background:none;color:var(--acc)}',
    '.preset-terminal .authority.warn::before{content:"[!!]";background:none;color:var(--warn)}',
    '.preset-terminal .kicker::before{content:"@ ";color:var(--fg3)}',
    '.preset-terminal .kicker{letter-spacing:.02em;text-transform:none;color:var(--acc)}',
    '.preset-terminal h1{font-size:16px}',
    '.preset-terminal .hero .wrap{padding:48px 0 56px;gap:28px 40px;align-items:start}',
    '.preset-terminal .headline{font-size:clamp(28px,4.2vw,50px);font-weight:600;letter-spacing:-.01em;line-height:1.12;max-width:26ch}',
    '.preset-terminal .headline::before{content:"> ";color:var(--acc)}',
    '.preset-terminal .headline::after{content:"_";color:var(--acc);margin-left:.08em}',
    '.preset-terminal .ext{font-size:13px;letter-spacing:.06em;min-height:44px;padding:0 16px}',
    '.preset-terminal .ext:not(.disabled)::before{content:"[ ";opacity:.7}.preset-terminal .ext:not(.disabled)::after{content:" ]";opacity:.7}',
    '.preset-terminal .ext:not(.social):not(.disabled){background:transparent;color:var(--acc);border-color:var(--acc)}',
    '.preset-terminal .ext:not(.social):not(.disabled):hover{background:var(--acc);color:var(--on-acc);filter:none}',
    '.preset-terminal .byop::before{content:"# ";color:var(--acc)}',
    '.preset-terminal .byop,.preset-terminal h2,.preset-terminal .via,.preset-terminal .facts dt,.preset-terminal summary,.preset-terminal footer .made{letter-spacing:.04em;text-transform:lowercase}',
    '.preset-terminal .media{border:1px solid var(--line2)}',
    '.preset-terminal .media figcaption{display:block;padding:7px 12px;border-bottom:1px solid var(--line2);font-size:12px;color:var(--fg3)}',
    '.preset-terminal .media img{aspect-ratio:16/10}',
    '.preset-terminal .tile{aspect-ratio:auto;display:block;place-items:normal;padding:0;background:var(--surf);border-color:var(--line2)}',
    '.preset-terminal .tile .glyph,.preset-terminal .tile .tick{display:none}',
    '.preset-terminal .tile img{display:block;width:72px;margin:18px 18px 0}',
    '.preset-terminal .tile dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 18px;padding:18px;font-size:13px}',
    '.preset-terminal .tile dt{color:var(--fg3)}.preset-terminal .tile dt::after{content:":"}.preset-terminal .tile dd{color:var(--fg)}',
    '.preset-terminal .tile .file{display:block;padding:7px 18px;border-bottom:1px solid var(--line2);font-size:12px;color:var(--fg3)}',
    '.preset-terminal .sec>.wrap{grid-template-columns:minmax(0,1fr);gap:18px;padding:40px 0}',
    '.preset-terminal h2{display:flex;align-items:center;gap:12px;padding:0;color:var(--acc)}',
    '.preset-terminal h2::before{content:"##"}',
    '.preset-terminal h2::after{content:"";flex:1;border-top:1px dashed var(--line2)}',
    '.preset-terminal .prose p.lead{font-size:18px;line-height:1.55;font-weight:500}',
    '.preset-terminal .pair{font-size:20px}',
    '.preset-terminal .econ{border-style:dashed}',
    '.preset-terminal .econ .t{font-size:16px}',
    '.preset-terminal .facts{border:1px solid var(--line2);grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}',
    '.preset-terminal .facts>div{padding:14px 16px;border-bottom:0;border-right:1px dashed var(--line)}',
    '.preset-terminal .facts dt::after{content:":"}',
    '.preset-terminal summary::before{content:"$";color:var(--acc)}',
    '.preset-terminal details[open] summary::before{content:"$"}',
    
    '.preset-terminal footer .wrap{grid-template-columns:minmax(0,1fr);padding:28px 0 44px}',
    // responsive: tablet and phone (no desktop tables compressed; everything stacks)
    '@media (max-width:900px){.hero .wrap{grid-template-columns:minmax(0,1fr);gap:40px}.media img,.tile{aspect-ratio:16/11}.preset-dark .hero.has-img .media img{aspect-ratio:16/10}.tile .glyph{font-size:120px}.sec>.wrap,footer .wrap{grid-template-columns:minmax(0,1fr);gap:18px}h2{padding-top:0}}',
    '@media (max-width:560px){body{font-size:16px}.wrap{width:min(100% - 32px,1120px)}.bar .wrap{padding:10px 0}.identity .wrap{padding:16px 0}.kicker{flex-basis:100%}.hero .wrap{padding:44px 0 48px}.headline{font-size:clamp(38px,11vw,52px)}.preset-terminal .headline{font-size:28px}.actions{flex-direction:column;align-items:stretch}.cta-row{flex-direction:column;align-items:stretch}.ext{width:100%}.socials{display:grid;grid-template-columns:minmax(0,1fr)}.ext.social{justify-content:flex-start}.bar .wrap>span:last-child{display:none}.tile{aspect-ratio:auto;padding:36px 20px}.tile .glyph{font-size:96px}.pairs li{grid-template-columns:minmax(0,1fr)}.kv{grid-template-columns:minmax(0,1fr);gap:2px}.kv dd{margin-bottom:14px}.facts{grid-template-columns:1fr 1fr}.preset-terminal .facts{grid-template-columns:1fr}.preset-terminal .facts>div{border-right:0;border-bottom:1px dashed var(--line)}}',
  ].join('\n');

  const DISABLED_NOTE = 'Awaiting confirmation: every operator link disabled until the current Passport operator adopts this site.';
  function link(l, enabled, social) {
    const cls = social ? 'ext social' : 'ext';
    const label = social ? `<b>${escText(l.label)}</b><em>${l.kind === 'discord' ? 'discord.gg/' : '@'}${escText(l.handle)}</em>` : escText(l.label);
    if (!enabled) return `<span class="${cls} disabled" aria-disabled="true">${label}</span>`;
    return `<a class="${cls}" href="${esc(l.href)}" rel="nofollow noopener noreferrer ugc" target="_blank" referrerpolicy="no-referrer">${label}</a>`;
  }
  const hostLine = (l) => `<span class="host">${escText(l.host)}${l.idn ? ' (internationalised domain, shown in ASCII form)' : ''}</span>`;
  const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : '');
  const firstGlyph = (s) => { const c = Array.from(Core.sanitizeForDisplay(String(s || ''), { maxLength: 8 }).replace(/[^\p{L}\p{N}]/gu, ''))[0]; return c ? escText(c.toUpperCase()) : '·'; };

  /**
   * render({config, facts, authority, revision, mode, imageSrc}) -> complete HTML document (string). Pure: no I/O.
   *   config     a VALID canonical config (renderer re-validates; an invalid config renders nothing operator-authored)
   *   facts      SERVER-DERIVED project facts: {token, name, symbol, origin:{launchpad, label, factory}, deployer,
   *              markets:[{pairToken, symbol}], feeMode, feeRecipient, onchainWebsite, passport:{operator, operatorSince}}
   *   authority  {signer} — the revision signer; compared here to facts.passport.operator (the CURRENT operator)
   *   mode       'published' | 'preview' (preview: watermark, noindex, and no link is ever clickable)
   *   imageSrc   cid -> same-origin path (default '/site-img/<cid>'); anything not matching that shape is dropped
   *
   * Hierarchy: authority bar → site header (identity) → hero (operator headline, CTA, socials, image) → About →
   * Markets & economy → Verified facts → Verified details (collapsed: every raw address) → footer. Blockchain facts
   * support the website; they never lead it.
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
    const origin = facts.origin && facts.origin.label ? safeText(facts.origin.label, 32) : '';
    const preset = config ? config.preset.toLowerCase() : 'clean';
    const accent = config ? config.accent.toLowerCase() : 'slate';
    const S = config ? config.sections : {};
    const markets = (Array.isArray(facts.markets) ? facts.markets : []).filter((m) => m && isAddr(m.pairToken)).slice(0, 8).map((m) => {
      const a = lc(m.pairToken);
      return { address: a, symbol: KNOWN_ASSETS[a] || safeText(m.symbol, 16).replace(/^\$/, '').toUpperCase(), known: Boolean(KNOWN_ASSETS[a]) };
    });
    const via = facts.origin && facts.origin.launchpad === 'PAR' ? 'PAR market' : facts.origin && facts.origin.launchpad === 'PONS_V2' ? 'Pons V2 pair' : origin ? origin + ' market' : 'Market';
    const fee = FEE_MODES[String(facts.feeMode || '')] || null;
    // Operator-uploaded logo first; otherwise the project's own registry logo; otherwise the letter mark.
    const logo = (config ? imgSrc(config.logoCid) : '') || (REGISTRY_LOGO.test(String(facts.logo || '')) ? String(facts.logo) : '');
    const out = [];
    out.push('<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', '<meta name="referrer" content="no-referrer">');
    if (preview || !current) out.push('<meta name="robots" content="noindex, nofollow">');
    out.push(`<title>${name}${symbol ? ' ($' + symbol + ')' : ''} · Synced Website · SyncNet</title>`, `<style>${STYLESHEET}</style>`, '</head>');
    out.push(`<body class="preset-${preset} accent-${accent}">`);
    if (preview) out.push(`<div class="watermark">${PREVIEW_LABEL}</div>`);
    // ---- authority bar (server-derived, always first, never operator-editable)
    out.push('<div class="bar"><div class="wrap">');
    if (preview) out.push('<span class="authority warn">SYNCED WEBSITE · PREVIEW <small>No authority implied. Not stored or served by SyncNet.</small></span>');
    else if (current) out.push(`<span class="authority">${esc(AUTHORITY_LABEL)}</span>`);
    else out.push(`<span class="authority warn">SYNCED WEBSITE · ${esc(PREVIOUS_LABEL)}</span>`);
    out.push('<span>Project Home on SyncNet</span></div></div>');
    // ---- site header: verified identity
    out.push('<header class="identity"><div class="wrap">');
    out.push('<div class="brand">' + (logo ? `<img src="${esc(logo)}" alt="" width="44" height="44" decoding="async">` : `<span class="mark" aria-hidden="true">${firstGlyph(facts.name || facts.symbol)}</span>`) + `<div><h1>${name}</h1>${symbol ? `<span class="ticker">$${symbol}</span>` : ''}</div></div>`);
    out.push(`<p class="kicker">${origin ? origin + ' · ' : ''}Robinhood Chain</p>`);
    out.push('</div></header>');
    // ---- operator-authored content, fixed order, each block labelled as such
    const links = config ? externalLinks(config) : [];
    const cta = links.find((l) => l.kind === 'cta');
    const socials = config && S.socials ? links.filter((l) => l.kind !== 'cta') : [];
    const socialsHtml = socials.length ? '<ul class="socials">' + socials.map((l) => '<li>' + link(l, linksOn, true) + '</li>').join('') + '</ul>' : '';
    const hero = config ? imgSrc(config.heroCid) : '';
    let socialsShown = false;
    if (config && S.hero) {
      const headline = config.headline ? `<p class="headline">${escText(config.headline)}</p>` : `<p class="headline name">${name}</p>`;
      const media = hero
        ? `<figure class="media"><figcaption>hero.png</figcaption><img src="${esc(hero)}" alt="" decoding="async"></figure>`
        : `<div class="tile" aria-hidden="true"><span class="file">token.json</span>${logo ? `<img src="${esc(logo)}" alt="" decoding="async">` : `<span class="glyph">${firstGlyph(facts.name || facts.symbol)}</span>`}${symbol ? `<span class="tick">$${symbol}</span>` : ''}<dl><dt>name</dt><dd>${name}</dd>${symbol ? `<dt>ticker</dt><dd>$${symbol}</dd>` : ''}<dt>chain</dt><dd>robinhood · ${CHAIN_ID}</dd>${origin ? `<dt>origin</dt><dd>${origin}</dd>` : ''}${markets.length ? `<dt>markets</dt><dd>${markets.map((m) => (m.symbol ? '$' + m.symbol : 'unnamed asset')).join(', ')}</dd>` : ''}${token ? `<dt>contract</dt><dd>${esc(shortAddr(token))}</dd>` : ''}</dl></div>`;
      out.push(`<section class="hero${hero ? ' has-img' : ''}"><div class="wrap">`, '<div class="hero-text">', headline);
      if (cta || socialsHtml) {
        out.push('<div class="actions">');
        if (cta) out.push('<div class="cta-row">' + link(cta, linksOn, false) + hostLine(cta) + '</div>');
        out.push('</div>');
        if (socialsHtml) { out.push(socialsHtml); socialsShown = true; }
        if (!linksOn && !preview) out.push(`<p class="disabled-note">${DISABLED_NOTE}</p>`);
      }
      out.push('<p class="byop">Written by the Passport operator</p>', '</div>', media, '</div></section>');
    }
    if (config && S.about && config.about) {
      const paras = config.about.split(/\n{2,}/);
      out.push('<section class="sec about"><div class="wrap">', '<h2>About</h2>', '<div class="prose">');
      paras.forEach((para, i) => out.push(`<p${i === 0 ? ' class="lead"' : ''}>${escText(para)}</p>`));
      out.push('<p class="byop">Written by the Passport operator</p>', '</div></div></section>');
    }
    if (socials.length && !socialsShown) {
      out.push('<section class="sec links"><div class="wrap">', '<h2>Elsewhere</h2>', '<div>', socialsHtml);
      if (!linksOn && !preview) out.push(`<p class="disabled-note">${DISABLED_NOTE}</p>`);
      out.push('<p class="byop">Handles provided by the Passport operator</p>', '</div></div></section>');
    }
    if ((!config || S.origin) && (markets.length || fee)) {
      out.push('<section class="sec market"><div class="wrap">', '<h2>Markets</h2>', '<div>');
      if (markets.length) {
        out.push('<ul class="pairs">');
        for (const m of markets) out.push(`<li><span class="pair">$${symbol || '—'}<i>/</i>${m.symbol ? '$' + m.symbol : 'Unnamed asset'}</span><span class="via">${escText(via)}</span></li>`);
        out.push('</ul>');
      }
      if (fee) out.push(`<div class="econ"><p class="t">${escText(fee[0])}</p><p class="n">${escText(fee[1])}</p></div>`);
      out.push(`<p class="src">Read by SyncNet from the launch factory${markets.some((m) => !m.known) ? '. Symbols of unrecognised pair tokens are as reported by their own contracts' : ''}.</p>`, '</div></div></section>');
    }
    if (!config || S.tokenFacts || S.passport) {
      out.push('<section class="sec verified"><div class="wrap">', '<h2>Verified facts</h2>', '<div>', '<dl class="facts">');
      if (!config || S.tokenFacts) {
        out.push(`<div><dt>Chain</dt><dd>Robinhood Chain</dd></div>`);
        out.push(`<div><dt>Token</dt><dd>${symbol ? '$' + symbol : name}${token ? `<code>${esc(shortAddr(token))}</code>` : ''}</dd></div>`);
        if (origin) out.push(`<div><dt>Origin</dt><dd>${origin}</dd></div>`);
        out.push(`<div><dt>Markets</dt><dd>${markets.length ? markets.map((m) => (m.symbol ? '$' + m.symbol : 'Unnamed asset')).join(' · ') : 'None read'}</dd></div>`);
      }
      if (!config || S.passport) {
        const pState = !operator ? '<span class="warnt">No current operator</span>' : preview ? 'Operator set' : current ? '<span class="ok">Operator verified</span>' : '<span class="warnt">Awaiting confirmation</span>';
        out.push(`<div><dt>Passport</dt><dd>${pState}${operator ? `<code>${esc(shortAddr(operator))}</code>` : ''}</dd></div>`);
      }
      out.push('</dl>');
      out.push('<p class="note">Read by SyncNet from Robinhood Chain. A Project Passport proves SyncNet-recognised operational authority over this project. It does not prove the identity of the historical or original team.</p>');
      out.push('</div></div></section>');
    }
    // ---- verified details: every raw address, collapsed, always available
    out.push('<section class="verify"><div class="wrap"><details>', '<summary>Verified details <span>Contract, launch, markets, Passport and signature</span></summary>', '<dl class="kv">');
    if (token) out.push(`<dt>Contract</dt><dd><code class="addr">${esc(token)}</code></dd>`);
    out.push(`<dt>Chain</dt><dd>Robinhood Chain · chain ID ${CHAIN_ID}</dd>`);
    if (origin) out.push(`<dt>Verified origin</dt><dd>${origin} · read by SyncNet from the factory record</dd>`);
    if (facts.origin && isAddr(facts.origin.factory)) out.push(`<dt>Factory</dt><dd><code class="addr">${esc(lc(facts.origin.factory))}</code></dd>`);
    if (isAddr(facts.deployer)) out.push(`<dt>Deployer</dt><dd><code class="addr">${esc(lc(facts.deployer))}</code></dd>`);
    for (const m of markets) out.push(`<dt>Market</dt><dd>paired with ${m.symbol ? '$' + m.symbol + ' ' : ''}<code class="addr">${esc(m.address)}</code></dd>`);
    if (facts.feeMode === 'creator' && isAddr(facts.feeRecipient)) out.push(`<dt>Creator-fee recipient</dt><dd><code class="addr">${esc(lc(facts.feeRecipient))}</code></dd>`);
    out.push(`<dt>Passport operator</dt><dd>${operator ? `<code class="addr">${esc(operator)}</code>` : 'No current operator'}${facts.passport && isoDay(facts.passport.operatorSince) ? ' · since ' + esc(isoDay(facts.passport.operatorSince)) : ''}</dd>`);
    if (signer && !preview) out.push(`<dt>Site signed by</dt><dd><code class="addr">${esc(signer)}</code>${current ? '' : ' (not the current operator)'}</dd>`);
    if (!preview && o.revision && /^0x[0-9a-f]{64}$/.test(String(o.revision.configHash || ''))) out.push(`<dt>Signed configuration</dt><dd><code class="addr">${esc(o.revision.configHash)}</code>${o.revision.issuedAt && Number.isFinite(Number(o.revision.issuedAt)) ? ' · signed ' + esc(isoDay(new Date(Number(o.revision.issuedAt) * 1000).toISOString())) : ''}</dd>`);
    if (facts.onchainWebsite) out.push(`<dt>On-chain website field</dt><dd>Written in the token contract, not verified by SyncNet, not a link: <code>${safeText(facts.onchainWebsite, 120)}</code></dd>`);
    out.push('<dt>Copying</dt><dd><p class="note">Select an address to copy it in full.</p></dd>');
    out.push('</dl>', '</details></div></section>');
    out.push('<footer><div class="wrap">', '<p class="made">Project Home on SyncNet</p>');
    out.push('<p>Project Home content is provided by the Project Passport operator who signed it. SyncNet does not verify or endorse its claims. Token facts are read from Robinhood Chain. A Project Home stays active for as long as SyncNet operates the Project Home service. To report this page, see syncnet.capital/contact.html#report.</p>');
    out.push('</div></footer>', '</body>', '</html>');
    return out.join('\n');
  }

  return Object.freeze({
    CHAIN_ID, SCHEMA, DOMAIN, TYPES, MAX_SKEW, AUTHORITY_LABEL, PREVIOUS_LABEL, PREVIEW_LABEL, PRESETS, ACCENTS, CTA_LABELS,
    SECTIONS, SOCIALS, LIMITS, CID, RESERVED_CLAIMS, STYLESHEET, TERMS_VERSION,
    canonicalJson, configHash, typedData, digest, checkUrl, normalize, validate, externalLinks, render, escapeHtml: esc, escapeText: escText,
  });
});
