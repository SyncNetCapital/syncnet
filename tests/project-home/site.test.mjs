// Project Home shared site module: schema, normalize/validate, canonical hashing, EIP-712 domain separation, URL and
// text policy, and a static/adversarial audit of the PURE renderer (every hostile payload stays inert).
// Run: node tests/project-home/site.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));
const Site = require(path.join(ROOT, 'lib/syncnet-site.js'));
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));
const Economy = require(path.join(ROOT, 'lib/syncnet-economy.js'));

const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 300) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 300) + '\n'); } }
const TOKEN = '0x' + 'ab'.repeat(20);
const OP = '0x' + 'cd'.repeat(20);
const base = (over = {}) => ({ token: TOKEN, headline: 'Hello', about: 'Plain text.', ...over });
const norm = (over) => Site.normalize(base(over));
const errs = (over) => { const n = norm(over); return n.ok ? [] : n.errors.map((e) => e.field + ':' + e.code); };
const facts = { token: TOKEN, name: 'Sync Project', symbol: 'SYNCP', origin: { label: 'PAR', factory: '0x' + '11'.repeat(20) }, deployer: '0x' + '22'.repeat(20), markets: [{ pairToken: '0x' + '33'.repeat(20), symbol: 'USDG' }], passport: { operator: OP, operatorSince: '2026-09-01T00:00:00.000Z' } };
const render = (config, over = {}) => Site.render({ config, facts, authority: { signer: OP }, mode: 'published', ...over });

// ---------------------------------------------------------------- EIP-712 domain separation
check('domain is SyncNet Website v1 on chain 4663', Site.DOMAIN.name === 'SyncNet Website' && Site.DOMAIN.version === '1' && Site.DOMAIN.chainId === 4663);
check('domain differs from the Marketplace and Economy domains', Site.DOMAIN.name !== Market.DOMAIN.name && (!Economy.DOMAIN || Site.DOMAIN.name !== Economy.DOMAIN.name));
check('SitePublish type is exactly (token, operator, configHash, issuedAt, nonce)', JSON.stringify(Site.TYPES.SitePublish) === JSON.stringify([{ name: 'token', type: 'address' }, { name: 'operator', type: 'address' }, { name: 'configHash', type: 'bytes32' }, { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }]));
check('SiteUnpublish type is exactly (token, operator, issuedAt, nonce)', JSON.stringify(Site.TYPES.SiteUnpublish) === JSON.stringify([{ name: 'token', type: 'address' }, { name: 'operator', type: 'address' }, { name: 'issuedAt', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }]));
const msg = { token: TOKEN, operator: OP, issuedAt: 1790000000, nonce: '0x' + '0f'.repeat(32) };
const inSite = Site.digest('SiteUnpublish', msg);
const inMarket = Core.hashTypedData({ ...Site.typedData('SiteUnpublish', msg), domain: { ...Market.DOMAIN } });
check('identical struct → different digest in the Marketplace domain', inSite !== inMarket);
check('Unpublish and ActivationRequest share fields but never a digest (distinct type hashes)', Site.digest('ActivationRequest', msg) !== inSite);
const key = '0x' + '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const signer = Core._internal.secp256k1.privateKeyToAddress(key).toLowerCase();
const mSig = Core._internal.secp256k1.sign(Market.digest('ListingCancel', { listingId: '0x' + '0f'.repeat(32), seller: signer, nonce: '0x' + '0f'.repeat(32) }), key);
check('a Marketplace signature never recovers to its signer over a Website digest', (() => { try { return Core.recoverAddress(inSite, mSig).toLowerCase() !== signer; } catch { return true; } })());
const cSig = Core._internal.secp256k1.sign(Site.digest('SiteUnpublish', { ...msg, operator: signer }), key);
check('a Website signature recovers correctly in its own domain', Core.recoverAddress(Site.digest('SiteUnpublish', { ...msg, operator: signer }), cSig).toLowerCase() === signer);
check('unknown struct names are refused', (() => { try { Site.digest('OperatorClaim', msg); return false; } catch { return true; } })());

