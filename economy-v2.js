(function(){'use strict';
/*
 * SyncNet Economy view (client). /economy.html?root=0x…
 *  - Membership is DERIVED here from /api/par-launches-all: every PAR launch with a market paired with the root,
 *    matched by contract address (never by ticker). Nothing about membership is stored anywhere.
 *  - Recognitions come from /api/economies: one-sided EIP-712 statements by the root's CURRENT curator
 *    (Project Passport operator, or a reviewed manual curator). Labelled PARENT-RECOGNIZED, never "official".
 *  - A recognized project that the current indexer data does not show is labelled as such: its connection was
 *    verified on-chain when it was recognized, and the page never claims the indexer confirms it now.
 *  - "Create a project in this Economy" only opens the Builder with its existing ?with= prefill.
 *  - PONS V2 (only when the deployment enables discovery: /api/pons-economy answers enabled:true): canonical PONS V2
 *    launches LAUNCHED AGAINST the root, loaded independently of PAR, page by page ("LOAD MORE"), in their own
 *    section and with their own labels. A PONS failure shows one neutral note and never hides the PAR data. When the
 *    endpoint answers enabled:false the page renders exactly as it did before PONS discovery existed.
 *  - Solana (?root=<mint>, case preserved via lib/syncnet-assets.js): a separate read-only view fed only by
 *    /api/pump-economy (see solanaEconomy below). The EVM path above is untouched by it.
 *  - No volume/TVL/fee aggregates. No global ranking of Economies. Nothing is written to browser storage.
 */
const Core=window.SyncNetCore,Chain=window.SyncNetChain,Eco=window.SyncNetEconomy,Origins=window.SyncNetOrigins;
const $=id=>document.getElementById(id);
if(!$('ecoCard')||!Eco)return;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const disp=(v,n=64)=>Core.sanitizeForDisplay(String(v??''),{maxLength:n});
const sym=v=>{const s=disp(v,32).replace(/^\$/,'').toUpperCase();return s&&s.length<=16?s:''};
const lc=v=>String(v||'').toLowerCase();
const short=a=>/^0x[0-9a-fA-F]{40}$/.test(String(a||''))?a.slice(0,6)+'…'+a.slice(-4):String(a||'');
const when=t=>{try{return new Date(t).toISOString().slice(0,10)}catch{return''}};
const nonce=()=>{const a=new Uint8Array(32);crypto.getRandomValues(a);return'0x'+[...a].map(b=>b.toString(16).padStart(2,'0')).join('')};
const rpc=Chain.makeRpc(Chain.ROBINHOOD.rpcUrl,{timeoutMs:10000,retries:1});
const SHOW=120;

const Assets=window.SyncNetAssets;
// The raw ?root= value, case preserved: a Solana mint is case-sensitive and is never lowercased. A 0x root is
// lowercased exactly as before.
const rawRoot=String(new URL(location.href).searchParams.get('root')||'').trim();
if(Assets&&Assets.isSolanaMint(rawRoot)){solanaEconomy(rawRoot);return}
const root=lc(rawRoot);
if(!Eco.isRootAddr(root)){
 $('ecoPick').hidden=false;$('ecoTitle').textContent='OPEN AN ECONOMY';
 const bad=m=>{$('ecoPickStatus').textContent=m;$('ecoPickStatus').className='asset-status fail'};
 const nativeMsg='Native SOL is not a token mint. Pump.fun launches against native SOL are not included in this V0 index.';
 if(rawRoot)bad(Assets&&Assets.isNativeSol(rawRoot)?nativeMsg:'That is not a Robinhood Chain contract address or a Solana mint (base58, exact case).');
 const go=()=>{const a=$('ecoRootInput').value.trim();if(Eco.isRootAddr(a))location.href='/economy.html?root='+encodeURIComponent(a.toLowerCase());else if(Assets&&Assets.isSolanaMint(a))location.href='/economy.html?root='+encodeURIComponent(a);else bad(Assets&&Assets.isNativeSol(a)?nativeMsg:'That is not a contract address (0x followed by 40 hex characters) or a Solana mint (base58, exact case).')};
 $('ecoOpen').addEventListener('click',go);$('ecoRootInput').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
 return;
}

// ---------------------------------------------------------------- wallet (same discovery + chooser model as the Marketplace)
let provider=null,account='';
const providers=[],providerSet=new Set();
function providerLabel(p,info){if(info?.name)return info.name;if(p?.isBraveWallet)return 'Brave Wallet';if(p?.isPhantom)return 'Phantom';if(p?.isRabby)return 'Rabby';if(p?.isMetaMask)return 'MetaMask';return 'EVM wallet'}
function addProvider(p,info){if(!p||typeof p.request!=='function'||providerSet.has(p))return;if(info?.rdns&&providers.some(x=>x.rdns===info.rdns))return;providerSet.add(p);providers.push({provider:p,name:info?.name||providerLabel(p,info),rdns:info?.rdns||''})}
function discoverLegacy(){if(providers.length)return;const legacy=window.ethereum?.providers?.length?window.ethereum.providers:[window.ethereum].filter(Boolean);legacy.forEach(p=>addProvider(p))}
window.addEventListener('eip6963:announceProvider',e=>addProvider(e.detail?.provider,e.detail?.info));window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(discoverLegacy,450);
const bound=new WeakSet();
function bind(p){if(typeof p.on!=='function'||bound.has(p))return;bound.add(p);p.on('accountsChanged',a=>{if(p!==provider)return;account=lc(a?.[0]||'');renderWallet();render()});p.on('disconnect',()=>{if(p!==provider)return;provider=null;account='';renderWallet();render()})}
let walletReturnFocus=null;
function closeWalletModal(){$('ecoWalletModal').classList.remove('open');walletReturnFocus?.focus?.()}
function openWallet(){
 discoverLegacy();
 if(!providers.length){note('No EVM wallet was found in this browser.','fail');return}
 if(providers.length===1){connectTo(providers[0].provider);return}
 walletReturnFocus=document.activeElement;const host=$('ecoProviderList');host.innerHTML='';
 providers.forEach(d=>{const b=document.createElement('button');b.className='provider';b.type='button';b.textContent=d.name;b.addEventListener('click',()=>connectTo(d.provider));host.appendChild(b)});
 $('ecoWalletModal').classList.add('open');requestAnimationFrame(()=>(host.querySelector('button')||$('ecoCloseWallet'))?.focus());
}
// Phantom with a Solana-only account selected cannot expose an EVM account: explained by wallet-evm-notice.js; every other error keeps the generic note.
const walletInfo=p=>providers.find(x=>x.provider===p)||null;
async function connectTo(p){
 try{provider=p;bind(p);const accounts=await p.request({method:'eth_requestAccounts'});window.SyncNetEvmNotice?.check(p,walletInfo(p),accounts);account=lc(accounts?.[0]||'');note('');window.SyncNetEvmNotice?.hide();closeWalletModal()}catch(e){provider=null;account='';if(window.SyncNetEvmNotice?.matches(p,walletInfo(p),e)){note('');closeWalletModal();window.SyncNetEvmNotice.show({onRetry:()=>connectTo(p),returnFocus:$('ecoConnect')})}else note('Wallet connection did not complete.','fail')}
 renderWallet();render();
}
function renderWallet(){
 $('ecoWalletName').textContent=account?short(account):'Not connected';
 $('ecoConnect').textContent=account?'Change wallet':'Connect wallet';
 const cur=state.eco&&state.eco.curator;
 $('ecoWalletNote').textContent=!account?'Browsing needs no wallet. Only the root’s current curator can recognize projects.':cur&&cur.address===account?'You are this root’s current curator. Recognizing or revoking is one free EIP-712 signature — never a transaction.':'This wallet is not the current curator of this root.';
}
$('ecoConnect').addEventListener('click',openWallet);
$('ecoCloseWallet').addEventListener('click',closeWalletModal);
$('ecoWalletModal').addEventListener('click',e=>{if(e.target===$('ecoWalletModal'))closeWalletModal()});
$('ecoWalletModal').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeWalletModal()}});
async function signTyped(kind,message){
 if(!provider||!account)throw Error('Connect a wallet first.');
 try{return await provider.request({method:'eth_signTypedData_v4',params:[account,JSON.stringify(Eco.typedData(kind,message))]})}
 catch(e){
  if(e&&(e.code===4001||/rejected|denied/i.test(String(e.message))))throw Error('You rejected the signature. Nothing was saved.');
  throw Error('The wallet could not sign EIP-712 typed data.');
 }
}
function note(text,cls){const n=$('ecoNote');n.hidden=!text;n.textContent=text||'';n.className='asset-status'+(cls?' '+cls:'')}

