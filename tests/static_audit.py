from pathlib import Path
root=Path(__file__).resolve().parents[1]
active=['index.html','build.html','network.html','sync.html','marketplace.html','labs.html','token.html','registry.html']
for name in active:
    text=(root/name).read_text(encoding='utf-8')
    assert 'IGLOO' not in text
home=(root/'index.html').read_text(encoding='utf-8')
build=(root/'build.html').read_text(encoding='utf-8')
network=(root/'network.html').read_text(encoding='utf-8')
assert 'MAKE <span class="cyan">SYNC</span>' in home
assert 'id="tokenSearch"' in home and 'id="topologyGraph"' in home
assert 'id="mapToken"' in home and 'SYNC A PROJECT' in home
assert 'pages the current PAR launch history' in home
assert 'SYNCAT / CASHCAT' in home and 'SYNCAT / SYNC' in home
assert build.count('data-preset=') >= 2
assert 'Fees to holders' in build and 'value="creator"' in build and 'value="burn"' in build and 'value="floor"' in build and 'id="reviewRewards"' in build
assert 'input type="radio" name="feeMode" value="holders" checked' not in build  # no forced default
assert 'MAP A TOKEN' in network and 'id="topologyGraph"' in network
assert 'EXTERNAL INTEREST TOOLS' in network and 'pages the current PAR launch history' in network
assert 'GOOGLE TRENDS' in network and 'X LIVE SEARCH' in network
js=(root/'launch-engine-v2.js').read_text()
assert 'pairTokens' in js and 'raw.length>5' in js
assert 'eth_sendTransaction' not in js
builderjs=(root/'builder-v2.js').read_text()
assert 'eth_sendTransaction' in builderjs
assert "CANARY_REQUESTED=params0.get('live')==='canary'" in builderjs and "params0=new URL(location.href).searchParams" in builderjs
assert 'let CANARY_LIVE=false' in builderjs
assert 'canary-auth' in builderjs
assert 'metadataPreflight' in builderjs and 'Records.reverify' in builderjs  # RC: post-launch verification via launch records
redirects=(root/'_redirects').read_text(); assert '/project/* /token.html 200' in redirects and '/token/* /token.html 200' in redirects
print('SyncNet v2 static audit: PASS')

assert 'quote asset' not in build.lower()
assert 'quote eligibility' not in build.lower()
assert 'quote eligibility' not in (root/'builder-v2.js').read_text().lower()
assert 'audio' not in home.lower() and '<audio' not in home.lower()

registry=(root/'registry.html').read_text(encoding='utf-8')
projects=(root/'syncnet-projects.json').read_text(encoding='utf-8')
assert 'THE SYNCNET' in registry and 'REGISTRY.' in registry
assert 'SYNCNET-001' in projects and 'backfilled-origin' in projects
assert 'id="registryPreview"' in network
assert (root/'v2-registry.js').exists()

assert '$10 network fee' not in build
assert 'waive the planned' not in (root/'builder-v2.js').read_text()
assert 'PAR INDEXED' in (root/'v2-network.js').read_text()  # RC: label vocabulary
assert 'id="tokenSearch"' in home and 'id="tokenSearch"' in network

assert 'UPLOAD PROJECT IMAGE' in build and 'id="liveCanary"' in build and 'uploadAccessKey' not in build and 'Canary upload key' not in build
assert (root/'netlify/functions/ipfs-upload.js').exists()
assert 'PINATA_JWT' in (root/'netlify/functions/ipfs-upload.js').read_text()

assert (root/'netlify/functions/par-launches-all.js').exists()
assert 'THIS BROWSER ONLY' in (root/'v2-registry.js').read_text()
assert 'NOT PUBLIC' in (root/'v2-registry.js').read_text()  # RC: browser records never look public
assert 'recordHash' in (root/'launch-engine-v2.js').read_text()
# Marketplace V1 (real, non-custodial): production copy, canonical schema lib, server route
mphtml=(root/'marketplace.html').read_text(); mpjs=(root/'marketplace-v2.js').read_text()
for bad in ['MARKETPLACE LAB','LOCAL TEST','NO REAL PAYMENTS','SIMULAT','LOAD PONSYNC']: assert bad not in mphtml.upper(), 'lab wording in marketplace.html: '+bad
assert 'NON-CUSTODIAL' in mphtml and 'never holds funds' in mphtml.lower() and 'no escrow' in mphtml.lower()  # hero says non-custodial; the settlement facts stay in the rule cards
assert 'lib/syncnet-market.js' in mphtml and 'lib/syncnet-ipfs.js' in mphtml
mklib=(root/'lib/syncnet-market.js').read_text()
assert "name: 'SyncNet Marketplace'" in mklib and "version: '1'" in mklib and 'chainId: 4663' in mklib  # EIP-712 domain pinned
assert 'eth_signTypedData_v4' in mpjs and 'personal_sign' not in mpjs  # typed signatures only
assert 'localStorage.setItem' not in mpjs and 'sessionStorage' not in mpjs  # records live server-side only