// ---------------------------------------------------------------- schema / canonical form
const n0 = norm();
check('normalize fills explicit defaults (preset CLEAN, accent BLUE, all sections on, no CTA)', n0.ok && n0.config.preset === 'CLEAN' && n0.config.accent === 'BLUE' && Object.values(n0.config.sections).every((v) => v === true) && n0.config.cta === null);
check('normalize is idempotent', JSON.stringify(Site.normalize(n0.config).config) === JSON.stringify(n0.config));
check('validate accepts a canonical config and returns its hash', Site.validate(n0.config).ok && Site.validate(n0.config).configHash === Site.configHash(n0.config));
const shuffled = Object.fromEntries(Object.entries(n0.config).reverse());
check('configHash is independent of key order', Site.configHash(shuffled) === Site.configHash(n0.config));
check('validate refuses a non-canonical config (e.g. lowercase preset)', !Site.validate({ ...n0.config, preset: 'clean' }).ok);
check('changing any content changes the hash', Site.configHash({ ...n0.config, headline: 'Hello!' }) !== Site.configHash(n0.config));
check('fixed section order', JSON.stringify(Site.SECTIONS) === JSON.stringify(['hero', 'about', 'tokenFacts', 'origin', 'socials', 'passport']));
check('sections can be toggled, not reordered or added', norm({ sections: { about: false } }).config.sections.about === false && errs({ sections: { lore: true } }).includes('sections.lore:unknown_field') && errs({ sections: { about: 'yes' } }).includes('sections.about:type'));
for (const f of ['html', 'css', 'js', 'script', 'iframe', 'embed', 'svg', 'lore', 'faq', 'analytics', 'domain', 'customDomain', 'subdomain', 'layout', 'order', 'markdown', 'theme', 'style', 'images', 'imageUrl']) {
  check('forbidden/unknown field rejected: ' + f, errs({ [f]: 'x' }).includes(f + ':unknown_field'));
}
check('presets are CLEAN / DARK / TERMINAL only', norm({ preset: 'terminal' }).ok && errs({ preset: 'NEON' }).includes('preset:invalid'));
check('accent from the fixed palette only (no colour strings)', errs({ accent: '#ff0000' }).includes('accent:invalid') && errs({ accent: 'red;background:url(x)' }).includes('accent:invalid'));
check('token must be an address', errs({ token: 'x' }).includes('token:invalid'));
check('schema other than v1 refused', errs({ schema: 'syncnet.site.v2' }).includes('schema:unsupported'));

// ---------------------------------------------------------------- text policy
check('headline <= 80 characters (code points)', norm({ headline: 'x'.repeat(80) }).ok && errs({ headline: 'x'.repeat(81) }).includes('headline:too_long'));
check('headline counts emoji as one character each', norm({ headline: '🚀'.repeat(80) }).ok && !norm({ headline: '🚀'.repeat(81) }).ok);
check('about <= 800 characters', norm({ about: 'y'.repeat(800) }).ok && errs({ about: 'y'.repeat(801) }).includes('about:too_long'));
check('oversized input is refused before normalisation work', errs({ about: 'z'.repeat(100000) }).includes('about:too_long'));
for (const [label, ch] of [['RLO U+202E', '\u202e'], ['LRI U+2066', '\u2066'], ['ALM U+061C', '؜'], ['ZWSP U+200B', '\u200b'], ['ZWJ U+200D', '\u200d'], ['BOM U+FEFF', '\ufeff'], ['soft hyphen', '­'], ['NUL', '\u0000'], ['BEL', '\u0007'], ['DEL', '\u007f'], ['C1 U+0085', '\u0085'], ['private use', ''], ['tag char', '\u{e0041}']]) {
  check('unsafe character rejected in headline: ' + label, errs({ headline: 'ab' + ch + 'cd' }).includes('headline:unsafe_chars'));
  check('unsafe character rejected in about: ' + label, errs({ about: 'ab' + ch + 'cd' }).includes('about:unsafe_chars'));
}
check('newline is allowed in about, not in headline (collapsed to a space)', norm({ about: 'a\nb' }).config.about === 'a\nb' && norm({ headline: 'a\nb' }).config.headline === 'a b');
check('NFC normalisation (e + combining acute → é)', norm({ headline: 'Café' }).config.headline === 'Café');
for (const claim of ['OFFICIAL WEBSITE', 'Official Site', '0ffіcial website', 'Verified by SyncNet', 'S Y N C N E T  V E R I F I E D', 'passport operator verified', 'ОFFICIAL WEBSITE']) {
  check('authority claims (incl. confusables/spacing) refused in operator text: ' + claim, errs({ headline: claim }).includes('headline:reserved_claim') && errs({ about: 'We are the ' + claim }).includes('about:reserved_claim'));
}
check('non-string text rejected', errs({ headline: 5 }).includes('headline:type') && errs({ about: ['x'] }).includes('about:type'));