// ---------------------------------------------------------------- data
const state={launches:null,coverage:null,eco:null,rootRow:null,rootLaunch:undefined,meta:null,canonical:[],busy:false,
 pons:{enabled:false,error:false,total:0,items:[],nextCursor:null,through:null,stale:false,loading:false},rootPons:undefined};
const PONS_PAGE=24;
const ponsOn=()=>state.pons.enabled===true;
// One page of PONS V2 children. 404 {enabled:false} = discovery off on this deployment (render nothing, as before).
async function loadPons(cursor){
 const P=state.pons;if(P.loading)return;P.loading=true;
 try{
  const r=await fetch('/api/pons-economy?root='+root+'&limit='+PONS_PAGE+(cursor?'&cursor='+encodeURIComponent(cursor):''),{cache:'no-store'});
  const j=await r.json().catch(()=>({}));
  if(j&&j.enabled===false){P.enabled=false;return}
  P.enabled=true;
  if(!r.ok||!Array.isArray(j.items)){P.error=true;return}
  const seen=new Set(P.items.map(i=>i.token));
  for(const it of j.items)if(Eco.isAddr(it?.token)&&!seen.has(lc(it.token))){seen.add(lc(it.token));P.items.push({...it,token:lc(it.token)})}
  P.error=false;P.total=Number(j.total)||0;P.nextCursor=typeof j.nextCursor==='string'?j.nextCursor:null;P.through=Number.isFinite(j.indexedThroughBlock)?j.indexedThroughBlock:null;P.stale=Boolean(j.stale);
 }catch{P.enabled=true;P.error=true}
 finally{P.loading=false}
}
// The root's own canonical PONS V2 record (live factory read, never the discovery index): curator UX + badge.
async function loadRootPons(){
 if(!ponsOn()||!Origins||typeof Origins.readPonsV2Launch!=='function'){state.rootPons=null;return}
 if(state.rootLaunch&&state.rootLaunch!=='unavailable'){state.rootPons=null;return}
 try{state.rootPons=await Origins.readPonsV2Launch(rpc,root)}catch{state.rootPons='unavailable'}
}
async function getJson(url){const r=await fetch(url,{cache:'no-store'});const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(Error(j.error||'unavailable'),{body:j});return j}
async function loadEconomy(){try{state.eco=await getJson('/api/economies?view=economy&root='+root)}catch{state.eco={error:true,curator:null,recognized:[],curation:false}}}
async function load(){
 await Promise.all([
  getJson('/api/par-launches-all').then(j=>{state.launches=Array.isArray(j.launches)?j.launches:[];state.coverage={count:Number(j.count)||state.launches.length,indexed:Number(j.indexed)||state.launches.length,stale:Boolean(j.stale)}}).catch(()=>{state.launches=null}),
  loadEconomy(),
  fetch('/syncnet-projects.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(j=>{state.canonical=(j?.projects||[]).filter(p=>p?.registry?.canonical===true&&Eco.isAddr(p.token)).map(p=>({token:lc(p.token),symbol:sym(p.symbol||p.profile?.name)}))}).catch(()=>{}),
  Chain.readLaunch(rpc,root).then(l=>{state.rootLaunch=l||null}).catch(()=>{state.rootLaunch='unavailable'}),
  Chain.readTokenMetadata(rpc,root).then(m=>{state.meta=m}).catch(()=>{}),
  loadPons(null),
 ]);
 await loadRootPons();
 state.rootRow=(state.launches||[]).find(r=>lc(r.token||r.tokenAddress||r.address)===root)||null;
}
const rootSym=()=>{const c=state.canonical.find(x=>x.token===root);return(c&&c.symbol)||sym(state.rootRow?.symbol)||sym(state.meta?.symbol)||short(root)};
const rootName=()=>disp(state.rootRow?.name||state.meta?.name||'',64);

// ---------------------------------------------------------------- render
function card(c,opts){
 const pons=c.pons||ponsByToken().get(c.address)||null;
 const row=c.row||(c.pons?{name:c.pons.name,symbol:c.pons.symbol}:{}),cs=sym(row.symbol||row.tokenSymbol)||'TOKEN',name=disp(row.name||row.tokenName||'',64);
 const known=Boolean(c.row||(c.pons&&(c.pons.name||c.pons.symbol)));
 const imp=state.canonical.some(k=>k.token!==c.address&&k.symbol&&Core.confusableSkeleton(k.symbol)===Core.confusableSkeleton(cs));
 const rec=c.recognition,chips=[];
 if(rec)chips.push(`<span class="badge registry-badge network">${esc(Eco.LABELS.recognized)}</span>`);
 if(opts.outside)chips.push(`<span class="badge registry-badge unverified">${esc(ponsOn()&&state.pons.nextCursor?'CONNECTION PREVIOUSLY VERIFIED · NOT IN THE INDEXED PAGES LOADED SO FAR':state.launches?Eco.LABELS.outsideIndex:Eco.LABELS.indexerDown)}</span>`);
 else if(c.row)chips.push(`<span class="badge registry-badge indexed">${esc(Eco.LABELS.connected)}</span>`);
 if(pons&&!opts.outside){chips.push('<span class="badge registry-badge indexed">CONNECTED · PONS V2 LAUNCH PAIR</span>');chips.push(`<span class="badge">${esc(pons.phaseLabel||'PONS · PHASE UNAVAILABLE')}</span>`)}
 const recLine=rec?`<p class="coverage-note">${esc(Eco.LABELS.recognizedBy(rootSym(),state.eco?.curator?.source))} · ${esc(short(rec.curator))} · signed ${esc(when(rec.issuedAt*1000))}${opts.outside?' · the on-chain market was verified by SyncNet when this recognition was recorded':''}</p>`:'';
 const cur=state.eco&&state.eco.curator,canAct=Boolean(state.eco&&state.eco.curation&&cur&&account&&cur.address===account);
 const btn=canAct?(rec?`<button class="btn" type="button" data-eco-act="revoke" data-child="${esc(c.address)}">REVOKE RECOGNITION</button>`:`<button class="btn" type="button" data-eco-act="recognize" data-child="${esc(c.address)}">RECOGNIZE</button>`):'';
 return `<article class="network-card" data-child="${esc(c.address)}"><div class="network-card-top"><div><h3>${known?(name?esc(name):'$'+esc(cs)):esc(short(c.address))}</h3><div class="ticker">${known?'$'+esc(cs):c.pons?'PONS V2 launch · name could not be read':'name not in current index data'}${imp?' <span class="impostor-note">same ticker as a canonical asset, different contract</span>':''}</div></div></div><div class="chip-row">${chips.join('')}</div><p class="mono" style="font-size:11px;margin-top:10px">${esc(c.address)}</p>${recLine}<div class="network-actions"><a class="btn" href="/project/${esc(c.address)}">PROJECT PAGE</a>${btn}</div></article>`;
}
function renderCurator(){
 const cur=state.eco&&state.eco.curator,host=$('ecoCurator'),claim=$('ecoClaim');claim.innerHTML='';
 const row=(l,v,n='')=>`<div class="passport-row"><span>${esc(l)}</span><div><strong>${v}</strong>${n?`<small>${n}</small>`:''}</div></div>`;
 if(state.eco&&state.eco.error){host.innerHTML=row('Curator','UNAVAILABLE','Curation data could not be read right now. Connected projects below are still read from PAR market data.');return}
 if(state.eco&&state.eco.durable===false){host.innerHTML=row('Curator','NOT AVAILABLE ON THIS DEPLOYMENT','Curation needs the durable store. Connected projects below are still read from PAR market data.');return}
 if(cur){
  $('ecoCuratorTitle').textContent=cur.source==='passport'?'$'+rootSym()+' OPERATOR.':'$'+rootSym()+' CURATOR.';
  host.innerHTML=row('Curator',`<span class="mono">${esc(cur.address)}</span>`,cur.source==='passport'?'The recognised operator in this root’s Project Passport (proven on-chain when claimed in the Marketplace). Changes of operator end all earlier recognitions.':'A manually reviewed curator entry committed to SyncNet’s configuration.')+row('Since',esc(when(cur.since)))+row('Signing',state.eco.curation?'OPEN':'CLOSED ON THIS DEPLOYMENT',state.eco.curation?'Recognize/revoke is one free EIP-712 signature by the curator wallet.':'Recognitions can be read but not changed right now.');
  return;
 }
 $('ecoCuratorTitle').textContent='UNCLAIMED.';
 if(state.rootLaunch&&state.rootLaunch!=='unavailable'){
  host.innerHTML=row('Curator','UNCLAIMED','This root is a PAR launch. Its deployer or current creator-fee recipient wallet can claim the Project Passport in the Marketplace; that operator becomes the curator of this Economy.');
  claim.innerHTML='<div class="actions"><a class="btn" href="/marketplace.html">CLAIM THE PROJECT PASSPORT →</a></div>';
  return;
 }
 if(ponsOn()&&state.rootPons&&state.rootPons!=='unavailable'){
  host.innerHTML=row('Curator','UNCLAIMED','This root is a PONS V2 launch (read from its canonical factory record). Its deployer or current creator-fee recipient wallet can claim the Project Passport in the Marketplace; that operator becomes the curator of this Economy.');
  claim.innerHTML='<div class="actions"><a class="btn" href="/marketplace.html">CLAIM THE PROJECT PASSPORT →</a></div>';
  return;
 }
 if(ponsOn()&&state.rootPons==='unavailable'&&state.rootLaunch===null){host.innerHTML=row('Curator','UNCLAIMED','Robinhood Chain could not be read, so SyncNet cannot tell how this root could be claimed.');return}
 host.innerHTML=row('Curator','UNCLAIMED',state.rootLaunch==='unavailable'?'Robinhood Chain could not be read, so SyncNet cannot tell how this root could be claimed.':'No curator can be proven from on-chain data for this root. A wallet can file a signed curator request; it grants nothing until SyncNet reviews it.');
 if(state.rootLaunch===null&&state.eco&&state.eco.curation)claim.innerHTML=`<div class="field full"><label for="ecoEvidence">Evidence URL (https) · shown to SyncNet reviewers only</label><div class="asset-entry"><input class="input" id="ecoEvidence" maxlength="200" placeholder="https://…" autocomplete="off" spellcheck="false"><button class="btn" id="ecoRequest" type="button">SIGN CURATOR REQUEST</button></div></div>`;
 $('ecoRequest')?.addEventListener('click',requestCurator);
}
let ponsIndex=null;
function ponsByToken(){if(!ponsIndex)ponsIndex=new Map(state.pons.items.map(i=>[i.token,i]));return ponsIndex}
function render(){
 ponsIndex=null;
 const s=rootSym(),n=rootName();
 document.title='$'+s+' Economy — SyncNet';
 $('ecoTitle').textContent='$'+s+' ECONOMY';
 $('ecoLead').textContent=ponsOn()?'Projects with an observable launch or market relationship to '+(n?n+' ($'+s+')':'$'+s)+', read from indexed protocol data by contract address: PAR markets and canonical PONS V2 launches, listed separately. Recognitions are signed by the root’s current operator; SyncNet endorses nothing.':'Every PAR project with an on-chain market paired with '+(n?n+' ($'+s+')':'$'+s)+', read from PAR market data by contract address. Recognitions are signed by the root’s current operator; SyncNet endorses nothing.';
 $('ecoRootName').textContent=n||'$'+s;$('ecoRootAddr').textContent=root;
 const canonical=state.canonical.find(c=>c.token===root),impostor=!canonical&&state.canonical.some(c=>c.symbol&&Core.confusableSkeleton(c.symbol)===Core.confusableSkeleton(s));
 const badges=[];
 if(canonical)badges.push('<span class="badge registry-badge network">CANONICAL SYNCNET ASSET · BY CONTRACT ADDRESS</span>');
 if(state.rootLaunch&&state.rootLaunch!=='unavailable')badges.push('<span class="badge">PAR LAUNCH · FACTORY RECORD ON-CHAIN</span>');
 else if(ponsOn()&&state.rootPons&&state.rootPons!=='unavailable')badges.push('<span class="badge">PONS V2 LAUNCH · FACTORY RECORD ON-CHAIN</span>');
 $('ecoBadges').innerHTML=badges.join('');
 $('ecoImpostor').innerHTML=impostor?`<p class="impostor-note">$${esc(s)} here is NOT the canonical asset with that ticker. Economies are keyed by contract address.</p>`:'';
 const children=state.launches?Eco.childrenOf(state.launches,root):[];
 // PONS children join the SAME recognition fold (identity = contract address); a PAR child also seen via PONS keeps one card.
 const parSet=new Set(children.map(c=>c.address));
 const ponsKids=ponsOn()?state.pons.items.filter(i=>!parSet.has(i.token)&&i.token!==root).map(i=>({address:i.token,row:null,pons:i})):[];
 const joined=Eco.join(children.concat(ponsKids),(state.eco&&state.eco.recognized)||[]);
 joined.connected.forEach(c=>{const k=ponsKids.find(p=>p.address===c.address);if(k)c.pons=k.pons});
 const fact=(l,v)=>`<div><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`;
 const P=state.pons;
 $('ecoFacts').innerHTML=fact(ponsOn()?'Connected via PAR (indexed PAR history)':'Connected projects (indexed PAR history)',state.launches?String(children.length):'unavailable')+(ponsOn()?fact('Connected via PONS V2 (indexed launches)',P.error&&!P.items.length?'unavailable':String(P.total)):'')+fact('Parent-recognized',String(joined.connected.filter(c=>c.recognition).length+joined.outsideIndex.length));
 const cov=state.coverage;
 $('ecoCoverage').textContent=!state.launches?'The PAR indexer is unavailable right now, so connected projects cannot be listed. Nothing has been inferred.':'Read from '+cov.indexed+' indexed PAR launch'+(cov.indexed===1?'':'es')+(cov.count>cov.indexed?' of '+cov.count+' reported by PAR (older launches are outside the current index window)':'')+(cov.stale?' · indexer data may be stale':'')+'.';
 $('ecoBuild').href='/build.html?with='+encodeURIComponent(root);$('ecoBuild').textContent='CREATE A PROJECT IN THE $'+s+' ECONOMY';
 $('ecoMap').href='/network.html?token='+encodeURIComponent(root);$('ecoProject').href='/project/'+encodeURIComponent(root);
 $('ecoCard').hidden=false;$('ecoCuratorSection').hidden=false;
 renderCurator();renderWallet();
 const rec=joined.connected.filter(c=>c.recognition).map(c=>card(c,{})).concat(joined.outsideIndex.map(c=>card(c,{outside:true})));
 $('ecoRecognizedSection').hidden=false;
 $('ecoRecognized').innerHTML=rec.length?rec.join(''):'<div class="network-empty">No project is currently recognized by this root’s operator.</div>';
 const others=joined.connected.filter(c=>!c.recognition&&!c.pons);
 $('ecoConnectedSection').hidden=false;
 if(ponsOn())$('ecoConnectedTitle').textContent='CONNECTED VIA PAR.';
 $('ecoConnected').innerHTML=!state.launches?'<div class="network-empty">The PAR indexer is unavailable right now.</div>':others.length?others.slice(0,SHOW).map(c=>card(c,{})).join(''):'<div class="network-empty">No other indexed PAR launch has a market paired with this root.</div>';
 $('ecoConnectedMore').textContent=others.length>SHOW?'Showing '+SHOW+' of '+others.length+' connected projects.':'';
 renderPons(joined);
}
function renderPons(joined){
 const P=state.pons,sec=$('ecoPonsSection');
 if(!ponsOn()){sec.hidden=true;return}
 sec.hidden=false;
 const more=$('ecoPonsMore');
 if(P.error&&!P.items.length){
  $('ecoPonsCoverage').textContent='';$('ecoPons').innerHTML='<div class="network-empty">PONS discovery is temporarily unavailable.</div>';$('ecoPonsCount').textContent='';more.hidden=true;return;
 }
 $('ecoPonsCoverage').textContent='PONS V2: '+P.total.toLocaleString()+' indexed launch'+(P.total===1?'':'es')+' against this root'+(P.through?' · indexed through block '+P.through.toLocaleString():'')+(P.stale?' · index data may be stale':'')+'. Read from canonical PONS V2 factory events by contract address.';
 const list=joined.connected.filter(c=>c.pons&&!c.recognition);
 $('ecoPons').innerHTML=list.length?list.map(c=>card(c,{})).join(''):P.items.length?'<div class="network-empty">Every PONS V2 launch loaded so far is listed above.</div>':'<div class="network-empty">No canonical PONS V2 launch was launched against this root in the indexed history.</div>';
 $('ecoPonsCount').textContent=(P.items.length<P.total?'Loaded '+P.items.length.toLocaleString()+' of '+P.total.toLocaleString()+' PONS V2 launches, newest first.':P.total?'All '+P.total.toLocaleString()+' PONS V2 launch'+(P.total===1?'':'es')+' loaded.':'')+(P.error?' PONS discovery is temporarily unavailable; try again.':'');
 more.hidden=!P.nextCursor;more.disabled=P.loading;
}
$('ecoPonsMore').addEventListener('click',async()=>{
 const P=state.pons;if(!P.nextCursor||P.loading)return;
 $('ecoPonsMore').disabled=true;$('ecoPonsMore').textContent='LOADING…';
 const before=P.items.length;
 await loadPons(P.nextCursor);
 $('ecoPonsMore').textContent='LOAD MORE PONS V2 LAUNCHES';
 render();
 const first=$('ecoPons').querySelectorAll('.network-card')[Math.max(0,before-1)];if(first)first.scrollIntoView?.({block:'nearest'});
});

// ---------------------------------------------------------------- actions
async function post(body){const r=await fetch('/api/economies',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'The request was refused.');return j}
async function curate(child,decision){
 if(state.busy)return;state.busy=true;
 try{
  const cur=state.eco.curator;
  const message={root,child,curator:cur.address,decision,issuedAt:Math.floor(Date.now()/1000),nonce:nonce()};
  note(decision==='recognize'?'Sign the recognition in your wallet (a free signature, not a transaction)…':'Sign the revocation in your wallet…');
  const signature=await signTyped('EconomyCuration',message);
  note('Verifying on the server…');
  await post({action:'curate',...message,signature});
  await loadEconomy();render();
  note(decision==='recognize'?'Recognized. Anyone can verify the signature from /api/economies.':'Recognition revoked.','pass');
 }catch(e){note(String(e.message||e),'fail')}
 finally{state.busy=false}
}
async function requestCurator(){
 if(state.busy)return;
 const url=Eco.checkEvidenceUrl($('ecoEvidence').value);
 if(!url){note('Enter an https evidence URL (at most 200 characters).','fail');return}
 if(!account){openWallet();return}
 state.busy=true;
 try{
  const message={root,claimant:account,evidenceUrl:url,issuedAt:Math.floor(Date.now()/1000),nonce:nonce()};
  const signature=await signTyped('EconomyClaimRequest',message);
  await post({action:'claim-request',...message,signature});
  note('Request filed as PENDING. It grants nothing until SyncNet reviews it.','pass');
 }catch(e){note(String(e.message||e),'fail')}
 finally{state.busy=false}
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-eco-act]');if(b)curate(lc(b.dataset.child),b.dataset.ecoAct)});

load().then(render).catch(()=>{$('ecoTitle').textContent='ECONOMY UNAVAILABLE';$('ecoLead').textContent='The indexer and the chain did not answer. Nothing has been inferred.'});

// ---------------------------------------------------------------- Solana (read-only, Pump.fun V0)
/*
 * /economy.html?root=<Solana mint>. Read-only: the only request is /api/pump-economy (Pump.fun launches LAUNCHED
 * AGAINST the mint, newest first, page by page). No Robinhood RPC, no PAR, no curation, no wallet, no Builder, no
 * Passport. No name, symbol or logo is fetched or guessed: identity is the case-preserved mint.
 */
function solanaEconomy(mint){
 const PAGE=24;
 const shortMint=m=>m.length>12?m.slice(0,4)+'…'+m.slice(-4):m;
 const P={enabled:null,error:false,status:0,total:0,items:[],seen:new Set(),nextCursor:null,loading:false,historyComplete:false,historyFromSlot:null,through:null,stale:false};
 async function page(cursor){
  if(P.loading)return;P.loading=true;
  try{
   const r=await fetch('/api/pump-economy?root='+encodeURIComponent(mint)+'&limit='+PAGE+(cursor?'&cursor='+encodeURIComponent(cursor):''),{cache:'no-store'});
   const j=await r.json().catch(()=>({}));
   // enabled:false on a later page (flag flipped mid-session) keeps what is already loaded and reads as a failed page.
   if(j&&j.enabled===false){if(P.enabled===null)P.enabled=false;else P.error=true;return}
   P.enabled=true;
   if(!r.ok||!Array.isArray(j.items)){P.error=true;P.status=r.status;return}
   // Dedupe by the exact, case-sensitive mint. Earlier pages are never refetched.
   for(const it of j.items){const m=it&&it.mint;if(typeof m==='string'&&Assets.isSolanaMint(m)&&m!==mint&&!P.seen.has(m)){P.seen.add(m);P.items.push({mint:m,launchSlot:Number.isFinite(it.launchSlot)?it.launchSlot:null})}}
   P.error=false;P.total=Number(j.total)||0;P.nextCursor=typeof j.nextCursor==='string'&&j.nextCursor?j.nextCursor:null;
   P.historyComplete=j.historyComplete===true;P.historyFromSlot=Number.isFinite(j.historyFromSlot)?j.historyFromSlot:null;P.through=Number.isFinite(j.indexedThroughSlot)?j.indexedThroughSlot:null;P.stale=j.stale===true;
  }catch{P.enabled=true;P.error=true}
  finally{P.loading=false}
 }
 const fact=(l,v)=>`<div><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`;
 const card=it=>`<article class="network-card" data-child="${esc(it.mint)}"><div class="network-card-top"><div><h3 class="mono">${esc(shortMint(it.mint))}</h3><div class="ticker">Solana · name not read by SyncNet</div></div></div><div class="chip-row"><span class="badge registry-badge indexed">CONNECTED · PUMP.FUN LAUNCH PAIR</span><span class="badge">SOLANA</span></div><p class="mono" style="font-size:11px;margin-top:10px;overflow-wrap:anywhere;user-select:all">${esc(it.mint)}</p><p class="coverage-note">LAUNCHED AGAINST · PUMP.FUN${it.launchSlot!=null?' · slot '+esc(it.launchSlot.toLocaleString()):''}</p></article>`;
 function render(){
  const s=shortMint(mint);
  document.title='Solana Economy '+s+' — SyncNet';
  $('ecoEyebrow').textContent='Economy · Solana · derived from indexed Pump.fun launches';
  $('ecoTitle').textContent='SOLANA ECONOMY';
  $('ecoLead').textContent='Pump.fun launches with an observable launch relationship to this Solana mint, read from indexed Pump.fun launch records by mint address (exact case). SyncNet endorses nothing.';
  $('ecoRootName').textContent=s;$('ecoRootAddr').textContent=mint;$('ecoRootAddr').style.overflowWrap='anywhere';
  $('ecoBadges').innerHTML='<span class="badge registry-badge network">SOLANA</span>';
  $('ecoImpostor').innerHTML='';
  const off=P.enabled===false,down=P.enabled&&P.error&&!P.items.length;
  $('ecoFacts').innerHTML=fact('Chain','SOLANA MAINNET')+fact('Connected via Pump.fun (indexed launches)',off?'not enabled':down?'unavailable':P.enabled?P.total.toLocaleString():'…');
  $('ecoCoverage').textContent='Indexed from Solana · Pump.fun non-SOL quote launches. Native-SOL Pump.fun launches are not included in this V0 index.';
  ['ecoBuild','ecoProject'].forEach(id=>{$(id).hidden=true});
  $('ecoMap').href='/network.html?token='+encodeURIComponent(mint);
  $('ecoCard').hidden=false;$('ecoSolanaSection').hidden=false;
  ['ecoCuratorSection','ecoRecognizedSection','ecoConnectedSection','ecoPonsSection'].forEach(id=>{$(id).hidden=true});
  const sec=$('ecoPumpSection'),more=$('ecoPumpMore');sec.hidden=false;
  if(P.enabled===null){$('ecoPump').innerHTML='<div class="network-empty">Reading indexed Pump.fun launches…</div>';more.hidden=true;return}
  if(off||down){
   $('ecoPumpCountTitle').textContent='CONNECTIONS.';$('ecoPumpCoverage').textContent='';$('ecoPumpCount').textContent='';more.hidden=true;
   $('ecoPump').innerHTML=`<div class="network-empty">${off?'Pump.fun discovery is not enabled on this deployment.':P.status===400?'Pump.fun discovery cannot serve this mint.':'Pump.fun discovery is temporarily unavailable.'} No relationship has been inferred.</div>`;return;
  }
  $('ecoPumpCountTitle').textContent=P.total.toLocaleString()+' CONNECTION'+(P.total===1?'':'S')+'.';
  $('ecoPumpCoverage').textContent='Indexed from Solana · Pump.fun non-SOL quote launches'+(P.historyComplete?' · historical V0 coverage is complete'+(P.historyFromSlot!=null?' from slot '+P.historyFromSlot.toLocaleString():''):' · historical coverage is still being indexed')+(P.through!=null?' · indexed through slot '+P.through.toLocaleString():'')+'.'+(P.stale?' Index data may be stale; newer launches may be missing.':'')+' Native-SOL Pump.fun launches are not included in this V0 index.';
  $('ecoPump').innerHTML=P.items.length?P.items.map(card).join(''):'<div class="network-empty">No Pump.fun launch against this mint was found in the indexed non-SOL quote history.</div>';
  $('ecoPumpCount').textContent=(P.items.length<P.total?'Loaded '+P.items.length.toLocaleString()+' of '+P.total.toLocaleString()+' Pump.fun launches, newest first.':P.total?'All '+P.total.toLocaleString()+' Pump.fun launch'+(P.total===1?'':'es')+' loaded.':'')+(P.error?' Pump.fun discovery is temporarily unavailable; try again.':'');
  more.hidden=!P.nextCursor;more.disabled=P.loading;
 }
 $('ecoPumpMore').addEventListener('click',async()=>{
  if(!P.nextCursor||P.loading)return;
  const b=$('ecoPumpMore');b.disabled=true;b.textContent='LOADING…';
  const before=P.items.length;
  await page(P.nextCursor);
  b.textContent='LOAD MORE FROM PUMP.FUN';b.disabled=false;
  render();
  const first=$('ecoPump').querySelectorAll('.network-card')[Math.max(0,before-1)];if(first)first.scrollIntoView?.({block:'nearest'});
 });
 render();
 page(null).then(render);
}
})();