# Post-Claude hardening
assert (root/'netlify/functions/canary-auth.js').exists()
auth=(root/'netlify/functions/canary-auth.js').read_text()
assert 'SYNCNET_CANARY_KEY' in auth and 'timingSafeEqual' in auth
assert '/api/par-launches-all' in (root/'v2-network.js').read_text()
assert 'PAGE_SIZE=500' in (root/'v2-network.js').read_text()
assert 'SYNCNET NETWORK ASSET' in projects
assert 'COMMUNITY BUILT · INDEPENDENT' not in home
assert 'MANUAL / OFF-CHAIN' in mphtml  # unverifiable items are labelled, not hidden
assert 'role="tab"' in build and 'aria-selected="true"' in build
assert 'syncnet.intent.v1' in (root/'launch-engine-v2.js').read_text()

# v2.2
css=(root/'v2.css').read_text()
assert '[hidden]{display:none!important}' in css
import re as _re
assert not _re.search(r'font-size:(7|8|9|10)px', css)
eng=(root/'launch-engine-v2.js').read_text()
for a in ['0x4B79B8298cd890A82dC9De1dE5dBb745Cf04353C','0x16c83D36539b6C92E6FC998D2a039fD7Ff31958E','0xA5e805856e513F01d6aC992aC45FE54E5e601829']: assert a in eng
assert "creatorFeeRecipient:draft.feeRecipient" in eng and "creatorFeeRecipient:VAULT" not in eng
up=(root/'netlify/functions/ipfs-upload.js').read_text()
assert 'SYNCNET_PUBLIC_UPLOADS' in (root/'netlify/lib/flags.js').read_text() and 'uploadSession.verify' in up and 'Add PINATA_JWT' not in up
for name in active:
    t=(root/name).read_text(encoding='utf-8')
    assert '>Build</a>' not in t and '>Explore</a>' not in t
assert 'verifyDeployment' in (root/'lib/syncnet-chain.js').read_text() and "scrollIntoView" in (root/'v2-network.js').read_text()
print('SyncNet v2.2 static audit additions: PASS')

# v2.3
import glob as _g, re as _r
_bidi=_r.compile('[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]')
for f in _g.glob(str(root/'*.js'))+_g.glob(str(root/'*.html'))+_g.glob(str(root/'netlify/**/*.js'),recursive=True):
    assert not _bidi.search(open(f,encoding='utf-8').read()), 'invisible/bidi character in source: '+f
kit=(root/'kit.html').read_text(encoding='utf-8'); kitjs=(root/'kit.js').read_text(encoding='utf-8')
assert 'syncnet.site.v1' in kitjs and 'No wallet connection' in kitjs and 'app.netlify.com/drop' in kit
sc=(root/'netlify/functions/site-check.js').read_text()
assert 'pinnedLookup' in sc and 'privateIp' in sc and 'MAX = 16 * 1024' in sc  # RC: DNS pinned, streamed cap
b=(root/'builder-v2.js').read_text()
assert "id===4663" in b and 'syncnet_rehearsal_' in b and "127\\.0\\.0\\.1" in b
assert 'renderPassport' in (root/'v2-token.js').read_text() and 'Community Takeover' in (root/'build.html').read_text()
assert (root/'docs/REHEARSAL.md').exists()
print('SyncNet v2.3 static audit additions: PASS')

# v2.4 website decision + draft
bh=(root/'build.html').read_text(encoding='utf-8'); bj=(root/'builder-v2.js').read_text()
assert bh.count('name="websiteChoice"')==3 and 'id="reviewWebsiteCta"' in bh and 'id="draftBanner"' in bh
assert "DRAFT_KEY=KEY_NS+'builder_draft_v1'" in bj and 'eligible:false' in bj  # restored connections are re-verified
print('SyncNet v2.4 static audit additions: PASS')