// ---------------------------------------------------------------- URL policy (CTA)
const cta = (url, label = 'TRADE') => Site.normalize(base({ cta: { label, url } }));
const bad = [
  ['javascript:', 'javascript:alert(1)'], ['JaVaScRiPt:', 'JaVaScRiPt:alert(1)'], ['javascript with whitespace', ' javascript:alert(1)'], ['data:', 'data:text/html,<script>alert(1)</script>'],
  ['vbscript:', 'vbscript:msgbox'], ['http (not https)', 'http://example.com/'], ['protocol-relative', '//evil.example.com/'], ['backslash trick', 'https:\\\\evil.example.com'],
  ['userinfo', 'https://user:pass@example.com/'], ['userinfo @ confusion', 'https://good.com@evil.com/'], ['IPv4 literal', 'https://1.2.3.4/'], ['decimal IP', 'https://16909060/'],
  ['hex IP', 'https://0x7f000001/'], ['octal-ish IP', 'https://0177.0.0.1/'], ['IPv6 literal', 'https://[::1]/'], ['port 8443', 'https://example.com:8443/'], ['port 0', 'https://example.com:0/'],
  ['localhost', 'https://localhost/'], ['*.local', 'https://printer.local/'], ['*.internal', 'https://svc.internal/'], ['single label', 'https://intranet/'],
  ['raw Unicode host (must be punycode)', 'https://аpple.com/'], ['bidi in URL', 'https://example.com/\u202e/'], ['zero-width in URL', 'https://exa\u200bmple.com/'], ['space', 'https://example.com/a b'],
  ['newline', 'https://example.com/\nx'], ['too long', 'https://example.com/' + 'a'.repeat(300)], ['empty', ''], ['non-string', 42], ['file:', 'file:///etc/passwd'], ['ftp:', 'ftp://example.com/'],
  ['trailing-dot host', 'https://example.com./'], ['underscore host', 'https://ex_ample.com/'], ['numeric TLD', 'https://example.123/'],
];
for (const [label, url] of bad) check('CTA URL refused: ' + label, !cta(url).ok, JSON.stringify(cta(url).errors));
check('CTA https URL accepted and canonicalised', cta('https://App.Example.org/path?q=1#f').ok && cta('https://App.Example.org/path?q=1#f').config.cta.url === 'https://app.example.org/path?q=1#f');
check('default port 443 is normalised away, other ports refused', cta('https://example.com:443/').ok === false || cta('https://example.com:443/').config.cta.url === 'https://example.com/');
check('punycode (IDN) accepted and DISPLAYED in ASCII with a notice', (() => { const c = cta('https://xn--80ak6aa92e.com/').config; const h = render(c); return c && h.includes('xn--80ak6aa92e.com (internationalised domain, shown in ASCII form)'); })());
check('CTA label must be one of the fixed labels', !cta('https://example.com/', 'CLICK <b>HERE</b>').ok && !cta('https://example.com/', 'OFFICIAL WEBSITE').ok && cta('https://example.com/', 'view app').ok);
check('CTA with extra keys (e.g. target, rel, onclick) refused', !Site.normalize(base({ cta: { label: 'TRADE', url: 'https://example.com/', onclick: 'x' } })).ok);

// ---------------------------------------------------------------- social handles (SyncNet builds the URLs)
for (const [k, v] of [['x', 'evil.com/phish'], ['x', 'a'.repeat(16)], ['telegram', 'ab'], ['telegram', '../../x'], ['discord', 'https://discord.gg/abc'], ['farcaster', 'Bad Name'], ['x', 'javascript:alert(1)'], ['x', 'user\u200b']]) {
  check('social handle refused: ' + k + '=' + JSON.stringify(v), errs({ socials: { [k]: v } }).includes('socials.' + k + ':invalid_handle'));
}
check('unknown social network refused', errs({ socials: { myspace: 'x' } }).includes('socials.myspace:unknown_field'));
check('@ prefix stripped; URLs built by SyncNet', (() => { const c = norm({ socials: { x: '@syncnet', telegram: 'syncnet_chat', discord: 'abc-123', farcaster: 'sync.eth' } }).config; const l = Site.externalLinks(c).map((x) => x.href); return l.includes('https://x.com/syncnet') && l.includes('https://t.me/syncnet_chat') && l.includes('https://discord.gg/abc-123') && l.includes('https://farcaster.xyz/sync.eth'); })());