# v2.5 opening buy
eng=(root/'launch-engine-v2.js').read_text()
assert "ROUTER='0x458D2a59c2F3dd32775a64eE72004561440d64Df'" in eng and "'launchForwarder'" in eng and "functionName:'route'" in eng
assert 'minTokensOut' in eng and 'MAX_OPENING_BUY_WEI' in eng and 'openingBuy:draft.openingBuyWei>0n' in eng
assert 'eth_sendTransaction' not in eng
bh=(root/'build.html').read_text(encoding='utf-8')
assert 'id="openingBuy"' in bh and 'id="liveValue"' in bh and 'class="tax-btn" type="button" data-buy' not in bh
print('SyncNet v2.5 static audit additions: PASS')

# ======================================================================================= V2.5 RELEASE CANDIDATE
import json as _j, glob as _gl, re as _re2
lib_core=(root/'lib/syncnet-core.js').read_text(); lib_chain=(root/'lib/syncnet-chain.js').read_text(); lib_prov=(root/'lib/syncnet-provenance.js').read_text()
recs=(root/'launch-records.js').read_text(); bj=(root/'builder-v2.js').read_text(); bh=(root/'build.html').read_text(encoding='utf-8')
# script order: core -> chain -> records -> engine -> builder
order=[bh.index(x) for x in ['/lib/syncnet-core.js','/lib/syncnet-chain.js','/launch-records.js','/launch-engine-v2.js','/builder-v2.js']]
assert order==sorted(order), 'build.html script order'
# H1: immutable snapshot + write-ahead record before the wallet request
launch_src=bj[bj.index("$('launchLive')?.addEventListener('click'"):]
assert 'const P=lastPrepared; // immutable snapshot' in launch_src
send_src=bj[bj.index('async function sendLaunch(P){'):]
assert send_src.index("state:'BROADCAST_ATTEMPTED'") < send_src.index("method:'eth_sendTransaction'"), 'record must be written before eth_sendTransaction'
assert 'withLaunchLock' in bj and "state:'BROADCAST_UNKNOWN'" in bj and 'watchForToken' in bj
for st in ['PREPARED','SIGNATURE_VALID','BROADCAST_ATTEMPTED','BROADCAST_UNKNOWN','TX_HASH_RECEIVED','MINED','ONCHAIN_VERIFIED','INDEXER_PENDING','FULLY_VERIFIED','FAILED_PRE_BROADCAST','FAILED_POST_BROADCAST']: assert "'"+st+"'" in recs, st
assert 'A deployed launch cannot be marked as not sent' in recs and 'cannot be reset' in recs
# M1: signature bound to P; verified before LAUNCH is enabled
assert 'function signatureValidFor(P)' in bj and "if(P&&!signatureValidFor(P))b.push" in bj and 'lastPrepared!==P' in bj
# L3 / first-launch UX
assert 'MAINNET · REAL FUNDS' in bj and 'I UNDERSTAND THIS LAUNCH IS REAL AND IRREVERSIBLE.' in bj and 'id="networkBanner"' in bh
assert 'Unrecognised rehearsal parameter' in bj and "wallet_switchEthereumChain" in bj and "confirm('Switch your wallet to Robinhood Chain MAINNET" in bj
# L2: no hard-coded PAR fee copy; live values
assert 'PAR base fee 1%' not in bh and '<strong id="feeTotalPct">2%</strong>' not in bh
assert "commitment" in (root/'launch-engine-v2.js').read_text() and 'previewLaunchEconomics' in (root/'launch-engine-v2.js').read_text()
# no approvals anywhere in the site code (NO APPROVAL SURPRISES)
site_js=[f for f in _gl.glob(str(root/'*.js'))+_gl.glob(str(root/'lib/*.js'))+_gl.glob(str(root/'netlify/**/*.js'),recursive=True)]
for f in site_js:
    t=open(f,encoding='utf-8').read()
    assert '0x095ea7b3' not in t and 'approve(address' not in t and 'permit(' not in t, 'approval code in '+f
    if not (f.endswith('builder-v2.js') or f.endswith('marketplace-v2.js')): assert "method:'eth_sendTransaction'" not in t and 'method: \'eth_sendTransaction\'' not in t, 'only the builder and the marketplace deal room may send: '+f
# the marketplace's two sends are exactly: a plain value transfer to the seller (data '0x') and the launchpad's own
# fee transfer, built ONLY by SyncNetOrigins.feeTransferTx for a canonical factory (PAR single/multi, Pons V2)
_mp=(root/'marketplace-v2.js').read_text()
assert _mp.count("method:'eth_sendTransaction'")==2, 'marketplace send count changed'
assert "to:d.seller,value:'0x'+wei.toString(16),data:'0x'" in _mp, 'payment must stay a plain transfer'
assert "const tx=Origins.feeTransferTx(project,d.token,d.buyer);" in _mp and "params:[{from:account,to:tx.to,data:tx.data,value:'0x0'}]" in _mp, 'fee transfer must come from the single validated builder'
assert "functionSelector('transferCreatorFeeRecipient" not in _mp, 'no hand-built fee calldata in the page'
_org=(root/'lib/syncnet-origins.js').read_text()
assert "const PONS_V2_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';" in _org  # ponsdotdev/pons-labs README, EIP-55 checked
assert "const PAR_FACTORIES = Object.freeze([lc(Chain.ROBINHOOD.multiFactory), lc(Chain.ROBINHOOD.factory)]);" in _org
assert "const FEE_FACTORIES = Object.freeze(PAR_FACTORIES.concat([PONS_V2_FACTORY]));" in _org, 'fee-transfer destinations must be exactly the canonical factories'
assert "if (!FEE_FACTORIES.includes(to)) throw" in _org and "transferCreatorFeeRecipient: Core.functionSelector('transferCreatorFeeRecipient(address,address)')" in _org
assert _org.count('functionSelector(') == 6 and 'eth_sendTransaction' not in _org, 'origins lib: read selectors (incl. launchFactory) + the one fee-transfer selector only'
# Pons V1: detection only, exactly two canonical factories, bidirectional evidence, never a fee-transfer destination
assert "Object.freeze({ address: '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', generation: 'ACTIVE' })," in _org
assert "Object.freeze({ address: '0x0c37a24f5d23a486fa692d1500881d698b1f77a4', generation: 'LEGACY' })," in _org
assert "const factory = PONS_V1_FACTORIES.find((f) => f.address === claimed);\n    if (!factory) return null;" in _org, 'V1 origin only from an allowlisted factory named by the token itself'
assert "if (r[11] !== true || lc(r[0]) !== t) return null;" in _org, 'V1 origin requires exists && record.token == token'
assert "supported: false, token: t, factory: v1.factory" in _org, 'Pons V1 is never supported'
assert 'PONS_V1' not in _org.split('function feeTransferTx')[1].split("throw new Error('Unsupported project origin.')")[0].replace("project.origin === 'PAR' || project.origin === 'PONS_V2'", ''), 'fee transfers never for V1'
assert "if (r[14] !== true || lc(r[0]) !== t) return null;" in _org, 'Pons V2 origin requires exists && record.token == token'
# M3 / M4 / L4 / L8 / L13
tok=(root/'v2-token.js').read_text(); net=(root/'v2-network.js').read_text(); mp=(root/'marketplace-v2.js').read_text()
assert 'NOT VERIFIED AS A PAR LAUNCH' in tok and tok.index('Chain.readLaunch(rpc,a)') < tok.index("if(isPar&&usedBy.length)badges.push('<span class=\"badge\">NETWORK HUB</span>')")
assert "pairSym(m)==='SYNC'" not in net and 'same(pairAddr(m),SYNC)' in net
assert 'controlChallenge' not in lib_prov and 'verifyControl' not in lib_prov  # old prototype model removed for good
ipfs_lib=(root/'lib/syncnet-ipfs.js').read_text()
assert ipfs_lib.index('gateway.pinata.cloud/ipfs/') < ipfs_lib.index('https://ipfs.io/ipfs/') < ipfs_lib.index('dweb.link/ipfs/')  # display gateway order
for f in site_js:
    if f.endswith('syncnet-ipfs.js') or f.endswith('kit.js') or '/netlify/' in f.replace('\\\\','/'): continue
    t=open(f,encoding='utf-8').read()
    assert 'ipfs.io/ipfs/' not in t and 'dweb.link/ipfs/' not in t and 'gateway.pinata.cloud/ipfs/' not in t, 'gateway concatenation outside the canonical utility: '+f