// ---------------------------------------------------------------- images
check('invalid image CIDs refused', errs({ logoCid: 'https://evil.example/x.png' }).includes('logoCid:invalid_cid') && errs({ heroCid: 'ipfs://bafy' }).includes('heroCid:invalid_cid') && errs({ logoCid: '../../etc' }).includes('logoCid:invalid_cid') && errs({ logoCid: 'data:image/svg+xml,<svg/onload=alert(1)>' }).includes('logoCid:invalid_cid'));
const cidOk = 'b' + 'a'.repeat(58);
check('a well-formed CID renders as a same-origin /site-img/ source', render(norm({ logoCid: cidOk }).config).includes('src="/site-img/' + cidOk + '"'));
check('an imageSrc hook returning a remote URL is dropped', !render(norm({ logoCid: cidOk }).config, { imageSrc: () => 'https://evil.example/x.png' }).includes('evil.example'));

// ---------------------------------------------------------------- renderer: authority, preview, escaping
const full = norm({ headline: 'Build with us', about: 'Para one.\n\nPara two with [a link](javascript:alert(1)) and <b>bold</b>.', socials: { x: 'syncnet' }, cta: { label: 'TRADE', url: 'https://app.example.org/t' } }).config;
const cur = render(full);
check('current operator → authority label + clickable links (rel=nofollow noopener noreferrer)', cur.includes(Site.AUTHORITY_LABEL) && cur.includes('href="https://app.example.org/t" rel="nofollow noopener noreferrer ugc"'));
const stale = Site.render({ config: full, facts, authority: { signer: '0x' + 'ee'.repeat(20) }, mode: 'published' });
check('signer ≠ current operator → PREVIOUS OPERATOR label, zero hrefs, noindex', stale.includes(Site.PREVIOUS_LABEL) && !/href=/.test(stale) && stale.includes('noindex') && !stale.includes(Site.AUTHORITY_LABEL));
const prev = Site.render({ config: full, facts, authority: { signer: OP }, mode: 'preview' });
check('preview: watermark PREVIEW · NOT PUBLISHED, noindex, no authority, no clickable link', prev.includes('PREVIEW · NOT PUBLISHED') && prev.includes('noindex') && !prev.includes(Site.AUTHORITY_LABEL) && !/href=/.test(prev));
check('Markdown links render as literal, inert text (scheme colon encoded), never as links', cur.includes('[a link](javascript&#58;alert(1))') && !/javascript:/i.test(cur) && (cur.match(/href=/g) || []).length === 2);
check('HTML in about is escaped', cur.includes('&lt;b&gt;bold&lt;/b&gt;') && !cur.includes('<b>bold'));
check('verified identity comes before any operator content', cur.indexOf('<header class="identity">') < cur.indexOf('Written by the Passport operator'));
check('operator content is labelled as such', (cur.match(/Written by the Passport operator/g) || []).length === 2);
check('Passport disclaimer: authority, not original-team identity', cur.includes('does not prove the identity of the historical or original team'));
check('product wording: active for as long as SyncNet operates the service (no perpetual promise)', cur.includes('for as long as SyncNet operates the Project Home service') && !/forever|perpetual/i.test(cur));
check('never OFFICIAL WEBSITE', !/official website/i.test(cur + stale + prev));
check('invalid config → no operator content at all', (() => { const h = Site.render({ config: { ...full, html: '<script>x</script>' }, facts, authority: { signer: OP } }); return !h.includes('Written by the Passport operator') && !h.includes('<script'); })());
const hostileFacts = { ...facts, name: '<script>alert(1)</script>\u202eEVIL', symbol: '"><img src=x onerror=alert(1)>', onchainWebsite: 'javascript:alert(document.cookie)', markets: [{ pairToken: '0x' + '44'.repeat(20), symbol: '<svg onload=alert(1)>' }], origin: { label: '<iframe src=//evil>', factory: 'not-an-address' } };
const hf = Site.render({ config: full, facts: hostileFacts, authority: { signer: OP } });
check('hostile on-chain metadata (name, symbol, website, market symbols, origin) stays inert text', !/<script|<img|<svg|<iframe|\son[a-z]+=|href="javascript/i.test(hf) && !hf.includes('\u202e'));
check('on-chain website field is never a link, even when it looks like one', !/href="javascript|href="[^"]*cookie/.test(hf) && hf.includes('not a link'));

// ---------------------------------------------------------------- static/adversarial render audit (fuzz)
const PAYLOADS = [
  '<script>alert(1)</script>', '<SCRIPT SRC=//evil.js></SCRIPT>', '"><script>alert(1)</script>', "'><img src=x onerror=alert(1)>", '<iframe src="https://evil">', '<svg/onload=alert(1)>',
  '<a href="javascript:alert(1)">x</a>', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', '<style>body{display:none}</style>', '<div style="background:url(javascript:alert(1))">',
  '<meta http-equiv="refresh" content="0;url=https://evil">', '<link rel=stylesheet href=//evil.css>', '<object data=x>', '<embed src=x>', '<form action=//evil><input name=p>', '<base href=//evil/>',
  '{{constructor.constructor("alert(1)")()}}', '${alert(1)}', '`onmouseover=alert(1)`', '&lt;script&gt;', '<!--', ']]>', '\\u003cscript\\u003e', 'onload=alert(1)', 'x" onfocus="alert(1)" autofocus="',
  '[click](javascript:alert(1))', '![img](https://evil/x.png)', '<img src=https://evil/track.gif>', 'expression(alert(1))', '<math><mtext></mtext></math>',
];
const rand = (n) => crypto.randomInt(n);
let audited = 0, violations = [];
const FORBIDDEN = [/<script/i, /<iframe/i, /<object/i, /<embed/i, /<svg/i, /<form/i, /<link/i, /<base/i, /<meta\s+http-equiv/i, /javascript:/i, /\bdata:/i, /\son[a-z]+\s*=/i, /\sstyle\s*=/i, /<style>(?!:root)/i]; // CSS expression() is only meaningful in a style context: the one stylesheet is checked to be the static one
for (let i = 0; i < 1500; i++) {
  const pick = () => PAYLOADS[rand(PAYLOADS.length)] + (rand(2) ? ' ' + PAYLOADS[rand(PAYLOADS.length)] : '');
  const raw = { token: TOKEN, headline: pick().slice(0, 80), about: (pick() + '\n\n' + pick()).slice(0, 800), preset: ['CLEAN', 'DARK', 'TERMINAL'][rand(3)], accent: Site.ACCENTS[rand(Site.ACCENTS.length)], socials: { x: rand(2) ? 'good_handle' : pick() }, cta: rand(2) ? { label: 'TRADE', url: rand(2) ? 'https://ok.example.org/' : pick() } : null };
  const n = Site.normalize(raw);
  const cfg = n.ok ? n.config : { ...Site.normalize({ token: TOKEN }).config, headline: pick() }; // invalid configs are rendered too (must render nothing operator-authored)
  for (const mode of ['published', 'preview']) {
    for (const signer of [OP, '0x' + 'ee'.repeat(20)]) {
      const h = Site.render({ config: cfg, facts: rand(3) ? facts : hostileFacts, authority: { signer }, mode });
      audited++;
      for (const re of FORBIDDEN) if (re.test(h)) { violations.push(re + ' in ' + JSON.stringify(raw).slice(0, 120)); break; }
      const hrefs = [...h.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&#61;/g, '=').replace(/&amp;/g, '&'));
      if (hrefs.some((u) => !Site.checkUrl(u).ok)) violations.push('non-policy href ' + hrefs.join(' '));
      const srcs = [...h.matchAll(/src="([^"]*)"/g)].map((m) => m[1]);
      if (srcs.some((s) => !/^\/site-img\/[A-Za-z0-9]+$/.test(s))) violations.push('non-same-origin img ' + srcs.join(' '));
      if (mode === 'preview' && /href=/.test(h)) violations.push('clickable link in preview');
      if (signer !== OP && /href=/.test(h)) violations.push('clickable link for a previous operator');
      if ((h.match(/<style>/g) || []).length !== 1 || !h.includes('<style>' + Site.STYLESHEET + '</style>')) violations.push('stylesheet not the static one');
    }
  }
}
check(`static render audit: ${audited} hostile renders, no script/iframe/object/svg/form/link/base/meta-refresh/javascript:/data:/on*=/style=`, violations.length === 0, violations.slice(0, 3).join(' | '));
check('the static stylesheet contains no url(), @import or expression()', !/url\(|@import|expression\(|javascript:/i.test(Site.STYLESHEET));
check('renderer source never emits a style= attribute or <script', !/style=|<script/i.test(fs.readFileSync(path.join(ROOT, 'lib/syncnet-site.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/project-home/site.results.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} project-home site checks passed`);
process.exit(failures ? 1 : 0);