assert 'Expected (signed intent)' in tok and 'INSECURE LINK' in tok and "'Token'" not in tok.split('function websiteView')[0][-400:]
for label in ['SYNCNET ORIGIN','BUILT WITH SYNCNET · VERIFIED','OPERATOR VERIFIED','PAR INDEXED','PROFILE ONLY','UNVERIFIED']: assert label in lib_prov, label
# L5 / L7 / L6
assert 'PAR_BYTE_LIMITS' in lib_core and 'findUnsafeChars' in lib_core and 'recipientStaticCheck' in lib_chain
# server: gate, uploads, auth, guard, registry, errors
toml=(root/'netlify.toml').read_text(); red=(root/'_redirects').read_text()
for fn in ['config','launch-guard','registry','upload-auth','ipfs-upload','canary-auth','site-check','par-launches-all','par-tokenlist','ipfs-check','marketplace','economies']:
    assert (root/('netlify/functions/'+fn+'.js')).exists(), fn
    assert '/api/'+fn in toml and '/api/'+fn+' /.netlify/functions/'+fn+' 200' in red, 'route '+fn
assert 'par.family/tokenlist.json' not in red and 'to = "https://par.family' not in toml  # L14: no same-origin proxy
assert "script-src 'self'" in toml and "unsafe-eval" not in toml
assert '/tests/* /404.html 404!' in red and '/docs/* /404.html 404!' in red
up=(root/'netlify/functions/ipfs-upload.js').read_text(); fl=(root/'netlify/lib/flags.js').read_text()
assert 'sanitizeImage' in up and 'x-syncnet-upload-key' not in up and "scopes = gate.publicUploads ? ['founder', 'wallet'] : ['founder']" in up
assert "requested.publicUploads && !uploadsKilled && pinata && sessions && durable" in fl and "requested.publicLaunch && durable" in fl
assert "durable && !marketplaceKilled" in fl  # marketplace: on only with a durable store, kill switch honoured
assert 'MIN_KEY_LENGTH = 32' in (root/'netlify/functions/canary-auth.js').read_text()
assert 'verifyEvidence' in (root/'netlify/functions/registry.js').read_text()
for f in _gl.glob(str(root/'netlify/functions/*.js')):
    t=open(f,encoding='utf-8').read()
    assert not _re2.search(r"json\(\s*5\d\d\s*,\s*\{\s*error:\s*String\(", t), 'raw error text returned in '+f
# invisible / bidi characters in every shipped text file (tests may contain them only as \u escapes)
_inv=_re2.compile('[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]')
shipped=[f for f in _gl.glob(str(root/'**/*'),recursive=True) if f.endswith(('.js','.mjs','.html','.css','.json','.md','.toml')) and '/vendor/' not in f and '/.git/' not in f and not f.endswith('.results.json') and not f.endswith('static_audit.py')]
bad=[f for f in shipped if _inv.search(open(f,encoding='utf-8').read())]
assert not bad, 'invisible characters in: '+', '.join(bad)
# canonical identities are addresses
pj=_j.loads(projects)
assert all(p['token'].startswith('0x') and len(p['token'])==42 for p in pj['projects'] if p.get('registry',{}).get('canonical'))
print('SyncNet V2.5 RC static audit additions: PASS')
# IPFS hotfix: the metadata preflight's blocking step is the server-side /api/ipfs-check, never a browser <img> load
_mp=builderjs[builderjs.index('async function metadataPreflight('):]
_mp=_mp[:_mp.index('\n}\n')]
assert 'serverIpfsCheck(uri)' in _mp and 'loadImage(' not in _mp and 'lastMetadataOk=true' in _mp
assert _mp.index('if(!check.ok)throw') < _mp.index('lastMetadataOk=true')
_ic=(root/'netlify/functions/ipfs-check.js').read_text()
assert "GATEWAYS = Object.freeze(['https://gateway.pinata.cloud', 'https://ipfs.io', 'https://dweb.link'])" in _ic and 'gateway\\.pinata\\.cloud|ipfs\\.io|dweb\\.link|' in _ic and 'Promise.any(GATEWAYS' in _ic and "redirect: 'manual'" in _ic and 'MAX_BYTES = 5 * 1024 * 1024' in _ic
assert 'Sanitizer._internal.decodePng' in _ic and 'Sanitizer._internal.decodeGif' in _ic and "u.protocol !== 'https:'" in _ic
print('SyncNet V2.5 RC IPFS hotfix static audit: PASS')

# Economies V0: derived membership, append-only curation, its own EIP-712 domain, flags.js gate, no Marketplace writes
import json as _je, re as _re3
_eco_fn=(root/'netlify/functions/economies.js').read_text(); _eco_lib=(root/'lib/syncnet-economy.js').read_text()
_eco_page=(root/'economy.html').read_text()+(root/'economy-v2.js').read_text(); _fl=(root/'netlify/lib/flags.js').read_text()
assert "name: 'SyncNet Economies'" in _eco_lib and "name: 'SyncNet Marketplace'" not in _eco_lib
assert "economyCuration: requested.economyCuration && durable && !economiesKilled" in _fl and 'gate.economyCuration' in _eco_fn
assert not _re3.search(r'env\.SYNCNET_|process\.env\.', _eco_fn)  # the gate lives in flags.js only
assert not _re3.search(r'store\.(set|del)\(', _eco_fn) and 'store.sadd(K.curation' in _eco_fn and 'store.sadd(K.requests' in _eco_fn
assert len(_re3.findall(r'`mp:', _eco_fn))==1 and 'passport: (token) => `mp:passport:v1:${token}`' in _eco_fn and 'reg:' not in _eco_fn
assert '/economy.html /' not in (root/'_redirects').read_text() and '/economy /economy.html 200' in (root/'_redirects').read_text()
assert 'lib/syncnet-economy.js' in toml and 'syncnet-economies.json' in toml
_grants=_je.loads((root/'syncnet-economies.json').read_text())
assert _grants['version']==1 and isinstance(_grants['curators'],list)
_roots=[g['root'] for g in _grants['curators']]
assert len(set(_roots))==len(_roots) and all(_re3.fullmatch(r'0x[0-9a-f]{40}',g['root']) and _re3.fullmatch(r'0x[0-9a-f]{40}',g['curator']) for g in _grants['curators'])
assert 'PARENT-RECOGNIZED' in _eco_lib and 'OUTSIDE CURRENT INDEX WINDOW' in _eco_lib and 'OFFICIAL' not in _eco_page and 'OFFICIAL' not in _eco_lib
assert not _re3.search(r'\.(volume\w*|tvl\w*|marketCap\w*|liquidityUsd|fees(Usd|Total)\w*)\b', _eco_page+_eco_lib+_eco_fn, _re3.I)  # no aggregate metrics are read or shown
assert '/build.html?with=' in _eco_page and 'localStorage' not in (root/'economy-v2.js').read_text()
for _f in ['marketplace.js']: assert 'econom' not in (root/'netlify/functions'/_f).read_text().lower()
assert "view === 'requests'" not in _eco_fn and 'evidenceUrl: r.evidenceUrl' not in _eco_fn  # pending requests are never served
_h=_eco_fn[_eco_fn.index('async function handler('):_eco_fn.index('async function curate(')]
assert "'eco-wallet'" not in _h and 'walletLimited(' not in _h  # no wallet bucket before signature verification
_c=_eco_fn[_eco_fn.index('async function claimRequest('):]
assert _c.index("'eco-claim-all'") > _c.index('verifySig(') and _c.index("'eco-claim'") < _c.index('verifySig(')  # global claim budget counts verified requests only
_cu=_eco_fn[_eco_fn.index('async function curate('):_eco_fn.index('async function claimRequest(')]
assert _cu.index('walletLimited(') > _cu.index('duplicate: true') and _cu.index('walletLimited(') > _cu.index("'stale'") and _cu.index('walletLimited(') > _cu.index("'full'")  # replays consume no quota
assert _c.index('walletLimited(') > _c.index('duplicate: true') and _c.index("'eco-claim-all'") > _c.index('duplicate: true')
_mpsrv=(root/'netlify/functions/marketplace.js').read_text()
assert "type: 'operator-superseded'" not in _mpsrv, 'no fee-recipient takeover of a Passport'
assert "if (passport && lc(passport.operator) !== operator)" in _mpsrv, 'existing Passport: only its operator may claim'
print('SyncNet Economies V0 static audit: PASS')

# Project Home foundation: closed by default, own EIP-712 domain, no UI/nav, strict renderer, reviewed pricing, no deploy
_ph=(root/'netlify/functions/project-home.js').read_text(); _site_fn=(root/'netlify/functions/site.js').read_text()
_site_lib=(root/'lib/syncnet-site.js').read_text(); _phcfg=(root/'netlify/lib/project-home-config.js').read_text()
_price=_je.loads((root/'syncnet-project-home-pricing.json').read_text())
assert "name: 'SyncNet Website'" in _site_lib and "name: 'SyncNet Marketplace'" not in _site_lib and "name: 'SyncNet Economies'" not in _site_lib
assert "truthy(env.SYNCNET_PROJECT_HOME_ENABLED)" in _phcfg and "truthy(env.SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED)" in _phcfg  # exact "true" only
assert 'siteEnabled && paymentsRequested && Boolean(price && rate && sink)' in _phcfg
assert _price['rates']==[] and [p['priceUsdCents'] for p in _price['prices']]==[3900]  # $39 USD; no rate approved yet
assert '/api/project-home /.netlify/functions/project-home 200' in red and '/site/:token /.netlify/functions/site?token=:token 200!' in red and '/site-img/:cid /.netlify/functions/site-img?cid=:cid 200!' in red
assert '/contracts/* /404.html 404!' in red and 'from = "/contracts/*"' in toml
assert 'lib/syncnet-site.js' in toml and 'lib/syncnet-project-home-pricing.js' in toml and 'syncnet-project-home-pricing.json' in toml
assert "default-src 'none'; style-src ${STYLE_HASH}; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" in _site_fn
assert "'cache-control': 'no-store'" in _site_fn and 'authority: { signer: rev.signer }' in _site_fn
assert not _re3.search(r'store\.(set|del|sadd)\(', _ph) and 'store.cas(' in _ph and 'eth_getLogs' not in _ph
assert 'OFFICIAL WEBSITE' not in _site_lib.upper().replace("'OFFICIALWEBSITE'", '') or 'officialwebsite' in _site_lib  # only as a refused claim
for _pg in _gl.glob(str(root/'*.html')):
    _t=open(_pg,encoding='utf-8').read()
    assert 'project-home' not in _t and '/site/' not in _t and 'Websites' not in _t, 'no Project Home UI / nav yet: '+_pg
for _f in _gl.glob(str(root/'*.js')):
    assert '/api/project-home' not in open(_f,encoding='utf-8').read(), 'no browser client for Project Home yet: '+_f
_sink=(root/'contracts/project-home-sink/src/SyncNetProjectHomeSink.sol').read_text()
assert 'immutable SYNC;' in _sink and 'immutable TREASURY_CONVERTER;' in _sink and 'BURN_PERCENT = 60' in _sink and 'delegatecall' not in _sink
assert not _re3.search(r'usdg|router|slippage|minOut|oracle', _re3.sub(r'//[^\n]*', '', _sink), _re3.I)  # the sink's code stays DEX-free
_conv=_re3.sub(r'//[^\n]*', '', (root/'contracts/project-home-sink/src/SyncNetProjectHomeTreasuryConverter.sol').read_text())
for _imm in ['immutable SYNC;','immutable USDG;','immutable TREASURY;','immutable ROUTER;','immutable MARKET;']: assert _imm in _conv, _imm
assert 'if (msg.sender != TREASURY) revert NotTreasury();' in _conv and 'if (minUsdgOut == 0) revert ZeroMinOut();' in _conv and 'USDG.transfer(TREASURY, delivered)' in _conv
assert 'delegatecall' not in _conv and '.call(' not in _conv and 'payable' not in _conv and not _re3.search(r'function\s+set[A-Z]|rescue|sweep|withdraw', _conv)
_dc=(root/'contracts/project-home-sink/script/DeployChecks.sol').read_text()
assert '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' in _dc and '0x458D2a59c2F3dd32775a64eE72004561440d64Df' in _dc and 'SYNC_USDG_MARKET = 1' in _dc
assert not list((root/'contracts/project-home-sink').glob('broadcast/**/*.json')), 'no deployment broadcast may exist'
print('SyncNet Project Home foundation static audit: PASS')
