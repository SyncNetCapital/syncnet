(function(){
'use strict';
/*
 * SyncNet builder (V2.5 release candidate).
 * Steps 01–03 collect the project; step 04 simulates, signs the intent, shows an immutable final review and sends
 * exactly the prepared transaction. Every launch attempt is written to durable launch records BEFORE the wallet is
 * asked to send, and is resolved from the chain (see launch-records.js).
 */
const $=id=>document.getElementById(id);
const Core=window.SyncNetCore,Chain=window.SyncNetChain,Records=window.SyncNetRecords,Engine=window.SyncNetLaunchV2;
let RPC='https://rpc.mainnet.chain.robinhood.com/';
const PAR_API='https://api.par.family';
let CHAIN_ID=4663,CHAIN_HEX='0x1237';
const PRICER='0x9EfC6EFA4c5F31e2BEC6CC174Ba7bB8f0b57d563';
const SYNC='0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
const USDG='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const presets={SYNC:{address:SYNC,symbol:'SYNC',name:'SyncNet'},USDG:{address:USDG,symbol:'USDG',name:'USDG'}};
const address=/^0x[a-fA-F0-9]{40}$/;
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
let step=1,tax=100,feeMode='',openingBuyWei=0n,openingSlippageBps=100,localPreviewUrl='',pendingImage=null,uploadInFlight=false,quotes=[],viemModule=null,client=null,provider=null,account='',chainId=null,busy=false,lastPrepared=null,lastMetadataOk=false,simGen=0,launched=false,connectionHistoryPromise=null,previewSeq=0;
let sig=null;                 // { id:P.id, scheme, typedData, message, signature, signer } — belongs to exactly one prepared launch
let finalReviewFor='';        // P.id whose immutable final review is on screen
let guard=null;               // duplicate / collision guard result for P.id
let liveParState=null;        // PAR fee parameters read live on page load (display only)
let serverConfig={publicLaunch:false,publicUploads:false,registrySubmissions:false,founderGate:true,loaded:false};
let canonicalAssets=[];       // [{token, symbol, name}] from syncnet-projects.json (canonical:true), matched by ADDRESS
let activeLaunchId='';
let rpcChainVerified=null;    // chain id reported by the RPC on load
let contractRecipient=null;   // {address, kind} for the creator recipient currently typed
const params0=new URL(location.href).searchParams;
const CANARY_REQUESTED=params0.get('live')==='canary';
let CANARY_LIVE=false;

// ---- Network mode (L3). Rehearsal is honoured only with ?live=canary, a loopback RPC and a chain id other than 4663.
// Anything that looks like a rehearsal attempt but is not exactly right DISABLES the page — it never silently becomes mainnet.
const REHEARSAL=(()=>{
 const q=params0,r=q.get('rpc'),c=q.get('chain');
 const suspicious=[...q.keys()].filter(k=>!['live','with','buildOn','rpc','chain','utm_source','utm_medium','utm_campaign'].includes(k)&&/rpc|fork|chain|anvil|rehears|node|port|local|net/i.test(k));
 if(suspicious.length)return{error:'Unrecognised rehearsal parameter "'+suspicious[0]+'". Use ?live=canary&rpc=http://127.0.0.1:8545&chain=46630 exactly, or remove it for mainnet.'};
 if(r===null&&c===null)return null;
 if(!CANARY_REQUESTED)return{error:'Rehearsal parameters are ignored outside founder mode.'};
 if(!/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/?$/.test(String(r||'')))return{error:'Rehearsal RPC must be a local loopback URL such as http://127.0.0.1:8545.'};
 const id=Number(c);
 if(!Number.isInteger(id)||id<1||id>4294967295)return{error:'Add &chain=<id> — the fork must run with its own chain id (e.g. anvil --chain-id 46630).'};
 if(id===4663)return{error:'Chain 4663 is the real Robinhood Chain. Start the fork with a different --chain-id so a real-network wallet can never sign the rehearsal.'};
 return{rpc:String(r),chainId:id};
})();
const IS_REHEARSAL=Boolean(REHEARSAL&&!REHEARSAL.error);
if(IS_REHEARSAL){RPC=REHEARSAL.rpc;CHAIN_ID=REHEARSAL.chainId;CHAIN_HEX='0x'+CHAIN_ID.toString(16)}
const providers=[];const providerSet=new WeakSet();
function stripUnsafe(v){return Core.sanitizeForDisplay(String(v??''),{maxLength:400})}
const KEY_NS=IS_REHEARSAL?'syncnet_rehearsal_'+CHAIN_ID+'_':'syncnet_';
const records=Records.createStore(KEY_NS);
try{records.migrateLegacy()}catch{}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function toast(t){const el=$('toast');el.textContent=t;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1800)}
const Ipfs=window.SyncNetIpfs; // display-only: the metadata value stays ipfs://, gateway URLs never enter the draft, intent or calldata
function isIpfs(uri){return /^ipfs:\/\/[A-Za-z0-9]+(?:\/[A-Za-z0-9._~\/-]+)?$/.test(String(uri||'').trim())}
function hexQty(v){v=BigInt(v||0);return '0x'+v.toString(16)}
function liveEnabled(){return CANARY_LIVE||serverConfig.publicLaunch===true}
async function normalizeImage(f){if(f.type==='image/gif')return{blob:f,type:f.type,name:f.name,note:'GIF kept as an animation; SyncNet re-encodes it server-side and removes comments and embedded metadata.'};const bmp=await createImageBitmap(f);const out=Math.min(512,Math.max(bmp.width,bmp.height));const k=Math.min(out/bmp.width,out/bmp.height),w=Math.round(bmp.width*k),h=Math.round(bmp.height*k);const c=document.createElement('canvas');c.width=out;c.height=out;c.getContext('2d').drawImage(bmp,Math.round((out-w)/2),Math.round((out-h)/2),w,h);const blob=await new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(Error('Could not process the image.')),'image/png'));return{blob,type:'image/png',name:String(f.name||'logo').replace(/\.[^.]+$/,'')+'.png',note:`Normalised to a ${out}×${out} square PNG and re-encoded again server-side. Camera metadata (EXIF/GPS) was removed.`}}
function fileToBase64(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(Error('Could not read image file.'));r.onload=()=>resolve(String(r.result||'').split(',')[1]||'');r.readAsDataURL(file)})}
function loadImage(url,timeout=15000){return new Promise((resolve,reject)=>{const img=new Image();const t=setTimeout(()=>{img.src='';reject(Error('Image gateway check timed out.'))},timeout);img.onload=()=>{clearTimeout(t);resolve(true)};img.onerror=()=>{clearTimeout(t);reject(Error('The pinned image could not be loaded from the IPFS gateway.'))};img.src=url+(url.includes('?')?'&':'?')+'syncnet_preflight='+Date.now()})}
function renderLogoPreview(){const uri=$('logo').value.trim(),host=$('logoPreview');const html=Ipfs.imgHtml(uri,{letter:(Core.normalizeText($('symbol')?.value||'S')||'S').charAt(0)})||(localPreviewUrl?`<img src="${esc(localPreviewUrl)}" alt="">`:'');if(html){host.innerHTML=html;host.querySelector('img').addEventListener('syncnet:ipfs-exhausted',()=>{host.innerHTML='<span>IMAGE UNAVAILABLE</span>'});if(!uri.startsWith('ipfs://'))host.querySelector('img').addEventListener('error',()=>{host.innerHTML='<span>IMAGE UNAVAILABLE</span>'})}else host.innerHTML='<span>NO IMAGE</span>';if($('reviewLogoPreview')){const img=$('reviewLogoPreview');const src=Ipfs.bind(img,uri)||(localPreviewUrl?(img.src=localPreviewUrl,localPreviewUrl):'');img.style.display=src?'block':'none'}if($('reviewLogoUri'))$('reviewLogoUri').textContent=uri||(localPreviewUrl?'Image selected · not uploaded':'No image');if($('reviewLogoState'))$('reviewLogoState').textContent=isIpfs(uri)?'IPFS image ready. This exact URI becomes permanent token metadata at launch.':uri?'A real launch requires an ipfs:// image URI.':localPreviewUrl?'The simulation runs without an on-chain image until the image is uploaded.':'Upload a project image in step 01 to include it in the token metadata.';}
async function viem(){if(!viemModule)viemModule=await import('/vendor/viem.js');return viemModule;}
async function publicClient(){if(client)return client;const v=await viem();const chain=v.defineChain({id:CHAIN_ID,name:IS_REHEARSAL?'SyncNet rehearsal fork':'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[RPC]}}});client=v.createPublicClient({chain,transport:v.http(RPC,{timeout:12000,retryCount:1})});return client;}
const rpc=Chain.makeRpc(RPC,{timeoutMs:12000,retries:1});
function reduceMotion(){return Boolean(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)}
function setStep(n,opts={}){step=Math.max(1,Math.min(4,n));document.querySelectorAll('.step-tab').forEach((b,i)=>{const active=i===step-1;b.classList.toggle('active',active);b.setAttribute('aria-selected',active?'true':'false');b.tabIndex=active?0:-1});document.querySelectorAll('.step-panel').forEach((p,i)=>{const on=i===step-1;p.classList.toggle('active',on);p.hidden=!on});if(step===3)renderFees();if(step===4)renderReview();if(opts.scroll!==false){const top=Math.max(0,(document.querySelector('.builder')?.getBoundingClientRect().top||0)+window.scrollY-70);window.scrollTo({top,behavior:reduceMotion()?'auto':'smooth'})}if(opts.focus){const h=document.querySelectorAll('.step-panel')[step-1]?.querySelector('h2');if(h){h.tabIndex=-1;try{h.focus({preventScroll:true})}catch{}}}}
document.querySelectorAll('.step-tab').forEach((b,i)=>{b.addEventListener('click',()=>setStep(i+1));b.addEventListener('keydown',e=>{const tabs=[...document.querySelectorAll('.step-tab')];let k=null;if(e.key==='ArrowRight')k=(i+1)%tabs.length;else if(e.key==='ArrowLeft')k=(i-1+tabs.length)%tabs.length;else if(e.key==='Home')k=0;else if(e.key==='End')k=tabs.length-1;if(k===null)return;e.preventDefault();setStep(k+1,{scroll:false});tabs[k].focus()})});
document.querySelectorAll('[data-next]').forEach(b=>b.addEventListener('click',()=>{if(validateStep(step))setStep(step+1,{focus:true})}));document.querySelectorAll('[data-prev]').forEach(b=>b.addEventListener('click',()=>setStep(step-1,{focus:true})));

// ---- Metadata policy in the form (L5, L7): UTF-8 byte limits and invisible/bidi characters, checked before any simulation.
function metaCheck(fieldName,value,opts){return Core.validateMetadataField(fieldName,String(value??''),opts)}
function renderByteCounters(){
 for(const [id,fieldName,multiline] of [['name','name',false],['description','description',true]]){
  const el=$(id+'Bytes');if(!el)continue;const r=metaCheck(fieldName,$(id).value,{multiline});
  el.textContent=`${r.bytes} / ${r.limit} bytes`+(r.ok||(!r.value&&fieldName!=='name')?'':' · '+r.errors[0].message);
  el.className='field-help byte-count'+(r.ok||(!r.value)?'':' warn');
 }
}
function validateStep(n){
 if(n===1){
  const nm=metaCheck('name',$('name').value);if(!nm.ok){toast(nm.errors[0].message);$('name').focus();return false}
  const symbol=Core.normalizeText($('symbol').value).toUpperCase();if(!/^[A-Z0-9]{1,10}$/.test(symbol)){toast('Ticker: 1–10 letters or numbers');return false}
  const ds=metaCheck('description',$('description').value,{multiline:true});if(!ds.ok&&ds.value){toast(ds.errors[0].message);$('description').focus();return false}
  const wc=websiteChoice();if(!wc){toast('Choose a website option — it is permanent');document.querySelector('input[name="websiteChoice"]')?.focus();return false}
  if(wc==='have'&&!safeUrl($('website').value)){toast('Paste a valid https:// website URL, or choose another option');$('website').focus();return false}
  if(wc==='kit'&&$('website').value.trim()&&!safeUrl($('website').value)){toast('That website URL is not valid — it must start with https://');$('website').focus();return false}
  if($('x').value.trim()&&!safeUrl($('x').value)){toast('X must be @handle or an https:// link');$('x').focus();return false}
  return true}
 if(n===2){if(!quotes.length){toast('Choose at least one token to connect to');return false}if(quotes.some(q=>q.eligible!==true)){toast('Every selected token must be eligible');return false}return true}
 if(n===3){if(!feeMode){toast('Choose where the creator share goes');document.querySelector('input[name="feeMode"]')?.focus();return false}
  if(feeMode==='creator'){const r=creatorRecipientInput();if(r){const chk=Chain.recipientStaticCheck(r,{quotes:quotes.map(q=>q.address),extraBlocked:blockedRecipients()});if(!chk.ok){toast(chk.error);$('creatorRecipient')?.focus();return false}}if(contractRecipient&&contractRecipient.kind==='contract'&&same(contractRecipient.address,resolvedRecipient())&&!$('contractRecipientAck')?.checked){toast('The fee recipient is a contract — confirm it in step 03');$('contractRecipientAck')?.focus();return false}}
  if(openingBuyWei<0n||openingBuyError()){toast(openingBuyError()||'Check the opening buy amount');$('openingBuy')?.focus();return false}return true}
 return true;
}
function quoteIndex(a){return quotes.findIndex(q=>q.address.toLowerCase()===String(a).toLowerCase())}
function hasSync(){return quoteIndex(SYNC)>=0}
function networkFeeText(){return {title:'$0 SyncNet platform fee',note:'Same for every connection set. $SYNC is optional.'}}
function canonicalByAddress(a){return canonicalAssets.find(c=>same(c.token,a))||null}
function canonicalSymbolImpostor(q){const sk=Core.confusableSkeleton(String(q.symbol||''));return canonicalAssets.find(c=>!same(c.token,q.address)&&sk&&Core.confusableSkeleton(c.symbol)===sk)||null}
function addQuote(q){if(quoteIndex(q.address)>=0){toast(q.symbol+' is already selected');return}if(quotes.length>=5){toast('Maximum 5 synced assets');return}quotes.push(q);renderQuotes();invalidateSimulation();}
function removeQuote(a){quotes=quotes.filter(q=>q.address.toLowerCase()!==a.toLowerCase());renderQuotes();invalidateSimulation();}
function renderQuotes(){
 document.querySelectorAll('.asset-preset').forEach(b=>b.classList.toggle('selected',quoteIndex(b.dataset.address)>=0));
 const host=$('selectedAssets');host.innerHTML=quotes.length?quotes.map(q=>{const imp=canonicalSymbolImpostor(q);return `<div class="selected-asset"><div class="selected-asset-main"><strong>${esc(q.symbol)}</strong><span class="mono">${esc(q.address)}</span>${imp?`<span class="impostor-note">NOT the canonical $${esc(imp.symbol)} (${esc(imp.token.slice(0,6)+'…'+imp.token.slice(-4))}). Same ticker, different contract.</span>`:''}<label class="connection-intent-label">Connection note · optional<input class="input connection-intent-input" data-intent-address="${esc(q.address)}" maxlength="160" value="${esc(q.intent||'')}" placeholder="Why this connection? Included in the SyncNet intent commitment."></label></div><button class="asset-remove" type="button" aria-label="Remove ${esc(q.symbol)} connection" data-remove="${esc(q.address)}">REMOVE</button></div>`}).join(''):'<div class="empty-assets">Nothing selected yet. Add $SYNC, USDG, or any other eligible token.</div>';
 host.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',()=>removeQuote(b.dataset.remove)));
 host.querySelectorAll('[data-intent-address]').forEach(i=>i.addEventListener('input',()=>{const q=quotes.find(x=>x.address.toLowerCase()===String(i.dataset.intentAddress).toLowerCase());if(q){q.intent=stripUnsafe(i.value).slice(0,160);invalidateSimulation();}}));
 const sym=(Core.normalizeText($('symbol').value)||'YOURTOKEN').toUpperCase();
 $('marketList').innerHTML=quotes.length?quotes.map(q=>`<span class="market-pill">${esc(sym)} / ${esc(q.symbol)}</span>`).join(''):'<span class="market-pill">Choose a connection to create a market</span>';
 $('quoteCount').textContent=quotes.length+(quotes.length===1?' connection selected':' connections selected')+' · up to 5';
 const atCap=quotes.length>=5;
 $('customAsset').disabled=atCap;
 $('checkAdd').disabled=atCap;
 document.querySelectorAll('.asset-preset').forEach(b=>{if(quoteIndex(b.dataset.address)<0)b.disabled=atCap;});
 $('addAnother').style.display=quotes.length&&!atCap?'inline-block':'none';
 if(atCap){$('assetStatus').className='asset-status';$('assetStatus').textContent='Maximum 5 connections reached. Five is a limit, not a target — remove one to change the structure.';}
 renderConnectionPreview();
 renderNetworkFee();
 saveDraft();
}
function renderConnectionPreview(){
 const sym=(Core.normalizeText($('symbol').value)||'YOURTOKEN').toUpperCase();
 const map=$('connectionMap');
 if(!quotes.length){map.innerHTML=`<div class="connection-center"><strong>${esc(sym)}</strong><span>your project</span></div>`;$('connectionInsight').textContent='Choose a connection to see where your project sits in the network.';return;}
 const nodes=quotes.map(q=>`<span class="connection-edge">↔</span><div class="connection-node ${same(q.address,SYNC)?'sync':same(q.address,USDG)?'usdg':''}"><strong>${esc(q.symbol)}</strong><span>${same(q.address,SYNC)?'direct $SYNC market':same(q.address,USDG)?'direct USDG market':'direct market'}</span></div>`).join('');
 map.innerHTML=`<div class="connection-center"><strong>${esc(sym)}</strong><span>your project</span></div>${nodes}`;
 const hasUsd=quoteIndex(USDG)>=0, hasS=hasSync(), others=quotes.filter(q=>![SYNC.toLowerCase(),USDG.toLowerCase()].includes(q.address.toLowerCase()));
 let insight='You are creating '+quotes.length+' direct market connection'+(quotes.length===1?'':'s')+'.';
 if(hasUsd&&quotes.length>1)insight+=' USDG creates a direct USDG market. Because your project also has another market, price differences may create arbitrage opportunities that tend to reduce divergence.';
 else if(hasUsd)insight+=' USDG creates a direct USDG-denominated market. Cross-market arbitrage only becomes relevant if your project also has another market.';
 if(hasS)insight+=' $SYNC creates a direct market with the SyncNet network asset. $SYNC itself has NET and USDG markets; this does not mean your holders automatically receive NET or USDG.';
 const names=others.map(q=>q.symbol);if(others.length)insight+=' '+(names.length>1?names.slice(0,-1).join(', ')+' and '+names[names.length-1]:names[0])+' '+(others.length===1?'is a direct market connection':'are direct market connections')+'. A market is not a partnership.';
 insight+=quotes.length===1?' The full supply opens in this one market.':' The supply is split equally across the '+quotes.length+' markets.';
 insight+=' Where the creator share of trading fees goes is chosen separately in step 03.';
 if(quotes.length>=3)insight+=' Keep the structure intentional: every extra market should have a clear reason to exist.';
 $('connectionInsight').textContent=insight;
 const seq=++previewSeq;enrichConnectionPreview(seq,insight).catch(()=>{});
}
async function connectionHistory(){
 if(connectionHistoryPromise)return connectionHistoryPromise;
 connectionHistoryPromise=(async()=>{
   const parse=b=>Array.isArray(b)?b:(b?.launches||b?.items||b?.data||b?.rows||b?.results||[]);
   let list=[];try{const r=await fetch('/api/par-launches-all',{cache:'no-store'});if(r.ok)list=parse(await r.json())}catch{}
   if(!list.length){try{const r=await fetch(PAR_API+'/launches?orderBy=createdAt&orderDirection=desc&limit=500',{cache:'no-store'});if(r.ok)list=parse(await r.json())}catch{}}
   const usage=new Map(),newest=new Map();
   for(const d of list){const ms=Array.isArray(d?.markets)&&d.markets.length?d.markets:[d];for(const m of ms){const a=String(m?.pairToken||m?.quoteToken||m?.pairTokenAddress||m?.quoteTokenAddress||'').toLowerCase();if(!address.test(a))continue;usage.set(a,(usage.get(a)||0)+1);const when=String(d?.createdAt||d?.created_at||'');if(when&&(!newest.get(a)||when>newest.get(a)))newest.set(a,when)}}
   return{usage,newest,total:list.length};
 })().catch(()=>({usage:new Map(),newest:new Map(),total:0}));return connectionHistoryPromise;
}
async function enrichConnectionPreview(seq,base){
 const h=await connectionHistory();if(seq!==previewSeq||!quotes.length||!h.total)return;const facts=quotes.map(q=>{const n=h.usage.get(q.address.toLowerCase())||0;return `${q.symbol}: ${n} indexed project${n===1?'':'s'} use${n===1?'s':''} it as a market`;});
 $('connectionInsight').textContent=base+' Network position: '+facts.join(' · ')+'.';
}
function renderNetworkFee(){
 if($('networkFeeTitle'))$('networkFeeTitle').textContent='SyncNet platform fee · $0';
 if($('networkFeeCopy'))$('networkFeeCopy').textContent='SyncNet does not charge a platform fee. $SYNC is optional; add it only when the connection is meaningful. PAR launch fees and network gas remain separate and are shown exactly before you sign.';
}
async function inspectToken(a){
 const normalized='0x'+String(a).trim().slice(2).toLowerCase();
 const c=await publicClient();const code=await c.getBytecode({address:normalized});if(!code||code==='0x')throw Error('No contract found at this address on this chain.');
 const abi=[{type:'function',name:'symbol',stateMutability:'view',inputs:[],outputs:[{type:'string'}]},{type:'function',name:'name',stateMutability:'view',inputs:[],outputs:[{type:'string'}]}];
 let symbol='TOKEN',name='';try{symbol=Core.sanitizeForDisplay(await c.readContract({address:normalized,abi,functionName:'symbol'}),{maxLength:16})}catch{}try{name=Core.sanitizeForDisplay(await c.readContract({address:normalized,abi,functionName:'name'}),{maxLength:60})}catch{}
 const eligible=await c.readContract({address:PRICER,abi:[{type:'function',name:'isPriceable',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'bool'}]}],functionName:'isPriceable',args:[normalized]});
 return {address:normalized,symbol:(symbol||'TOKEN').toUpperCase(),name,eligible:Boolean(eligible)};
}
async function addPreset(key){const p=presets[key];if(quoteIndex(p.address)>=0){removeQuote(p.address);return}$('assetStatus').className='asset-status';$('assetStatus').textContent='Checking '+p.symbol+'…';try{const q=await inspectToken(p.address);if(!q.eligible)throw Error(p.symbol+' is not currently eligible to sync via PAR.');addQuote(q);$('assetStatus').className='asset-status pass';$('assetStatus').textContent=p.symbol+' ready ✓';}catch(e){$('assetStatus').className='asset-status fail';$('assetStatus').textContent=e.message}}
document.querySelectorAll('.asset-preset').forEach(b=>b.addEventListener('click',()=>addPreset(b.dataset.preset)));
$('customAsset').addEventListener('input',()=>{
 if(quotes.length>=5)return;
 const a=$('customAsset').value.trim();
 $('assetStatus').className='asset-status';
 if(!a){$('assetStatus').textContent='Paste a token contract to check whether it can sync.';return;}
 if(!a.startsWith('0x')||a.length<42){$('assetStatus').textContent='Keep typing — a Robinhood Chain contract is 42 characters.';return;}
 if(!address.test(a)){$('assetStatus').className='asset-status fail';$('assetStatus').textContent='That does not look like a valid 0x… contract.';return;}
 $('assetStatus').textContent='Contract format looks valid. CHECK + ADD verifies live eligibility.';
});
$('checkAdd').addEventListener('click',async()=>{const a=$('customAsset').value.trim();if(!address.test(a)){$('assetStatus').className='asset-status fail';$('assetStatus').textContent='Paste a valid 0x… ERC-20 contract.';return}if(quoteIndex(a)>=0){$('assetStatus').className='asset-status';$('assetStatus').textContent='That token is already selected. Paste another contract to add a different connection.';$('customAsset').value='';$('customAsset').focus();return}const btn=$('checkAdd');btn.disabled=true;btn.textContent='CHECKING…';$('assetStatus').className='asset-status';$('assetStatus').textContent='Checking contract and live sync eligibility…';try{const q=await inspectToken(a);if(!q.eligible)throw Error(`${q.symbol} exists, but is not currently eligible to sync via PAR.`);addQuote(q);$('customAsset').value='';const imp=canonicalSymbolImpostor(q);$('assetStatus').className='asset-status '+(imp?'fail':'pass');$('assetStatus').textContent=imp?`Added ${q.symbol} — but this is NOT the canonical $${imp.symbol} contract (${imp.token}). Check the address before you continue.`:`${q.symbol} ready ✓ — added to the sync.`;}catch(e){$('assetStatus').className='asset-status fail';$('assetStatus').textContent=String(e.message||e)}finally{btn.disabled=false;btn.textContent='CHECK + ADD'}});
$('addAnother').addEventListener('click',()=>{if(quotes.length>=5)return;$('customAsset').disabled=false;$('customAsset').focus();$('customAsset').scrollIntoView({behavior:'smooth',block:'center'});});
$('symbol').addEventListener('input',renderQuotes);
document.querySelectorAll('.tax-btn').forEach(b=>b.addEventListener('click',()=>{if(b.disabled)return;document.querySelectorAll('.tax-btn').forEach(x=>{x.classList.remove('active');x.setAttribute('aria-pressed','false')});b.classList.add('active');b.setAttribute('aria-pressed','true');tax=Number(b.dataset.tax);renderFees();invalidateSimulation();}));

// ---- Fee destination (PAR creator-fee recipient). All four are PAR primitives; SyncNet does not preselect one.
const FEE_LABEL={holders:'Fees to holders',creator:'Creator / operator wallet',burn:'Buyback & burn',floor:'Price floor'};
function pct(bps){if(bps==null||!Number.isFinite(Number(bps)))return '—';const v=Number(bps)/100;return (Math.round(v*100)/100).toString()+'%'}
function creatorRecipientInput(){return String($('creatorRecipient')?.value||'').trim()}
function resolvedRecipient(){if(feeMode!=='creator'){const E=Engine;return feeMode==='holders'?E.HOLDER_VAULT:feeMode==='burn'?E.BURN_VAULT:feeMode==='floor'?E.FLOOR_VAULT:''}return creatorRecipientInput()||account||''}
function blockedRecipients(){const m={};for(const c of canonicalAssets)m[c.token]='the canonical SyncNet asset $'+c.symbol+' (a token contract)';return m}
/** Fee split from the prepared launch, else from PAR values read live on load. Never from hard-coded numbers. */
function feeSplit(){const P=lastPrepared;const base=P?P.economics.baseFeeBps:(liveParState&&liveParState.baseFeeBps!=null?liveParState.baseFeeBps:null);const share=P?P.economics.protocolFeeShareBps:(liveParState&&liveParState.protocolFeeShareBps!=null?liveParState.protocolFeeShareBps:null);const t=P?P.draft.tax:tax;if(base==null||share==null)return{total:null,protocol:null,creator:null,base:null,tax:t,live:false};const protocol=base*share/10000;return{total:base+t,protocol,creator:base-protocol+t,base,tax:t,live:true}}
function payoutAssets(){const sym=(Core.normalizeText($('symbol').value)||'YOURTOKEN').toUpperCase();const qs=quotes.map(q=>q.symbol);return qs.length?qs.join(', ')+' and '+sym:'the connected assets and '+sym}
function feeDest(){if(!feeMode)return'destination not chosen';if(feeMode==='creator'){const r=resolvedRecipient();return r?'wallet '+r.slice(0,6)+'…'+r.slice(-4):'your launch wallet'}return FEE_LABEL[feeMode]}
function feeModeDetail(){const f=feeSplit(),c=f.creator==null?'The creator share (read live from PAR)':pct(f.creator),a=payoutAssets(),sym=(Core.normalizeText($('symbol').value)||'YOURTOKEN').toUpperCase();switch(feeMode){
 case'holders':return['Fees to holders',`${c} of every trade is credited to PAR’s holder vault. Anyone can harvest it to PAR’s distributor — an operator wallet run by PAR — which pays holders pro rata in rounds (per PAR’s current disperser, in the asset it was earned in: ${a} for this project). Payouts depend on trading activity and on PAR running those rounds; no contract forces them and they are never guaranteed. This fee right cannot follow a future operator through a normal transfer (only PAR’s Community Takeover process can move it).`];
 case'creator':return['Creator / operator wallet',`${c} of every trade is credited to the recipient, which claims it from PAR’s fee escrow in ${a}. The current recipient can transfer this right on-chain, so it can accompany a future operator handover. Fees already credited stay with the previous recipient. The token contract itself never changes owner — it has none.`];
 case'burn':return['Buyback & burn',`${c} of every trade is credited to PAR’s burn vault. PAR’s operator runs the buyback rounds: the vault buys ${sym} in its own pool and burns it together with the token-side share. Per PAR’s published source the operator can delay or misprice a round but not redirect it. This fee right cannot follow a future operator through a normal transfer (only PAR’s Community Takeover process can move it).`];
 case'floor':return['Price floor',`${c} of every trade is credited to PAR’s floor vault. PAR states that the quote side becomes a locked buy wall in the pool that only moves up, and that the token side is burned. PAR has not published the floor vault’s source (its interface shows an operator role), so SyncNet cannot independently confirm how the wall is managed. This fee right cannot follow a future operator through a normal transfer (only PAR’s Community Takeover process can move it).`];
 default:return['Choose a destination','Every option is a PAR primitive. None of them makes the token contract transferable — PAR tokens have no owner.']}}
// Opening buy (dev buy inside the launch transaction)
const OPENING_MAX_WEI=10n*10n**18n;
function parseEthWei(v){v=String(v||'').trim().replace(',','.');if(v===''||v==='0'||/^0?\.0*$/.test(v))return 0n;if(!/^\d{1,4}(\.\d{1,18})?$/.test(v)&&!/^\.\d{1,18}$/.test(v))return null;const [i,f='']=v.split('.');return BigInt(i||'0')*10n**18n+BigInt((f+'0'.repeat(18)).slice(0,18))}
/** Exact ETH amount — never rounded or truncated, so the review matches the wallet. */
function fmtEth(w){w=BigInt(w||0);const neg=w<0n;if(neg)w=-w;const i=w/10n**18n,f=(w%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return (neg?'-':'')+i.toString()+(f?'.'+f:'')}
function fmtTokens(w){const t=BigInt(w||0)/10n**18n;return t.toLocaleString('en-US')}
function fmtPct(bps){return (Number(bps)/100).toFixed(bps<100?2:1)+'%'}
function openingBuyError(){const raw=$('openingBuy')?.value||'';const w=parseEthWei(raw);if(w===null)return'Enter an ETH amount such as 0.05.';if(w>OPENING_MAX_WEI)return'Opening buy is limited to 10 ETH in this build.';return''}
function renderOpeningReview(){if(!$('reviewOpeningBuy'))return;const P=lastPrepared,ob=P?.openingBuy;const w=P?BigInt(P.draft.openingBuyWei):openingBuyWei;if(w<=0n){$('reviewOpeningBuy').textContent=openingBuyWei<0n&&!P?'INVALID — fix in step 03':'None';$('reviewOpeningBuyNote').textContent='No tokens are bought at launch.'}else{$('reviewOpeningBuy').textContent=fmtEth(w)+' ETH'+(ob?` → ≈${fmtTokens(ob.expectedTokens)} tokens · ${fmtPct(ob.supplyBps)} of supply`:'');$('reviewOpeningBuyNote').textContent=ob?`Minimum accepted ${fmtTokens(ob.minTokens)} (${ob.slippageBps/100}% protection). Bought through PAR’s router in the same transaction; public and recorded in your launch intent.`:'Exact tokens appear after simulation. Public and recorded in your launch intent.'}
 if($('reviewTxValue'))$('reviewTxValue').textContent=P?fmtEth(P.request.value)+' ETH'+(P.openingBuy?` (${fmtEth(P.economics.launchFee)} PAR launch fee + ${fmtEth(P.openingBuy.ethWei)} opening buy)`:' (PAR launch fee)'):(openingBuyWei>0n?'PAR launch fee + '+fmtEth(openingBuyWei)+' ETH opening buy':'PAR launch fee (read live during simulation)')}
function renderFees(){const f=feeSplit();if($('feeTotalPct'))$('feeTotalPct').textContent=pct(f.total);if($('feeProtocolPct'))$('feeProtocolPct').textContent=pct(f.protocol);if($('feeCreatorPct'))$('feeCreatorPct').textContent=pct(f.creator);if($('feeLiveNote'))$('feeLiveNote').textContent=f.live?(lastPrepared?'Values read from PAR during this simulation.':'Values read live from PAR’s factory when this page loaded; re-read during simulation.'):'PAR’s current values could not be read yet; they are read live during simulation.';if($('feeCreatorDest'))$('feeCreatorDest').textContent=feeDest();const tot=Math.max(1,f.total||1);if($('feeBarProtocol'))$('feeBarProtocol').style.width=((f.protocol||0)/tot*100)+'%';if($('feeBarCreator'))$('feeBarCreator').style.width=((f.creator||0)/tot*100)+'%';const [t,d]=feeModeDetail();if($('feeModeDetail')){$('feeModeDetail').querySelector('strong').textContent=t;$('feeModeHelp').textContent=d;$('feeModeDetail').dataset.mode=feeMode||''}if($('creatorRecipientWrap'))$('creatorRecipientWrap').hidden=feeMode!=='creator';const r=creatorRecipientInput();let help='Empty = the wallet you launch with. Use an address you control; a mistyped address cannot be corrected by SyncNet.';if(r&&!address.test(r))help='That is not a valid 0x address.';else if(r){const chk=Chain.recipientStaticCheck(r,{quotes:quotes.map(q=>q.address),extraBlocked:blockedRecipients()});if(!chk.ok)help=chk.error;else if(account&&!same(r,account))help='This differs from your connected wallet. Only that address will be able to claim or transfer the fee right.'}if($('creatorRecipientHelp')){$('creatorRecipientHelp').textContent=help;$('creatorRecipientHelp').className='field-help'+(help.startsWith('That')||help.startsWith('The ')?' warn':'')}const ackWrap=$('contractRecipientWrap');if(ackWrap)ackWrap.hidden=!(feeMode==='creator'&&contractRecipient&&contractRecipient.kind==='contract'&&same(contractRecipient.address,resolvedRecipient()));document.querySelectorAll('.fee-mode').forEach(l=>l.classList.toggle('selected',l.querySelector('input')?.value===feeMode));document.querySelectorAll('.tax-btn').forEach(b=>{const max=(lastPrepared?lastPrepared.economics.maxCreatorTaxBps:liveParState?.maxCreatorTaxBps);b.disabled=max!=null&&Number(b.dataset.tax)>max;b.title=b.disabled?'Above PAR’s current maximum creator tax':''})}
document.querySelectorAll('input[name="feeMode"]').forEach(r=>r.addEventListener('change',()=>{if(r.checked){feeMode=r.value;renderFees();invalidateSimulation();classifyRecipientSoon()}}));
let classifyTimer=null;
function classifyRecipientSoon(){clearTimeout(classifyTimer);classifyTimer=setTimeout(async()=>{const r=feeMode==='creator'?resolvedRecipient():'';if(!address.test(r)){contractRecipient=null;renderFees();return}try{const c=await Chain.classifyRecipient(rpc,r);contractRecipient={address:r,kind:c.kind}}catch{contractRecipient=null}renderFees();renderReview()},350)}
$('creatorRecipient')?.addEventListener('input',()=>{renderFees();invalidateSimulation();classifyRecipientSoon();renderReview()});
$('contractRecipientAck')?.addEventListener('change',()=>{invalidateSimulation();saveDraft()});
function renderOpeningBuy(){const st=$('openingBuyStatus');if(!st)return;const err=openingBuyError();document.querySelectorAll('.buy-btn').forEach(b=>{const on=parseEthWei(b.dataset.buy)===openingBuyWei&&!err;b.classList.toggle('active',on);b.setAttribute('aria-pressed',on?'true':'false')});
 if(err){st.className='asset-status fail';st.textContent=err;return}
 if(openingBuyWei===0n){st.className='asset-status';st.textContent='No opening buy. The launch transaction sends only PAR’s launch fee.';return}
 const P=lastPrepared,ob=P?.openingBuy;const n=quotes.length||1;const f=feeSplit();
 if(ob&&BigInt(ob.ethWei)===openingBuyWei){const big=ob.supplyBps>=500;st.className='asset-status '+(big?'fail':'pass');st.textContent=`${fmtEth(openingBuyWei)} ETH → about ${fmtTokens(ob.expectedTokens)} ${P.draft.symbol} (${fmtPct(ob.supplyBps)} of supply). Minimum accepted: ${fmtTokens(ob.minTokens)}. Split over ${ob.legs.map(l=>l.symbol).join(' + ')}${ob.unreachable.length?` · no ETH route to ${ob.unreachable.join(', ')}, so nothing is bought there`:''}.${big?' Large opening buys are public and are often read as a risk signal by other buyers.':''}`;return}
 st.className='asset-status';st.textContent=`${fmtEth(openingBuyWei)} ETH, split equally across your ${n} market${n===1?'':'s'}. The buy pays the normal ${pct(f.total)} trading fee. Exact tokens and % of supply appear after simulation.${openingBuyWei>10n**18n?' That is more than 1 ETH — double-check the amount.':''}`}
$('openingBuy')?.addEventListener('input',()=>{const w=parseEthWei($('openingBuy').value);openingBuyWei=w===null||w>OPENING_MAX_WEI?-1n:w;renderOpeningBuy();invalidateSimulation();saveDraft()});
document.querySelectorAll('.buy-btn').forEach(b=>b.addEventListener('click',()=>{$('openingBuy').value=b.dataset.buy==='0'?'':b.dataset.buy;openingBuyWei=parseEthWei(b.dataset.buy)||0n;renderOpeningBuy();invalidateSimulation();saveDraft()}));
$('openingSlippage')?.addEventListener('change',()=>{openingSlippageBps=Number($('openingSlippage').value)||100;invalidateSimulation();saveDraft()});
/** https-only permanent links (L13). '@handle' becomes https://x.com/handle. Returns '' when invalid. */
function safeUrl(v){v=Core.normalizeText(String(v||''));if(!v)return'';if(v.startsWith('@')&&/^@[A-Za-z0-9_]{1,30}$/.test(v))return 'https://x.com/'+v.slice(1);try{const u=new URL(v);if(u.protocol==='https:'&&!u.username&&!u.password&&Core.utf8Length(u.href)<=Core.PAR_BYTE_LIMITS.social)return u.href}catch{}return'';}
/**
 * Review (L1): once a launch is prepared, every line shows the PREPARED values (the ones in the calldata);
 * before that it shows the current inputs. Re-rendered after simulation, wallet account/chain changes and recipient changes.
 */
function renderReview(){
 const P=lastPrepared,d=P?P.draft:null;
 const name=d?d.name:(Core.normalizeText($('name').value)||'—'),symbol=d?d.symbol:(Core.normalizeText($('symbol').value).toUpperCase()||'—');
 $('reviewName').textContent=name;$('reviewTicker').textContent='$'+symbol;$('reviewTax').textContent=((d?d.tax:tax)/100)+'%';
 {const f=feeSplit(),mode=d?d.feeMode:feeMode,rcp=d?d.feeRecipient:resolvedRecipient();$('reviewRewards').textContent=mode?FEE_LABEL[mode].toUpperCase()+(mode==='creator'?' · '+(rcp||'connected wallet'):' · '+rcp):'NOT CHOSEN — go back to step 03';if($('reviewRewardsNote'))$('reviewRewardsNote').textContent=mode?(f.creator==null?'Creator share read live during simulation. ':pct(f.creator)+' of every trade. ')+(mode==='creator'?(contractRecipient&&contractRecipient.kind==='contract'&&same(contractRecipient.address,rcp)?'This recipient is a CONTRACT. ':'')+'The recipient can transfer this fee right on-chain.':'Fixed to a PAR vault — this fee right cannot follow a future operator.'):'Choose a fee destination in step 03.'}
 const qs=d?d.quotes:quotes;
 $('reviewMarkets').innerHTML=qs.length?qs.map(q=>`<span class="market-pill">${esc(symbol)} / ${esc(q.symbol)}</span>`).join(''):'<span class="market-pill">No markets selected</span>';
 $('reviewConnections').textContent=qs.map(q=>q.symbol).join(' + ')||'—';if($('reviewIntent'))$('reviewIntent').innerHTML=qs.length?qs.map(q=>`<div><strong>${esc(q.symbol)}</strong><span>${esc(q.intent||'No note supplied')}</span></div>`).join(''):'—';renderOpeningReview();
 if($('reviewTradeFee')){const f=feeSplit();$('reviewTradeFee').textContent=f.total==null?'Read live from PAR during simulation':pct(f.total)+' per trade ('+pct(f.base)+' PAR base + '+pct(f.tax)+' creator tax)'}
 if($('reviewDescription'))$('reviewDescription').textContent=(d?d.description:Core.normalizeText($('description').value,{multiline:true}))||'None — the description will be empty forever';
 if($('reviewX'))$('reviewX').textContent=d?(d.twitter||'None'):(safeUrl($('x').value)||($('x').value.trim()?'INVALID — use @handle or https://':'None'));
 if($('reviewWebsite'))$('reviewWebsite').textContent=d?(d.website||'None'):(safeUrl($('website').value)||($('website').value.trim()?'INVALID — must start with https://':'None'));renderWebsiteReview();
 const fee=networkFeeText();$('reviewNetworkFee').textContent=fee.title;$('reviewNetworkFeeNote').textContent=fee.note;
 renderLogoPreview();renderNetworkFee();renderWallet();
}
['name','symbol','description','logo','x','website'].forEach(id=>$(id).addEventListener('input',()=>{invalidateSimulation();if(id==='symbol')renderQuotes();if(id==='logo')renderLogoPreview();if(id==='name'||id==='description')renderByteCounters()}));
/** Any change to inputs, wallet account or chain invalidates the simulation, the signature and the final review. Launch records are never touched. */
function invalidateSimulation(){
 simGen++;lastPrepared=null;lastMetadataOk=false;sig=null;finalReviewFor='';guard=null;
 if(typeof renderOpeningBuy==='function'){try{renderOpeningBuy();renderOpeningReview()}catch{}}
 if($('checkIntentSignature')){$('checkIntentSignature').textContent='NOT SIGNED';$('checkIntentSignature').className=''}
 $('simStatus').className='sim-status';$('simStatus').textContent='Simulation not run yet. No transaction will be requested.';
 ['checkWallet','checkEligibility','checkSimulation'].forEach(id=>{$(id).textContent='NOT CHECKED';$(id).className=''});
 if($('checkMetadata')){$('checkMetadata').textContent='NOT CHECKED';$('checkMetadata').className=''}
 if($('checkExactSimulation')){$('checkExactSimulation').textContent='NOT READY';$('checkExactSimulation').className=''}
 if($('checkDuplicate')){$('checkDuplicate').textContent='NOT CHECKED';$('checkDuplicate').className=''}
 if($('parPreflight'))$('parPreflight').innerHTML='';
 if($('finalReview')){$('finalReview').hidden=true;$('finalReview').innerHTML=''}
 if($('guardPanel')){$('guardPanel').hidden=true;$('guardPanel').innerHTML=''}
 if($('liveStatus')&&!busy&&!activeLaunchId){$('liveStatus').className='sim-status';$('liveStatus').textContent='Live launch is locked until simulation, metadata preflight, signature and final review are complete.'}
 if($('liveConfirm')&&!busy)$('liveConfirm').value='';if($('launchLive'))$('launchLive').disabled=true;
 updateLiveUnlock();
}
function providerLabel(p,info){if(info?.name)return info.name;if(p?.isBraveWallet)return 'Brave Wallet';if(p?.isPhantom)return 'Phantom';if(p?.isRabby)return 'Rabby';if(p?.isMetaMask)return 'MetaMask';return 'EVM wallet'}
function addProvider(p,info){if(!p||providerSet.has(p))return;if(info?.rdns&&providers.some(x=>x.rdns===info.rdns))return;providerSet.add(p);providers.push({provider:p,name:info?.name||providerLabel(p,info),rdns:info?.rdns||''});}
window.addEventListener('eip6963:announceProvider',e=>addProvider(e.detail?.provider,e.detail?.info));window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(()=>{if(providers.length)return;const legacy=window.ethereum?.providers?.length?window.ethereum.providers:[window.ethereum].filter(Boolean);legacy.forEach(p=>addProvider(p));},450);

// ---- Network banner (L3): derived from what the RPC and the wallet actually report, not from URL parameters alone.
function networkState(){
 const walletOk=Boolean(account)&&chainId===CHAIN_ID;
 const rpcOk=rpcChainVerified===CHAIN_ID;
 return{walletOk,rpcOk,ok:walletOk&&rpcOk&&(!REHEARSAL||IS_REHEARSAL)};
}
function setBanner(b,head,detail){b.innerHTML='<strong>'+esc(head)+'</strong> · <span>'+esc(detail)+'</span>';b.hidden=false}
function renderNetworkBanner(){
 const b=$('networkBanner');if(!b)return;
 if(REHEARSAL&&REHEARSAL.error){b.className='network-banner error';setBanner(b,'REHEARSAL NOT STARTED',REHEARSAL.error+' Simulation and launching are disabled on this page until the URL is fixed.');return}
 const ns=networkState();
 if(IS_REHEARSAL){b.className='network-banner rehearsal';setBanner(b,'REHEARSAL · LOCAL FORK · chain '+CHAIN_ID,(rpcChainVerified==null?'checking RPC…':rpcChainVerified===CHAIN_ID?'confirmed by the RPC':'RPC reports chain '+rpcChainVerified+' — MISMATCH, launching disabled')+' · RPC '+RPC+' · nothing here reaches Robinhood Chain.');return}
 const live=liveEnabled();
 b.className='network-banner '+(live?'mainnet':'mainnet quiet');
 setBanner(b,live?'MAINNET · REAL FUNDS':'MAINNET',"Robinhood Chain (4663)"+(rpcChainVerified==null?' · checking RPC…':rpcChainVerified===4663?' · RPC confirmed':' · RPC reports chain '+rpcChainVerified+' — launching disabled')+(account?(ns.walletOk?' · wallet on 4663 ✓':' · wallet on chain '+(chainId||'unknown')+' — switch before launching'):'')+(live?' · a launch sends a real, irreversible transaction.':' · simulations only; nothing is sent.'));
}
function renderWallet(){const ok=Boolean(account);$('walletName').textContent=ok?account.slice(0,6)+'…'+account.slice(-4):'Not connected';$('walletNetwork').textContent=ok?(chainId===CHAIN_ID?(IS_REHEARSAL?'Rehearsal fork '+CHAIN_ID+' ✓':'Robinhood Chain · MAINNET ✓'):'Wrong network · '+String(chainId||'unknown')+' — use SWITCH NETWORK'):'Connect an EVM wallet to simulate. No transaction is sent by simulation.';$('connectWallet').textContent=ok?'Change wallet':'Connect wallet';if($('switchChain'))$('switchChain').textContent=IS_REHEARSAL?'SWITCH TO FORK '+CHAIN_ID:'SWITCH TO ROBINHOOD CHAIN (MAINNET)';renderNetworkBanner();}
function bind(p){if(typeof p.on!=='function')return;p.on('accountsChanged',a=>{if(p!==provider)return;account=a?.[0]||'';invalidateSimulation();renderWallet();renderFees();renderReview();classifyRecipientSoon()});p.on('chainChanged',id=>{if(p!==provider)return;chainId=Number(id);invalidateSimulation();renderWallet();renderReview()});p.on('disconnect',()=>{if(p!==provider)return;account='';chainId=null;provider=null;invalidateSimulation();renderWallet();renderReview()});}
let walletReturnFocus=null;
function closeWalletModal(){const m=$('walletModal');m.classList.remove('open');walletReturnFocus?.focus?.();}
function openWallet(){walletReturnFocus=document.activeElement;const host=$('providerList');host.innerHTML='';providers.forEach(d=>{const b=document.createElement('button');b.className='provider';b.type='button';b.textContent=d.name;b.onclick=()=>connect(d.provider);host.appendChild(b)});if(!providers.length)host.innerHTML='<div class="asset-status">No injected EVM wallet detected. Try MetaMask, Rabby or another EVM wallet (on mobile: open this page in your wallet app’s browser).</div>';$('walletModal').classList.add('open');requestAnimationFrame(()=>($('providerList').querySelector('button')||$('closeWallet'))?.focus());}
// Phantom with a Solana-only account selected cannot expose an EVM account: explained by wallet-evm-notice.js; every other error keeps the generic toast.
const walletInfo=p=>providers.find(x=>x.provider===p)||null;
async function connect(p){try{provider=p;bind(p);const accounts=await p.request({method:'eth_requestAccounts'});window.SyncNetEvmNotice?.check(p,walletInfo(p),accounts);account=accounts?.[0]||'';chainId=Number(await p.request({method:'eth_chainId'}));window.SyncNetEvmNotice?.hide();closeWalletModal();invalidateSimulation();renderWallet();renderFees();renderReview();classifyRecipientSoon();if(pendingImage&&uploadMode==='public'&&!uploadInFlight)uploadPendingImage()}catch(e){provider=null;account='';chainId=null;closeWalletModal();invalidateSimulation();renderWallet();if(window.SyncNetEvmNotice?.matches(p,walletInfo(p),e))window.SyncNetEvmNotice.show({onRetry:()=>connect(p),returnFocus:$('connectWallet')});else toast('Wallet connection did not complete')}}
/** Explicit network switch only — the page never switches the wallet's network on its own (L3). */
async function switchChain(){if(!provider)return;if(!IS_REHEARSAL&&liveEnabled()&&!confirm('Switch your wallet to Robinhood Chain MAINNET (4663)? Transactions there use real funds.'))return;try{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:CHAIN_HEX}]})}catch(e){if(e.code===4902)await provider.request({method:'wallet_addEthereumChain',params:[{chainId:CHAIN_HEX,chainName:IS_REHEARSAL?'SyncNet rehearsal fork '+CHAIN_ID:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:[RPC],...(IS_REHEARSAL?{}:{blockExplorerUrls:['https://robinhoodchain.blockscout.com/']})}]});else throw e}chainId=Number(await provider.request({method:'eth_chainId'}));invalidateSimulation();renderWallet();}
$('connectWallet').addEventListener('click',openWallet);$('closeWallet').addEventListener('click',closeWalletModal);$('walletModal').addEventListener('click',e=>{if(e.target===$('walletModal'))closeWalletModal()});$('walletModal').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeWalletModal();return}if(e.key!=='Tab')return;const f=[...$('walletModal').querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(x=>!x.disabled&&!x.hidden);if(!f.length)return;const first=f[0],last=f[f.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}});$('switchChain').addEventListener('click',async()=>{try{await switchChain()}catch{toast('Network switch did not complete')}});
const IPFS_CHECK_FAIL={invalid:'The logo is not a valid ipfs:// CID. Upload the image again.',unreachable:'SyncNet’s server could not retrieve the pinned image from the IPFS gateways (gateway.pinata.cloud, ipfs.io, dweb.link). If you just uploaded it, wait a minute and run the simulation again.',not_image:'The IPFS gateways returned content that is not a PNG, JPEG, GIF or WebP image.',too_large:'The pinned image is too large to verify (over 5 MB or 4096 px).',rate_limited:'Too many image checks from this connection. Wait a minute and run the simulation again.',unavailable:'SyncNet’s IPFS image check is unavailable right now. Nothing was sent; try again in a moment.'};
/** Same-origin server check of an ipfs:// logo → {ok, reason}. One retry when the gateways were unreachable (a fresh pin can be slow on its first fetch). */
async function serverIpfsCheck(uri){
 for(let attempt=1;;attempt++){
  let r;try{const res=await fetch('/api/ipfs-check?uri='+encodeURIComponent(uri),{cache:'no-store'});const j=await res.json().catch(()=>null);r=j&&typeof j==='object'?{ok:res.ok&&j.ok===true,reason:typeof j.reason==='string'?j.reason:res.status===429?'rate_limited':'unavailable'}:{ok:false,reason:res.status===429?'rate_limited':'unavailable'}}catch{r={ok:false,reason:'unavailable'}}
  if(r.ok||attempt>=2||(r.reason!=='unreachable'&&r.reason!=='unavailable'))return r;
  await new Promise(done=>setTimeout(done,2500));
 }
}
async function metadataPreflight(prepared){
 const uri=String(prepared?.draft?.logo||'').trim();lastMetadataOk=false;
 if(!isIpfs(uri)){if($('checkMetadata')){$('checkMetadata').textContent='IPFS REQUIRED';$('checkMetadata').className='fail'}throw Error('A live launch requires an IPFS-pinned project image. Upload the image first.')}
 // Authoritative, server-side: /api/ipfs-check fetches the CID from trusted gateways (gateway.pinata.cloud, ipfs.io, dweb.link) and checks that the bytes are a real PNG/JPEG/GIF/WebP.
 // The browser <img> (renderLogoPreview) is only a non-blocking preview: gateways and wallet browsers can refuse cross-site image loads of a reachable CID.
 const check=await serverIpfsCheck(uri);if(!check.ok)throw Error(IPFS_CHECK_FAIL[check.reason]||IPFS_CHECK_FAIL.unreachable);
 if($('checkMetadata')){$('checkMetadata').textContent='PASS ✓';$('checkMetadata').className='pass'}
 if($('reviewLogoState'))$('reviewLogoState').textContent='IPFS image reachable on an independent gateway ✓ · this URI will be immutable after launch.';
 lastMetadataOk=true;return true;
}

// ---- Intent signature (M1): a signature belongs to exactly one prepared launch (P.id) and is re-verified before use.
const recoveredCache=new Map();
async function verifyIntentSignature(P,s){
 const expectedTyped=Core.launchIntentTypedData({chainId:P.chainId,operator:P.account,token:P.predicted,recordHash:P.recordHash,salt:P.salt});
 if(s.scheme==='EIP-712'){if(!Core.sameTypedIntent(s.typedData,expectedTyped))throw Error('The signed message is not this launch.')}
 else if(s.scheme==='personal_sign'){if(s.message!==Core.launchIntentPlainMessage({chainId:P.chainId,operator:P.account,token:P.predicted,recordHash:P.recordHash,salt:P.salt}))throw Error('The signed text is not this launch.')}
 else throw Error('Unknown signature scheme.');
 let signer='';try{signer=s.scheme==='EIP-712'?Core.recoverTypedDataAddress(s.typedData,s.signature):Core.recoverPersonalSignAddress(s.message,s.signature)}catch{signer=''}
 if(same(signer,P.account))return signer.toLowerCase();
 // Smart-contract wallet: EIP-1271 isValidSignature(bytes32,bytes) must return 0x1626ba7e.
 try{const code=await Chain.getCode(rpc,P.account);if(code&&code!=='0x'&&!String(code).toLowerCase().startsWith('0xef0100')){const digest=s.scheme==='EIP-712'?Core.hashTypedData(s.typedData):Core.hashPersonalMessage(s.message);const out=await Chain.ethCall(rpc,P.account,Core.functionSelector('isValidSignature(bytes32,bytes)')+Core.abiEncode(['bytes32','bytes'],[digest,s.signature]).slice(2));if(String(out||'').slice(0,10).toLowerCase()==='0x1626ba7e')return P.account.toLowerCase()}}catch{}
 throw Error('The signature was not made by the launching wallet '+P.account+'.');
}
/** True only if the stored signature is for THIS prepared launch, over exactly its (operator, token, recordHash, salt), by P.account. */
function signatureValidFor(P){
 if(!sig||!P||sig.id!==P.id)return false;
 const expectedTyped=Core.launchIntentTypedData({chainId:P.chainId,operator:P.account,token:P.predicted,recordHash:P.recordHash,salt:P.salt});
 if(sig.scheme==='EIP-712'){if(!Core.sameTypedIntent(sig.typedData,expectedTyped))return false;if(sig.typedData.message.recordHash.toLowerCase()!==P.recordHash.toLowerCase()||sig.typedData.message.salt.toLowerCase()!==P.salt.toLowerCase()||!same(sig.typedData.message.token,P.predicted))return false}
 else if(sig.scheme==='personal_sign'){if(sig.message!==Core.launchIntentPlainMessage({chainId:P.chainId,operator:P.account,token:P.predicted,recordHash:P.recordHash,salt:P.salt}))return false}
 else return false;
 return same(sig.signer,P.account);
}
function recordBaseFromP(P){
 return{id:P.id,chainId:P.chainId,rehearsal:IS_REHEARSAL,deployer:P.account.toLowerCase(),factory:Engine.FACTORY.toLowerCase(),predicted:P.predicted.toLowerCase(),symbol:P.draft.symbol,name:P.draft.name,
  recordHash:P.recordHash,salt:P.salt,intentJson:P.provenanceJson,intentRecord:P.provenanceRecord,
  tx:{from:P.account,to:P.request.to,data:P.request.data,value:String(P.request.value),gas:String(P.gas),gasPrice:P.gasPrice==null?null:String(P.gasPrice),chainId:CHAIN_HEX},
  params:P.params,pairTokens:P.pairTokens,markets:P.draft.quotes.map(q=>({address:q.address,symbol:q.symbol})),feeMode:P.draft.feeMode,
  expected:{creatorFeeRecipient:P.draft.feeRecipient.toLowerCase(),creatorTaxBps:P.draft.tax,feeMode:P.draft.feeMode,pairTokens:P.pairTokens.map(a=>a.toLowerCase()),
   economics:{launchFee:String(P.economics.launchFee),baseFeeBps:P.economics.baseFeeBps,protocolFeeShareBps:P.economics.protocolFeeShareBps,maxCreatorTaxBps:P.economics.maxCreatorTaxBps,poolFee:P.economics.poolFee,commitment:P.economics.commitment,supply:String(P.economics.supply),marketPhantoms:P.economics.marketPhantoms},
   openingBuy:P.openingBuy?{ethWei:String(P.openingBuy.ethWei),expectedTokens:String(P.openingBuy.expectedTokens),minTokens:String(P.openingBuy.minTokens),slippageBps:P.openingBuy.slippageBps,legs:P.openingBuy.legs.map(l=>({market:l.market,symbol:l.symbol,ethWei:String(l.ethWei)}))}:null},
  draft:{name:P.draft.name,symbol:P.draft.symbol,description:P.draft.description,logo:P.draft.logo,twitter:P.draft.twitter,website:P.draft.website,tax:P.draft.tax,feeMode:P.draft.feeMode,feeRecipient:P.draft.feeRecipient,openingBuyWei:String(P.draft.openingBuyWei),slippageBps:P.draft.slippageBps,quotes:P.draft.quotes},
  parChecks:P.parChecks,nonceAtPrepare:P.nonceAtPrepare,preparedAt:P.createdAt};
}
async function signLaunchIntent(){
 const P=lastPrepared;
 if(!liveEnabled()||!P||!lastMetadataOk||busy)return;
 if(!draftMatches(P.draft)){invalidateSimulation();toast('Inputs changed after simulation — run it again');return}
 busy=true;updateLiveUnlock();if($('checkIntentSignature')){$('checkIntentSignature').textContent='SIGNING…';$('checkIntentSignature').className=''}
 try{
  const liveChain=Number(await provider.request({method:'eth_chainId'}));if(liveChain!==P.chainId)throw Error('Switch the wallet back to chain '+P.chainId+' before signing.');
  const accounts=await provider.request({method:'eth_accounts'});if(!accounts?.[0]||!same(accounts[0],P.account))throw Error('Wallet account changed. Reconnect and simulate again.');
  const typed=Core.launchIntentTypedData({chainId:P.chainId,operator:P.account,token:P.predicted,recordHash:P.recordHash,salt:P.salt});
  let signature='',scheme='EIP-712',message=null;
  try{signature=await provider.request({method:'eth_signTypedData_v4',params:[P.account,JSON.stringify(typed)]})}
  catch(signErr){const msg=String(signErr?.message||signErr||'').toLowerCase(),unsupported=signErr?.code===-32601||msg.includes('method not found')||msg.includes('unsupported method')||msg.includes('not supported');if(!unsupported)throw signErr;const v=await viem();message=Core.launchIntentPlainMessage({chainId:P.chainId,operator:P.account,token:P.predicted,recordHash:P.recordHash,salt:P.salt});signature=await provider.request({method:'personal_sign',params:[v.stringToHex(message),P.account]});scheme='personal_sign'}
  if(!/^0x[a-fA-F0-9]{130}$/.test(String(signature||'')))throw Error('Wallet returned an unexpected signature.');
  // The wallet popup may have been open for a while: accept the signature only if nothing changed meanwhile.
  if(lastPrepared!==P||!draftMatches(P.draft))throw Error('Inputs changed while the signature was requested. That signature was discarded — simulate and sign again.');
  const signer=await verifyIntentSignature(P,{scheme,typedData:scheme==='EIP-712'?typed:null,message,signature});
  if(lastPrepared!==P)throw Error('The prepared launch changed while verifying the signature. Sign again.');
  sig={id:P.id,scheme,typedData:scheme==='EIP-712'?typed:null,message,signature,signer};
  try{records.put({...recordBaseFromP(P),state:'SIGNATURE_VALID',signature:sig,history:[{state:'SIGNATURE_VALID',at:new Date().toISOString(),note:'intent signed ('+scheme+') by '+signer}]})}catch{}
  if($('checkIntentSignature')){$('checkIntentSignature').textContent='SIGNED ✓ '+scheme;$('checkIntentSignature').className='pass'}
  toast('Launch intent signed ✓');renderFinalReview();
 }catch(e){if(!sig||sig.id!==P.id){sig=null}if($('checkIntentSignature')){$('checkIntentSignature').textContent='NOT SIGNED';$('checkIntentSignature').className='fail'}toast(String(e?.message||e).slice(0,160))}
 finally{busy=false;updateLiveUnlock()}
}
$('signIntent')?.addEventListener('click',signLaunchIntent);

// ---- Duplicate / collision guard (chain-aware + server-side, never localStorage alone).
async function indexerLaunches(query){try{const r=await fetch(PAR_API+'/launches?'+query,{cache:'no-store'});if(!r.ok)return null;const j=await r.json();return Array.isArray(j)?j:(j?.launches||j?.items||j?.data||[])}catch{return null}}
async function runDuplicateGuard(P){
 const res={id:P.id,block:false,overrideNeeded:false,ackNeeded:false,errors:[],warnings:[],existing:[],sources:{}};
 const key={chainId:P.chainId,deployer:P.account,symbol:P.draft.symbol};
 // 1) Local evidence, refreshed from the chain.
 // Every earlier attempt with this wallet + ticker (any state, newest 12) is re-read on-chain: a token that exists is a launch that happened.
 for(const r of records.conflicts(key).all.filter(r=>r.id!==P.id&&!Records.DEPLOYED.has(r.state)).slice(0,12)){try{const l=await Chain.readLaunch(rpc,r.predicted);if(l)records.update(r.id,{},{state:'MINED',note:'found on-chain during the duplicate check'})}catch{}}
 const c=records.conflicts(key);
 if(c.unresolved.length){res.block=true;res.errors.push(`An earlier launch attempt of $${P.draft.symbol} from this wallet is unresolved (${c.unresolved[0].state}, predicted ${c.unresolved[0].predicted}). Open MY LAUNCHES and RE-VERIFY it first. This protects you from launching twice.`)}
 for(const r of c.deployed){res.overrideNeeded=true;res.existing.push(r.predicted)}
 // 2) Server-side guard (PAR indexer + canonical registry), then direct indexer as fallback.
 let g=null;
 try{const r=await fetch(`/api/launch-guard?deployer=${encodeURIComponent(P.account)}&symbol=${encodeURIComponent(P.draft.symbol)}&name=${encodeURIComponent(P.draft.name)}`,{cache:'no-store'});if(r.ok)g=await r.json()}catch{}
 if(g&&g.ok){res.sources.server='ok';
  for(const t of g.sameDeployer||[]){if(!res.existing.some(a=>same(a,t.token))){res.existing.push(t.token)}res.overrideNeeded=true}
  if(g.canonical&&g.canonical.collision){res.block=true;res.errors.push('This ticker/name matches the canonical SyncNet asset '+g.canonical.matches.map(m=>'$'+m.symbol+' ('+m.token+')').join(', ')+'. SyncNet will not launch a token that impersonates it.')}
  if((g.sameSymbol||[]).length){res.ackNeeded=true;res.warnings.push(`${g.sameSymbol.length} other PAR launch${g.sameSymbol.length===1?'':'es'} already use the ticker $${P.draft.symbol} (e.g. ${g.sameSymbol.slice(0,3).map(t=>t.token.slice(0,8)+'…').join(', ')}). Buyers may confuse them.`)}
  if(g.indexer!=='ok'){res.ackNeeded=true;res.warnings.push('The PAR indexer could not be reached by the server check; only on-chain and local evidence was used.')}
 }else{
  res.sources.server='unavailable';
  const mine=await indexerLaunches('deployer='+encodeURIComponent(P.account.toLowerCase())+'&limit=200');
  const bySym=await indexerLaunches('q='+encodeURIComponent(P.draft.symbol)+'&limit=100');
  if(mine){for(const t of mine){if(String(t.symbol||'').toUpperCase()===P.draft.symbol&&address.test(t.token||'')){res.overrideNeeded=true;if(!res.existing.some(a=>same(a,t.token)))res.existing.push(t.token)}}}
  const others=(bySym||[]).filter(t=>String(t.symbol||'').toUpperCase()===P.draft.symbol&&!same(t.deployer,P.account));
  if(others.length){res.ackNeeded=true;res.warnings.push(`${others.length} other PAR launch${others.length===1?'':'es'} already use the ticker $${P.draft.symbol}.`)}
  const sk=Core.confusableSkeleton(P.draft.symbol),nk=Core.confusableSkeleton(P.draft.name);
  const canon=canonicalAssets.filter(ca=>Core.confusableSkeleton(ca.symbol)===sk||(nk&&Core.confusableSkeleton(ca.name)===nk));
  if(canon.length){res.block=true;res.errors.push('This ticker/name matches the canonical SyncNet asset '+canon.map(m=>'$'+m.symbol+' ('+m.token+')').join(', ')+'. SyncNet will not launch a token that impersonates it.')}
  if(!mine&&!bySym){res.ackNeeded=true;res.warnings.push('Neither SyncNet’s duplicate service nor the PAR indexer could be reached. Only on-chain and local evidence was checked — look up $'+P.draft.symbol+' on par.family yourself before launching.')}
 }
 // 3) Every known predicted/deployed address of this wallet+ticker is re-read on-chain.
 for(const a of res.existing){try{const l=await Chain.readLaunch(rpc,a);if(!l)res.existing=res.existing.filter(x=>!same(x,a))}catch{}}
 res.overrideNeeded=res.existing.length>0;
 return res;
}
function renderGuard(){
 const host=$('guardPanel');if(!host)return;const P=lastPrepared;
 if(!P||!guard||guard.id!==P.id||!liveEnabled()){host.hidden=true;return}
 const parts=[];
 if(guard.block)parts.push(`<div class="guard-row bad"><strong>BLOCKED</strong><span>${guard.errors.map(esc).join('<br>')}</span></div>`);
 if(guard.overrideNeeded)parts.push(`<div class="guard-row bad"><strong>ALREADY LAUNCHED FROM THIS WALLET</strong><span>A PAR token with the ticker $${esc(P.draft.symbol)} launched by ${esc(P.account)} already exists: ${guard.existing.map(a=>`<a class="mono" href="/project/${esc(a)}" target="_blank" rel="noopener">${esc(a)}</a>`).join(', ')}. A second launch creates a separate token that cannot be merged.</span><label class="check-line"><input type="checkbox" id="dupAck"> I understand a $${esc(P.draft.symbol)} token from this wallet already exists and I want a second, separate token.</label><small>You will also have to type <strong>${esc(P.draft.symbol)} AGAIN</strong>.</small></div>`);
 if(guard.warnings.length)parts.push(`<div class="guard-row warn"><strong>CHECK BEFORE LAUNCHING</strong><span>${guard.warnings.map(esc).join('<br>')}</span><label class="check-line"><input type="checkbox" id="collisionAck"> I have checked these and still want to launch $${esc(P.draft.symbol)}.</label></div>`);
 if(!parts.length)parts.push(`<div class="guard-row ok"><strong>NO DUPLICATE FOUND</strong><span>No earlier $${esc(P.draft.symbol)} launch from this wallet (local records, on-chain predicted addresses, ${guard.sources.server==='ok'?'SyncNet duplicate service':'PAR indexer'}). No canonical-asset collision.</span></div>`);
 host.innerHTML='<h4>DUPLICATE & IMPERSONATION CHECK</h4>'+parts.join('');host.hidden=false;
 host.querySelectorAll('input[type=checkbox]').forEach(i=>i.addEventListener('change',()=>{updateLiveUnlock();renderFinalReview()}));
 if($('checkDuplicate')){$('checkDuplicate').textContent=guard.block?'BLOCKED':guard.overrideNeeded?'EXISTS · CONFIRM':guard.warnings.length?'WARNINGS':'PASS ✓';$('checkDuplicate').className=guard.block||guard.overrideNeeded?'fail':guard.warnings.length?'':'pass'}
}
function requiredPhrase(P){return P&&guard&&guard.id===P.id&&guard.overrideNeeded?P.draft.symbol+' AGAIN':(P?P.draft.symbol:'')}

// ---- Final review (immutable, generated only from P) + explicit confirmation.
function fnLabel(P){return same(P.request.to,Engine.ROUTER)?'PAR multi-market router · launchAndBuyWithEth':'PAR multi-market factory · launchToken'}
function finalReviewRows(P){
 const e=P.economics,d=P.draft,share=e.baseFeeBps*e.protocolFeeShareBps/10000;
 const rows=[
  ['Network',IS_REHEARSAL?'REHEARSAL · local fork · chain '+P.chainId+' (not Robinhood Chain)':'MAINNET · REAL FUNDS · Robinhood Chain · chain 4663'],
  ['Wallet (deployer)',P.account,true],['Predicted token address',P.predicted,true],
  ['Transaction',fnLabel(P)+' · to '+P.request.to,true],
  ['Total value sent from your wallet',fmtEth(P.request.value)+' ETH  ('+String(P.request.value)+' wei) + network gas'],
  ['PAR launch fee',fmtEth(e.launchFee)+' ETH'],
  ['Opening buy',P.openingBuy?`${fmtEth(P.openingBuy.ethWei)} ETH → ≈${fmtTokens(P.openingBuy.expectedTokens)} ${d.symbol} (${fmtPct(P.openingBuy.supplyBps)} of supply), minimum ${fmtTokens(P.openingBuy.minTokens)} · split ${P.openingBuy.legs.map(l=>l.symbol+' '+fmtEth(l.ethWei)).join(' + ')}${P.openingBuy.unreachable.length?' · not bought in '+P.openingBuy.unreachable.join(', '):''}`:'None'],
  ['Gas limit / max network fee now',String(P.gas)+' gas'+(P.gasPrice!=null?' · ≈'+fmtEth(BigInt(P.gas)*BigInt(P.gasPrice))+' ETH at the current gas price':'')],
  ['Name',d.name],['Ticker','$'+d.symbol],['Description',d.description||'(empty)'],['Logo URI',d.logo||'(none)',true],['X',d.twitter||'(none)',true],['Website',d.website||'(none)',true],
  ['Markets',d.quotes.map((q,i)=>`${d.symbol} / ${q.symbol} · ${q.address}${e.marketPhantoms&&e.marketPhantoms[i]?' · opening reserve '+e.marketPhantoms[i]+' (raw units)':''}`).join('\n'),true],
  ['Creator-fee destination',FEE_LABEL[d.feeMode]+' · '+d.feeRecipient+(P.recipient&&P.recipient.kind&&P.recipient.kind!=='vault'?' ('+P.recipient.kind+')':''),true],
  ['Creator tax',pct(d.tax)],['PAR base fee',pct(e.baseFeeBps)],['Protocol share of the base fee',pct(e.protocolFeeShareBps)+' (= '+pct(share)+' of every trade)'],
  ['Creator share per trade',pct(e.baseFeeBps-share+d.tax)],['Pool fee (every market)',pct(e.poolFee/100)+' ('+e.poolFee+' hundredths of a bip)'],
  ['PAR economics commitment',e.commitment.mode==='committed'?'COMMITTED · digest '+e.commitment.digest:'NOT COMMITTED · '+e.commitment.reason],
  ['Intent recordHash',P.recordHash,true],['PAR salt',P.salt,true],
  ['Calldata',(P.request.data.length-2)/2+' bytes · keccak '+Core.keccak256(P.request.data).slice(0,18)+'…',true],
  ['Signed intent',signatureValidFor(P)?'SIGNED ✓ '+sig.scheme+' by '+sig.signer+' (verified for this exact launch)':'NOT SIGNED — sign the launch intent above'],
  ['PAR live preflight',P.parChecks.filter(c=>c.ok).length+'/'+P.parChecks.length+' checks passed'+(P.parChecks.some(c=>c.severity==='warn')?' · warnings: '+P.parChecks.filter(c=>c.severity==='warn').map(c=>c.label).join(', '):'')],
  ['Duplicate check',!guard||guard.id!==P.id?'running…':guard.block?'BLOCKED':guard.overrideNeeded?'EXISTING TOKEN — explicit confirmation required':guard.warnings.length?'warnings — confirmation required':'no duplicate found'],
 ];
 return rows;
}
function reviewFingerprint(P){return Core.keccak256Utf8(JSON.stringify(finalReviewRows(P).filter(r=>r[0]!=='Signed intent'&&r[0]!=='Duplicate check'&&r[0]!=='Gas limit / max network fee now').map(r=>[r[0],r[1]])))}
function renderFinalReview(){
 const host=$('finalReview');if(!host)return;const P=lastPrepared;
 if(!P||!liveEnabled()){host.hidden=true;host.innerHTML='';finalReviewFor='';updateLiveUnlock();return}
 const keep=$('finalAck')?.checked&&$('finalAck')?.dataset.for===P.id;
 const rows=finalReviewRows(P);
 host.innerHTML=`<div class="final-head"><h4>FINAL REVIEW · IMMUTABLE</h4><span class="status-pill danger">${IS_REHEARSAL?'REHEARSAL':'MAINNET · REAL FUNDS'}</span></div><p class="field-help">Generated from the prepared transaction itself. Your wallet will be asked to send exactly this — nothing on this page can change it now. Review fingerprint <span class="mono">${esc(reviewFingerprint(P).slice(0,18))}…</span></p><dl class="final-grid">${rows.map(([k,v,mono])=>`<div><dt>${esc(k)}</dt><dd${mono?' class="mono"':''}>${esc(v)}</dd></div>`).join('')}</dl><label class="check-line final-ack"><input type="checkbox" id="finalAck" data-for="${esc(P.id)}"${keep?' checked':''}> I UNDERSTAND THIS LAUNCH IS REAL AND IRREVERSIBLE.</label>`;
 host.hidden=false;finalReviewFor=P.id;
 $('finalAck').addEventListener('change',updateLiveUnlock);
 updateLiveUnlock();
}
function launchBlockers(P){
 const b=[];
 if(!liveEnabled())b.push('live launching is locked on this deployment');
 if(!P)b.push('run the simulation');
 if(P&&!lastMetadataOk)b.push('metadata preflight must pass');
 if(P&&!signatureValidFor(P))b.push('sign the launch intent for this exact simulation');
 if(P&&finalReviewFor!==P.id)b.push('final review not shown');
 if(P&&!($('finalAck')?.checked&&$('finalAck')?.dataset.for===P.id))b.push('tick “I understand this launch is real and irreversible”');
 const ns=networkState();if(P&&!ns.ok)b.push(IS_REHEARSAL?'wallet and RPC must both be on the fork chain':'wallet and RPC must both be on Robinhood Chain mainnet (4663)');
 if(REHEARSAL&&REHEARSAL.error)b.push('rehearsal URL is malformed');
 if(P&&(!guard||guard.id!==P.id))b.push('duplicate check still running');
 if(P&&guard&&guard.id===P.id){if(guard.block)b.push('duplicate/impersonation check blocked this launch');if(guard.overrideNeeded&&!$('dupAck')?.checked)b.push('confirm the existing-token warning');if(guard.ackNeeded&&!$('collisionAck')?.checked)b.push('confirm the collision warning')}
 const typed=Core.normalizeText($('liveConfirm')?.value||'').toUpperCase();
 if(P&&typed!==requiredPhrase(P))b.push('type '+requiredPhrase(P));
 if(busy)b.push('busy');if(launched)b.push('this page already sent a launch — reload for a new project');
 return b;
}
function updateLiveUnlock(){
 if(!$('liveCanary'))return;
 $('liveCanary').hidden=!liveEnabled();
 const P=lastPrepared;
 if($('liveValue'))$('liveValue').textContent=P?`This transaction sends ${fmtEth(P.request.value)} ETH + gas to ${same(P.request.to,Engine.ROUTER)?'PAR’s router (launch + opening buy)':'PAR’s launch factory'} ${P.request.to}.`:'Run the simulation to see exactly what this transaction sends.';
 if($('confirmTicker'))$('confirmTicker').textContent=P?requiredPhrase(P):(Core.normalizeText($('symbol').value).toUpperCase()||'TOKEN');
 if($('signIntent'))$('signIntent').disabled=launched||busy||!(P&&lastMetadataOk)||signatureValidFor(P);
 const blockers=launchBlockers(P);
 if($('launchLive'))$('launchLive').disabled=blockers.length>0;
 if($('launchBlockers'))$('launchBlockers').textContent=launched?'This page already sent a launch — see the result below and in MY LAUNCHES. Reload the page to prepare another project.':P&&liveEnabled()?(blockers.length?'Still needed: '+blockers.join(' · ')+'.':'All checks complete. LAUNCH LIVE sends exactly the transaction in the final review.'):'';
}
function draftSnapshot(){return{account,name:$('name').value,symbol:$('symbol').value,description:$('description').value,logo:$('logo').value,twitter:safeUrl($('x').value),website:safeUrl($('website').value),tax,quotes,feeMode,feeRecipient:resolvedRecipient(),openingBuyWei:String(openingBuyWei<0n?'x':openingBuyWei),slippageBps:openingSlippageBps,blockedRecipients:blockedRecipients(),contractRecipientAck:Boolean($('contractRecipientAck')?.checked)}}
/** The current inputs, normalized exactly like the engine, must equal the prepared draft. */
function draftMatches(d){
 let cur;try{cur=Engine.normalize(draftSnapshot())}catch{return false}
 const q=x=>x.quotes.map(q=>q.address.toLowerCase()+'|'+String(q.intent||'')).join(',');
 return same(cur.account,d.account)&&cur.name===d.name&&cur.symbol===d.symbol&&cur.description===d.description&&cur.logo===d.logo&&Number(cur.tax)===Number(d.tax)&&q(cur)===q(d)&&cur.twitter===d.twitter&&cur.website===d.website&&cur.feeMode===d.feeMode&&same(cur.feeRecipient,d.feeRecipient)&&String(cur.openingBuyWei)===String(d.openingBuyWei)&&Number(cur.slippageBps)===Number(d.slippageBps);
}
function renderPreflight(checks){
 const host=$('parPreflight');if(!host)return;if(!checks||!checks.length){host.innerHTML='';return}
 host.innerHTML='<h4>PAR LIVE PREFLIGHT · read from the chain now</h4><div class="preflight-list">'+checks.map(c=>`<div class="pf ${c.ok?'ok':c.severity}"><span>${c.ok?'✓':c.severity==='block'?'✕':'!'}</span><strong>${esc(c.label)}</strong><small class="mono">${esc(c.ok?String(c.actual):'expected '+c.expected+' · got '+c.actual)}</small></div>`).join('')+'</div>';
}

// ---- Uploads: founder session (server-checked key) or, when enabled server-side, a wallet-bound public session.
const UPLOAD_SESSION_KEY='syncnet_upload_session';
let uploadMode=null; // 'public' | 'operator' | 'off'
function uploadSession(){try{const t=sessionStorage.getItem(UPLOAD_SESSION_KEY)||'';const parts=t.split('.');const exp=Number(parts[0]==='v2'?parts[3]:parts[1]||0);if(t&&exp*1000>Date.now()+60000)return t;sessionStorage.removeItem(UPLOAD_SESSION_KEY)}catch{}return''}
async function detectUploads(){if(uploadSession())return(uploadMode='operator');if(uploadMode)return uploadMode;try{const r=await fetch('/api/ipfs-upload',{method:'GET',cache:'no-store'});const j=r.ok?await r.json().catch(()=>({})):{};uploadMode=j&&j.public===true?'public':'off'}catch{uploadMode='off'}return uploadMode}
async function walletUploadSession(){
 if(!provider||!account){openWallet();throw Error('Connect your wallet first — public uploads are tied to the wallet that will launch.')}
 const c=await fetch('/api/upload-auth?address='+encodeURIComponent(account),{cache:'no-store'});const cj=await c.json().catch(()=>({}));if(!c.ok||!cj.message)throw Error(cj.error||'Upload sign-in is not available right now.');
 const v=await viem();const signature=await provider.request({method:'personal_sign',params:[v.stringToHex(cj.message),account]});
 const r=await fetch('/api/upload-auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:account,message:cj.message,signature})});const j=await r.json().catch(()=>({}));if(!r.ok||!j.session)throw Error(j.error||'Upload sign-in failed.');
 try{sessionStorage.setItem(UPLOAD_SESSION_KEY,j.session)}catch{}return j.session;
}
function logoMsg(text,cls=''){$('logoStatus').className='asset-status'+(cls?' '+cls:'');$('logoStatus').textContent=text}
async function uploadPendingImage(){if(!pendingImage||uploadInFlight)return;const mode=await detectUploads();if(mode==='off'){logoMsg('Image ready ✓ It will be uploaded to IPFS when live launching opens on SyncNet. Until then the simulation runs without an on-chain image.');$('uploadLogo').hidden=true;return}uploadInFlight=true;const btn=$('uploadLogo');btn.hidden=true;$('logoPick').classList.add('is-busy');logoMsg('Uploading to IPFS…');try{const img=pendingImage;const data=await fileToBase64(img.blob);const headers={'content-type':'application/json'};let session=uploadSession();if(!session&&mode==='public'){logoMsg('Sign the upload request in your wallet (free, no transaction)…');session=await walletUploadSession()}if(session)headers['x-syncnet-upload-session']=session;const r=await fetch('/api/ipfs-upload',{method:'POST',headers,body:JSON.stringify({name:img.name,type:img.type,size:img.blob.size,data})});const j=await r.json().catch(()=>({}));if(r.status===401||r.status===403){try{sessionStorage.removeItem(UPLOAD_SESSION_KEY)}catch{}uploadMode=null;throw Error(j.error||'Image uploads are not open on this deployment yet. Your image is kept as a preview.')}if(r.status===429)throw Error(j.error||'Upload limit reached. Try again later.');if(r.status===400)throw Error(j.error||'That image could not be accepted.');if(!r.ok||!isIpfs(j.uri))throw Error('The upload did not complete. Retrying is safe.');$('logo').value=j.uri;pendingImage=null;const red=j.pins&&j.pins.secondary?(j.pins.secondary==='not-configured'?' Redundant pin: not configured on this deployment.':' Redundant pin: '+j.pins.secondary+'.'):'';logoMsg(`Uploaded ✓ ${img.note} Server re-encoded ${j.type||img.type} ${j.width||''}${j.width?'×':''}${j.height||''}.${red} This image becomes permanent token metadata at launch.`,'pass');renderLogoPreview();invalidateSimulation()}catch(e){logoMsg(String(e.message||e),'fail');btn.hidden=!pendingImage||uploadMode==='off'}finally{uploadInFlight=false;$('logoPick').classList.remove('is-busy')}}
$('logoFile').addEventListener('change',async()=>{const f=$('logoFile').files?.[0];if(!f)return;const allowed=['image/png','image/jpeg','image/gif','image/webp'];if(!allowed.includes(f.type)){logoMsg('Use a PNG, JPG, GIF or WebP image.','fail');$('logoFile').value='';return}if(f.size>3*1024*1024){logoMsg('That image is over 3 MB. Please use a smaller file.','fail');$('logoFile').value='';return}logoMsg('Preparing image…');try{const img=await normalizeImage(f);if(localPreviewUrl)URL.revokeObjectURL(localPreviewUrl);localPreviewUrl=URL.createObjectURL(img.blob);pendingImage=img;$('logo').value='';$('logoPick').textContent='REPLACE IMAGE';renderLogoPreview();invalidateSimulation();await uploadPendingImage()}catch(e){logoMsg('This image could not be read. Try a different PNG or JPG.','fail')}finally{$('logoFile').value=''}});
$('uploadLogo').addEventListener('click',uploadPendingImage);
$('logo').addEventListener('input',()=>{if($('logo').value.trim()){pendingImage=null;if(localPreviewUrl){URL.revokeObjectURL(localPreviewUrl);localPreviewUrl=''}}});
$('liveConfirm')?.addEventListener('input',updateLiveUnlock);

// ---- Simulation
$('runSimulation').addEventListener('click',async()=>{
 if(busy)return;if(launched){toast('This page already sent a launch. Reload to start a new project.');return}
 if(REHEARSAL&&REHEARSAL.error){toast('Fix the rehearsal URL first.');return}
 if(!validateStep(1)||!validateStep(2)||!validateStep(3))return;
 if(!provider||!account){openWallet();return}
 busy=true;$('runSimulation').disabled=true;$('runSimulation').textContent='SIMULATING…';$('simStatus').className='sim-status';$('simStatus').textContent='Checking wallet, PAR’s live configuration, selected assets and the exact PAR launch call…';
 sig=null;finalReviewFor='';guard=null;lastPrepared=null;if($('finalReview')){$('finalReview').hidden=true;$('finalReview').innerHTML=''}if($('guardPanel')){$('guardPanel').hidden=true;$('guardPanel').innerHTML=''}if($('checkDuplicate')){$('checkDuplicate').textContent='NOT CHECKED';$('checkDuplicate').className=''}if($('checkIntentSignature')){$('checkIntentSignature').textContent='NOT SIGNED';$('checkIntentSignature').className=''}
 try{
  if(chainId!==CHAIN_ID)throw Error('Your wallet is on chain '+(chainId||'unknown')+'. Use the SWITCH NETWORK button to move it to '+(IS_REHEARSAL?'the rehearsal fork '+CHAIN_ID:'Robinhood Chain (4663)')+', then simulate again.');
  const gen=simGen;const v=await viem(),c=await publicClient();$('checkWallet').textContent='PASS ✓';$('checkWallet').className='pass';
  const snap=draftSnapshot();
  if($('x').value.trim()&&!snap.twitter)throw Error('X must be @handle or an https:// link.');
  if($('website').value.trim()&&!snap.website)throw Error('The website must be a valid https:// URL.');
  let prepared;
  try{prepared=await Engine.prepare({client:c,provider,draft:snap,viem:v,chainId:CHAIN_ID})}
  catch(e){if(e&&e.parChecks)renderPreflight(e.parChecks);throw e}
  if(gen!==simGen)throw Error('Project inputs changed while the simulation was running. Nothing was sent — run the simulation again.');
  lastPrepared=prepared;renderPreflight(prepared.parChecks);renderFees();renderOpeningBuy();renderOpeningReview();renderReview();
  $('checkEligibility').textContent='PASS ✓';$('checkEligibility').className='pass';$('checkSimulation').textContent='PASS ✓';$('checkSimulation').className='pass';if($('checkExactSimulation')){$('checkExactSimulation').textContent='PASS ✓';$('checkExactSimulation').className='pass'}
  renderLogoPreview();
  try{records.put({...recordBaseFromP(prepared),state:'PREPARED',history:[{state:'PREPARED',at:new Date().toISOString(),note:'simulation passed'}]})}catch{}
  let metaNote='';
  if(liveEnabled()){try{await metadataPreflight(prepared);metaNote='\nMetadata preflight: PASS ✓';}catch(e){metaNote='\nMetadata preflight: FAILED — '+String(e.message||e);if($('checkMetadata')&&$('checkMetadata').textContent!=='IPFS REQUIRED'){$('checkMetadata').textContent='FAIL';$('checkMetadata').className='fail'}}if(gen!==simGen||lastPrepared!==prepared){lastPrepared=null;lastMetadataOk=false;throw Error('Project inputs changed during metadata preflight. Nothing was sent — run the simulation again.')}}
  const e=prepared.economics;
  $('simStatus').className='sim-status pass';
  $('simStatus').textContent=`SIMULATION PASSED ✓\n\nNetwork: ${IS_REHEARSAL?'REHEARSAL fork '+CHAIN_ID:'Robinhood Chain MAINNET (4663)'}\nPredicted token: ${prepared.predicted}\nMarkets: ${prepared.draft.quotes.map(q=>prepared.draft.symbol+' / '+q.symbol).join(' · ')}\nPAR launch fee: ${fmtEth(e.launchFee)} ETH${prepared.openingBuy?`\nOpening buy: ${fmtEth(prepared.openingBuy.ethWei)} ETH → ≈${fmtTokens(prepared.openingBuy.expectedTokens)} ${prepared.draft.symbol} (${fmtPct(prepared.openingBuy.supplyBps)} of supply) · minimum ${fmtTokens(prepared.openingBuy.minTokens)} · via PAR router ${prepared.request.to}${prepared.openingBuy.unreachable.length?` · no ETH route to ${prepared.openingBuy.unreachable.join(', ')}`:''}`:''}\nSent from wallet: ${fmtEth(prepared.request.value)} ETH + gas\nEstimated gas ceiling: ${prepared.gas.toString()}\nCreator tax: ${prepared.draft.tax/100}%\nPAR base fee: ${pct(e.baseFeeBps)} · protocol share ${pct(e.protocolFeeShareBps)} of base (read live)\nTotal trading fee: ${pct(e.baseFeeBps+prepared.draft.tax)}\nCreator share → ${FEE_LABEL[prepared.draft.feeMode]}: ${prepared.draft.feeRecipient}\nOn-chain logo: ${prepared.draft.logo||'none'}\nEconomics: ${e.commitment.mode==='committed'?'committed to PAR digest':'not committed (spot-priced market) — re-checked before sending'}\nSyncNet intent hash: ${prepared.recordHash}\nPAR salt commitment: ${prepared.salt}${metaNote}\n\nSimulation itself did not request or broadcast a transaction.${liveEnabled()?' Next: duplicate check, sign the intent, read the final review.':' Live launching is not open on this deployment — this simulation shows exactly what would be submitted.'}`;
  if(liveEnabled()){guard=null;if($('checkDuplicate')){$('checkDuplicate').textContent='CHECKING…';$('checkDuplicate').className=''}updateLiveUnlock();const g=await runDuplicateGuard(prepared);if(lastPrepared===prepared){guard=g;renderGuard();renderFinalReview()}}
  updateLiveUnlock();
 }catch(e){
  lastPrepared=null;if($('checkWallet').textContent==='NOT CHECKED')$('checkWallet').textContent='CHECK';$('checkEligibility').textContent='NOT PASSED';$('checkEligibility').className='fail';$('checkSimulation').textContent='NOT PASSED';$('checkSimulation').className='fail';if($('checkExactSimulation')){$('checkExactSimulation').textContent='NOT READY';$('checkExactSimulation').className='fail'}
  $('simStatus').className='sim-status fail';$('simStatus').textContent=String(e?.shortMessage||e?.message||e).slice(0,1200)+'\n\nNo transaction was sent.';
 }finally{busy=false;$('runSimulation').disabled=false;$('runSimulation').textContent='RUN LAUNCH SIMULATION';updateLiveUnlock()}
});

// ---- LAUNCH (H1): snapshot P, persist the full evidence BEFORE the wallet request, never assume "not sent".
function setInputsLocked(on){document.querySelectorAll('.builder input,.builder textarea,.builder select,.builder button').forEach(el=>{if(on){if(!el.disabled){el.dataset.lockedByLaunch='1';el.disabled=true}}else if(el.dataset.lockedByLaunch){el.disabled=false;delete el.dataset.lockedByLaunch}})}
function liveMsg(text,cls=''){const el=$('liveStatus');if(!el)return;el.className='sim-status'+(cls?' '+cls:'');el.textContent=text}
const explorerTx=h=>'https://robinhoodchain.blockscout.com/tx/'+h;
async function fetchIndexerRow(token){if(IS_REHEARSAL)return null;try{const r=await fetch(PAR_API+'/launches/'+token,{cache:'no-store'});return r.ok?await r.json():null}catch{return null}}
$('launchLive')?.addEventListener('click',async()=>{
 const P=lastPrepared; // immutable snapshot — never re-read lastPrepared after this line
 if(!P||busy||launched)return;
 const blockers=launchBlockers(P);if(blockers.length){toast('Not ready: '+blockers[0]);return}
 if(!draftMatches(P.draft)){invalidateSimulation();toast('Inputs changed after simulation — run it again');return}
 busy=true;setInputsLocked(true);updateLiveUnlock();liveMsg('Starting the launch: final checks against the chain…');
 try{
  const lock=await Records.withLaunchLock('syncnet-launch-'+P.chainId,()=>sendLaunch(P));
  if(!lock.ran)liveMsg('Another SyncNet tab is launching right now. Nothing was sent from this tab.','fail');
 }catch(e){
  liveMsg(String(e?.shortMessage||e?.message||e).slice(0,1200),'fail');
 }finally{busy=false;setInputsLocked(false);if(launched){const b=$('runSimulation');b.disabled=true;if(!/LAUNCHED/.test(b.textContent))b.textContent='LAUNCH SENT · RELOAD FOR A NEW PROJECT';if($('liveConfirm'))$('liveConfirm').disabled=true;if($('finalAck'))$('finalAck').disabled=true}updateLiveUnlock();renderLaunchRecords()}
});
async function sendLaunch(P){
 const c=await publicClient();
 // (a) wallet and chain, as the wallet reports them right now
 const liveChain=Number(await provider.request({method:'eth_chainId'}));
 if(liveChain!==P.chainId)throw Error('Your wallet is on chain '+liveChain+', not '+P.chainId+'. Nothing was sent.');
 const accounts=await provider.request({method:'eth_accounts'});
 if(!accounts?.[0]||!same(accounts[0],P.account))throw Error('Wallet account changed. Nothing was sent — simulate again.');
 // (b) duplicate state may have changed in another tab
 const cf=records.conflicts({chainId:P.chainId,deployer:P.account,symbol:P.draft.symbol});
 if(cf.unresolved.some(r=>r.id!==P.id))throw Error('Another launch attempt of $'+P.draft.symbol+' from this wallet was just recorded. Nothing was sent — check MY LAUNCHES.');
 // The duplicate check is repeated now: a launch completed in another tab or device since the review must not slip through.
 liveMsg('Re-running the duplicate check…');
 const g2=await runDuplicateGuard(P);
 const acknowledged=a=>guard&&guard.id===P.id&&guard.existing.some(b=>same(a,b));
 if(g2.block||g2.existing.some(a=>!acknowledged(a)))throw Error('A $'+P.draft.symbol+' launch from this wallet appeared since your review'+(g2.existing.length?' ('+g2.existing.join(', ')+')':'')+'. Nothing was sent — simulate again and check MY LAUNCHES.');
 // (c) PAR parameters unchanged, predicted token still free, exact re-simulation
 liveMsg('Final re-check against the chain (PAR parameters, predicted address, exact simulation)…');
 await Engine.presendCheck({client:c,P});
 if(!signatureValidFor(P))throw Error('The launch-intent signature is not valid for this launch. Nothing was sent.');
 // (d) durable record BEFORE the wallet sees anything
 let nonceAtSend=null;try{nonceAtSend=Number(await rpc('eth_getTransactionCount',[P.account,'pending']))}catch{}
 const tx={from:P.account,to:P.request.to,data:P.request.data,value:hexQty(P.request.value),gas:hexQty(P.gas),chainId:CHAIN_HEX};
 records.put({...recordBaseFromP(P),state:'BROADCAST_ATTEMPTED',signature:sig,nonceAtSend,reviewFingerprint:reviewFingerprint(P),walletRequest:tx,attemptAt:new Date().toISOString(),
  history:[...((records.get(P.id)||{}).history||[]),{state:'BROADCAST_ATTEMPTED',at:new Date().toISOString(),note:'evidence stored; asking the wallet to send'}]});
 activeLaunchId=P.id;launched=true;renderLaunchRecords();
 liveMsg('Launch recorded in this browser (predicted token '+P.predicted+'). Confirm the transaction in your wallet. If anything goes wrong from here on, SyncNet treats the launch as SENT until the chain proves otherwise.');
 // (e) send exactly P.request
 let hash='';
 try{hash=await provider.request({method:'eth_sendTransaction',params:[tx]})}
 catch(e){
  const msg=String(e?.message||e||'');
  const rejected=e&&(e.code===4001||/user (rejected|denied)|rejected the request|denied transaction|user cancel/i.test(msg));
  if(rejected){
   records.update(P.id,{sendError:msg.slice(0,300)},{state:'FAILED_PRE_BROADCAST',note:'wallet: the user rejected the request'});
   launched=false;activeLaunchId='';
   liveMsg('You rejected the transaction in your wallet. Nothing was sent. The attempt stays in MY LAUNCHES, and SyncNet keeps checking the predicted address '+P.predicted+'.','fail');
   return;
  }
  records.update(P.id,{sendError:msg.slice(0,300)},{state:'BROADCAST_UNKNOWN',note:'wallet returned an error: '+msg.slice(0,160)});
  liveMsg('The wallet returned an error ('+msg.slice(0,140)+'). SyncNet cannot tell yet whether the transaction was broadcast, so it is treated as SENT. Checking the chain for the predicted token '+P.predicted+'… Do not launch again.','fail');
  await watchForToken(P,{minutes:3});
  return;
 }
 if(!/^0x[0-9a-fA-F]{64}$/.test(String(hash||''))){
  records.update(P.id,{sendError:'wallet returned no transaction hash'},{state:'BROADCAST_UNKNOWN',note:'wallet returned no usable hash'});
  liveMsg('The wallet did not return a transaction hash. Treating the launch as SENT; checking the chain…','fail');
  await watchForToken(P,{minutes:3});return;
 }
 records.update(P.id,{txHash:hash},{state:'TX_HASH_RECEIVED',note:'wallet returned the transaction hash'});
 liveMsg(`Transaction: ${hash}\n${explorerTx(hash)}\n\nSubmitted. Waiting for confirmation… The launch is recorded in this browser even if you close the tab; MY LAUNCHES can finish the verification later.`);
 let receipt=null;
 try{receipt=await c.waitForTransactionReceipt({hash,confirmations:1,timeout:180000})}catch(e){receipt=null}
 if(!receipt){liveMsg(`Transaction: ${hash}\n${explorerTx(hash)}\n\nNo receipt within 3 minutes. The record stays open (TX_HASH_RECEIVED) and keeps blocking a second launch of $${P.draft.symbol}. Use RE-VERIFY in MY LAUNCHES — do not launch again.`,'fail');return}
 if(receipt.status!=='success'){
  const exists=await Chain.readLaunch(rpc,P.predicted).catch(()=>null);
  if(!exists){records.update(P.id,{receipt:{status:'0x0',blockNumber:Number(receipt.blockNumber)}},{state:'FAILED_POST_BROADCAST',note:'transaction reverted; no token created'});launched=false;activeLaunchId='';liveMsg(`Transaction: ${hash}\n${explorerTx(hash)}\n\nThe transaction was mined but REVERTED. No token was created (checked on-chain). You can run a fresh simulation.`,'fail');return}
 }
 records.update(P.id,{receipt:{status:'0x1',blockNumber:Number(receipt.blockNumber),gasUsed:String(receipt.gasUsed||'')}},{state:'MINED',note:'receipt: success'});
 await finishVerification(P.id,hash);
}
/** Ambiguous wallet response: poll the chain for the predicted token; resolve the record from what the chain says. */
async function watchForToken(P,{minutes}){
 const end=Date.now()+minutes*60e3;
 while(Date.now()<end){
  try{const l=await Chain.readLaunch(rpc,P.predicted);if(l){records.update(P.id,{},{state:'MINED',note:'predicted token found on-chain after an ambiguous wallet response'});liveMsg('The predicted token '+P.predicted+' exists on-chain — the launch WAS executed. Verifying…');await finishVerification(P.id,'');return}}catch{}
  await new Promise(r=>setTimeout(r,5000));
 }
 liveMsg('No token at the predicted address '+P.predicted+' yet. The launch attempt stays open (BROADCAST_UNKNOWN) and blocks a second $'+P.draft.symbol+' launch from this wallet. Check your wallet activity, then use RE-VERIFY in MY LAUNCHES.','fail');
}
async function finishVerification(id,hash){
 const rec=records.get(id);if(!rec)return;
 liveMsg((hash?`Transaction: ${hash}\n${explorerTx(hash)}\n\n`:'')+'On-chain verification (PAR factory record, markets, metadata)…');
 let res;try{res=await Records.reverify(rec,{store:records,rpc,fetchIndexer:fetchIndexerRow})}catch(e){liveMsg((hash?`Transaction: ${hash}\n\n`:'')+'Verification could not read the chain right now ('+String(e.message||e).slice(0,120)+'). The launch record is kept — use RE-VERIFY in MY LAUNCHES. Do not launch again.','fail');return}
 const r=res.record,v=r.verification&&r.verification.onchain;
 let registryNote='';
 const proof=Records.toProof(r);
 if(proof&&v&&v.status==='verified'){
  if(serverConfig.registrySubmissions&&!IS_REHEARSAL){try{const s=await fetch('/api/registry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proof})});const j=await s.json().catch(()=>({}));registryNote=s.ok&&j.status==='VERIFIED'?'SyncNet Registry: VERIFIED and published ✓':'SyncNet Registry: not published yet ('+(j.error||j.status||s.status)+'). Retry from MY LAUNCHES.';if(s.ok)records.update(r.id,{registry:{status:j.status,at:new Date().toISOString()}},{note:'registry submission '+j.status})}catch{registryNote='SyncNet Registry: submission failed — retry from MY LAUNCHES.'}}
  else registryNote=IS_REHEARSAL?'Registry: rehearsal launches are never published.':'Registry: public submissions are not enabled on this deployment — export the proof and add it to syncnet-projects.json to publish.';
 }
 const ok=v&&v.status==='verified';
 const failed=v?v.checks.filter(c=>c.hard&&!c.ok).map(c=>c.label):[];
 let buyLine='';
 {const ob=r.expected&&r.expected.openingBuy,bal=v&&v.actualSummary?v.actualSummary.openingBuyBalance:null;
  if(ob&&bal!=null){const supply=BigInt((r.expected.economics&&r.expected.economics.supply)||'1000000000000000000000000000');const met=BigInt(bal)>=BigInt(ob.minTokens);buyLine=`Opening buy: wallet holds ${fmtTokens(bal)} tokens (${fmtPct(Number(BigInt(bal)*10000n/supply))} of supply) ${met?'✓ (≥ minimum '+fmtTokens(ob.minTokens)+')':'— BELOW the minimum '+fmtTokens(ob.minTokens)}\n`}}
 $('liveStatus').className='sim-status '+(ok?'pass':'fail');
 $('liveStatus').innerHTML=esc(`${ok?'LIVE LAUNCH CONFIRMED ✓':'LAUNCH EXECUTED — VERIFICATION NEEDS ATTENTION'}\n\nToken: ${r.predicted}\n${hash?'Transaction: '+hash+'\n':''}State: ${r.state}\nOn-chain factory record + markets + metadata: ${ok?'VERIFIED ✓':'MISMATCH in '+failed.join(', ')+' — do not launch again; inspect the transaction.'}\n${v&&v.economicsChanged?'PAR fee parameters differed at inclusion; actual values recorded.\n':''}${buyLine}PAR indexer: ${r.verification&&r.verification.indexer?r.verification.indexer.status:'not checked'}${r.state==='INDEXER_PENDING'?' (on-chain is authoritative; RE-VERIFY later upgrades this)':''}\nIntent: recordHash ${r.recordHash} committed in the PAR salt; ${r.signature?r.signature.scheme+' signature by '+r.signature.signer:'no signature'}\n${res.notes.join('\n')}\n${registryNote}\n\n`)+(hash?`<a href="${esc(explorerTx(hash))}" target="_blank" rel="noreferrer">VIEW TRANSACTION ↗</a> · `:'')+`<a href="https://par.family/token/${esc(r.predicted)}" target="_blank" rel="noreferrer">VIEW ON PAR ↗</a> · <a href="/project/${esc(r.predicted)}">PROJECT PAGE →</a> · <a href="/launches.html">MY LAUNCHES →</a>`;
 offerProofExport(r.id);
 if(ok){$('liveConfirm').value='';$('liveConfirm').disabled=true;$('runSimulation').disabled=true;$('runSimulation').textContent='LAUNCHED · RELOAD FOR A NEW PROJECT';toast('Live launch confirmed ✓');clearDraft()}
 renderLaunchRecords();
}
function offerProofExport(id){let b=$('exportLaunchProof');if(!b){b=document.createElement('button');b.id='exportLaunchProof';b.type='button';b.className='btn';b.textContent='EXPORT LAUNCH EVIDENCE (JSON)';$('liveStatus')?.after(b)}b.onclick=()=>downloadText(records.exportJson([id]),'syncnet-launch-evidence-'+String((records.get(id)||{}).symbol||'token').toLowerCase()+'.json')}
function downloadText(text,name){const blob=new Blob([text],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}

// ---- Launch records panel: visible to everyone, never wiped by invalidation or founder unlock (M2).
function stateClass(s){return Records.UNRESOLVED.has(s)?'bad':Records.DEPLOYED.has(s)?(s==='FULLY_VERIFIED'||s==='ONCHAIN_VERIFIED'||s==='INDEXER_PENDING'?'ok':'warn'):s==='FAILED_POST_BROADCAST'?'warn':''}
function renderLaunchRecords(){
 const host=$('launchRecords');if(!host)return;
 const all=records.all().filter(r=>Records.POST_BROADCAST.has(r.state)||r.state==='FAILED_PRE_BROADCAST');
 const open=all.filter(r=>Records.UNRESOLVED.has(r.state));
 if(!all.length){host.hidden=true;host.innerHTML='';return}
 const shown=[...open,...all.filter(r=>!open.includes(r))].slice(0,5);
 host.innerHTML=`<div class="records-head"><h4>MY LAUNCHES${open.length?` · ${open.length} UNRESOLVED`:''}</h4><a class="btn" href="/launches.html">MY LAUNCHES / RECOVER →</a></div>${open.length?'<p class="field-help warn">An unresolved launch blocks a second launch of the same ticker from the same wallet until the chain confirms what happened. Records are never deleted.</p>':''}<div class="records-list">${shown.map(r=>`<div class="record-row"><span class="record-state ${stateClass(r.state)}">${esc(r.state.replace(/_/g,' '))}</span><strong>$${esc(r.symbol||'?')}</strong><span class="mono">${esc(r.predicted||'')}</span>${r.txHash?`<a class="mono" href="${esc(explorerTx(r.txHash))}" target="_blank" rel="noreferrer">tx ${esc(r.txHash.slice(0,10))}…</a>`:'<span class="mono">no tx hash</span>'}<button class="btn small" type="button" data-reverify="${esc(r.id)}">RE-VERIFY</button><button class="btn small" type="button" data-export="${esc(r.id)}">EXPORT</button></div>`).join('')}</div>`;
 host.hidden=false;
 host.querySelectorAll('[data-reverify]').forEach(b=>b.addEventListener('click',async()=>{b.disabled=true;b.textContent='CHECKING…';try{const rec=records.get(b.dataset.reverify);const res=await Records.reverify(rec,{store:records,rpc,fetchIndexer:fetchIndexerRow});toast(res.record.state.replace(/_/g,' ')+(res.notes[0]?' · '+res.notes[0]:''))}catch(e){toast('Chain not readable right now — try again')}finally{renderLaunchRecords()}}));
 host.querySelectorAll('[data-export]').forEach(b=>b.addEventListener('click',()=>downloadText(records.exportJson([b.dataset.export]),'syncnet-launch-evidence.json')));
}
records.subscribe(()=>{renderLaunchRecords();if(lastPrepared&&guard)updateLiveUnlock()});

// ---- Founder unlock (server-checked key). Unlocking never erases launch records or their notices.
if($('liveCanary'))$('liveCanary').hidden=true;
if($('uploadLogo'))$('uploadLogo').hidden=true;
if($('canaryGate'))$('canaryGate').hidden=!CANARY_REQUESTED;
async function unlockCanary(){
 const key=String($('canaryKey')?.value||'');const status=$('canaryAuthStatus'),btn=$('unlockCanary');if(!key){if(status){status.className='sim-status fail';status.textContent='Enter the operator key.'}return}
 btn.disabled=true;btn.textContent='CHECKING…';if(status){status.className='sim-status';status.textContent='Checking…'}
 try{const r=await fetch('/api/canary-auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});const j=await r.json().catch(()=>({}));if(!r.ok||!j.ok)throw Error(j.error||'Access denied.');CANARY_LIVE=true;$('canaryKey').value='';$('canaryGate').hidden=true;try{if(typeof j.uploadSession==='string'&&j.uploadSession)sessionStorage.setItem(UPLOAD_SESSION_KEY,j.uploadSession)}catch{}uploadMode=null;
  // A simulation made before unlocking did not run the metadata preflight: ask for a fresh one (launch records stay untouched).
  if(lastPrepared&&!lastMetadataOk)invalidateSimulation();
  renderWallet();renderLogoPreview();updateLiveUnlock();renderFinalReview();renderLaunchRecords();toast('Live launch controls unlocked · run a fresh simulation');if(pendingImage)uploadPendingImage();else if(!isIpfs($('logo').value))logoMsg('A live launch requires an uploaded project image.');}
 catch(e){if(status){status.className='sim-status fail';status.textContent=String(e.message||e)}}finally{btn.disabled=false;btn.textContent='UNLOCK'}
}
$('unlockCanary')?.addEventListener('click',unlockCanary);$('canaryKey')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();unlockCanary()}});

// Project Kit hand-off: non-sensitive draft fields only, short-lived, so the Kit (opened in a new tab) can prefill its prompts.
function kitHandoff(){try{localStorage.setItem('syncnet_kit_draft',JSON.stringify({at:Date.now(),name:$('name').value.trim(),symbol:$('symbol').value.trim().toUpperCase(),description:$('description').value.trim(),x:$('x').value.trim(),website:$('website').value.trim(),logo:$('logo').value.trim(),feeMode,connections:quotes.map(q=>({symbol:q.symbol,address:q.address,intent:q.intent||''}))}))}catch{}saveDraftNow()}
document.querySelectorAll('.js-open-kit').forEach(a=>a.addEventListener('click',kitHandoff));
// ---- Website decision (step 01) + review reminder
function websiteChoice(){return document.querySelector('input[name="websiteChoice"]:checked')?.value||''}
let websiteStash='';
function renderWebsiteChoice(){const c=websiteChoice();$('websiteKitCard').hidden=c!=='kit';$('websiteUrlWrap').hidden=!(c==='have'||c==='kit');$('websiteNoneNote').hidden=c!=='none';$('websiteLabel').textContent=c==='kit'?'Published URL · paste it here when your site is live':'Website URL';$('website').disabled=c==='none';document.querySelectorAll('.website-option').forEach(l=>l.classList.toggle('selected',l.querySelector('input')?.value===c));const v=$('website').value.trim(),st=$('websiteStatus');if(st){if(v&&/^http:/i.test(v)){st.className='field-help warn';st.textContent='http:// links are not accepted — the link is permanent. Use https://.'}else if(v&&!safeUrl(v)){st.className='field-help warn';st.textContent='Not a valid URL — include https://'}else{st.className='field-help';st.textContent=c==='kit'?'Optional until you publish. If it stays empty, the token launches without a website link.':'Use the final address. A link that later breaks stays broken forever in the token.'}}}
document.querySelectorAll('input[name="websiteChoice"]').forEach(r=>r.addEventListener('change',()=>{if(!r.checked)return;if(r.value==='none'){if($('website').value)websiteStash=$('website').value;$('website').value=''}else if(!$('website').value&&websiteStash){$('website').value=websiteStash}renderWebsiteChoice();invalidateSimulation();saveDraft();if(r.value==='have'||(r.value==='kit'&&!$('website').value))requestAnimationFrame(()=>{if(r.value==='have')$('website').focus()})}));
$('website').addEventListener('input',renderWebsiteChoice);
function renderWebsiteReview(){const box=$('reviewWebsiteCta');if(!box)return;const P=lastPrepared;const v=P?P.draft.website:safeUrl($('website').value),c=websiteChoice();if(v){box.hidden=true;return}box.hidden=false;if(c==='none'){$('reviewWebsiteCtaTitle').textContent='No website link · your choice';$('reviewWebsiteCtaText').textContent='The token will never link to a website. If you want one, build it now — it takes a few minutes and your draft stays here.'}else{$('reviewWebsiteCtaTitle').textContent='No website URL yet';$('reviewWebsiteCtaText').textContent='If you launch now, the token has no website link — permanently. Build the site first, publish it, then add its URL.'}}
$('reviewAddUrl')?.addEventListener('click',()=>{const r=document.querySelector('input[name="websiteChoice"][value="have"]');if(r&&websiteChoice()!=='kit'){r.checked=true;r.dispatchEvent(new Event('change'))}setStep(1,{scroll:true});requestAnimationFrame(()=>{renderWebsiteChoice();$('website').focus()})});
// ---- Draft persistence: non-sensitive fields only, per network namespace. Never stores simulations, signatures, keys or unuploaded images.
const DRAFT_KEY=KEY_NS+'builder_draft_v1';let draftTimer=null,draftRestoring=false;
function draftData(){return{v:1,at:Date.now(),name:$('name').value,symbol:$('symbol').value,description:$('description').value,x:$('x').value,website:$('website').value,websiteChoice:websiteChoice(),logo:isIpfs($('logo').value)||/^https:\/\//.test($('logo').value.trim())?$('logo').value.trim():'',tax,feeMode,creatorRecipient:creatorRecipientInput(),openingBuy:$('openingBuy')?.value||'',openingSlippageBps,quotes:quotes.map(q=>({address:q.address,symbol:q.symbol,name:q.name||'',intent:q.intent||''}))}}
function draftHasContent(d){return Boolean(d&&(String(d.name||'').trim()||String(d.symbol||'').trim()||String(d.description||'').trim()||(d.quotes||[]).length))}
function saveDraftNow(){if(draftRestoring||launched||($('draftBanner')&&!$('draftBanner').hidden))return;try{const d=draftData();if(draftHasContent(d))localStorage.setItem(DRAFT_KEY,JSON.stringify(d))}catch{}}
function saveDraft(){clearTimeout(draftTimer);draftTimer=setTimeout(saveDraftNow,400)}
function clearDraft(){try{localStorage.removeItem(DRAFT_KEY)}catch{}}
function readDraft(){try{const d=JSON.parse(localStorage.getItem(DRAFT_KEY)||'null');if(!d||d.v!==1||Date.now()-Number(d.at||0)>14*864e5)return null;return draftHasContent(d)?d:null}catch{return null}}
function ago(t){const m=Math.round((Date.now()-t)/60000);return m<1?'just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':Math.round(m/1440)+' days ago'}
async function restoreDraft(d){draftRestoring=true;try{
 const set=(id,v)=>{if($(id)&&typeof v==='string')$(id).value=v};
 set('name',d.name);set('symbol',d.symbol);set('description',d.description);set('x',d.x);set('website',d.website);
 if(typeof d.logo==='string'&&d.logo){$('logo').value=d.logo}
 const wc=document.querySelector(`input[name="websiteChoice"][value="${['have','kit','none'].includes(d.websiteChoice)?d.websiteChoice:''}"]`);if(wc)wc.checked=true;
 const tb=document.querySelector(`.tax-btn[data-tax="${Number(d.tax)}"]`);if(tb)tb.click();
 const fm=document.querySelector(`input[name="feeMode"][value="${['holders','creator','burn','floor'].includes(d.feeMode)?d.feeMode:''}"]`);if(fm){fm.checked=true;feeMode=fm.value}
 if($('creatorRecipient')&&typeof d.creatorRecipient==='string')$('creatorRecipient').value=d.creatorRecipient;
 if(typeof d.openingBuy==='string'&&$('openingBuy')){const w=parseEthWei(d.openingBuy);if(w!==null&&w<=OPENING_MAX_WEI){$('openingBuy').value=w===0n?'':d.openingBuy;openingBuyWei=w}}
 if([50,100,200,500].includes(Number(d.openingSlippageBps))&&$('openingSlippage')){$('openingSlippage').value=String(d.openingSlippageBps);openingSlippageBps=Number(d.openingSlippageBps)}
 renderOpeningBuy();
 renderWebsiteChoice();renderLogoPreview();renderFees();renderByteCounters();classifyRecipientSoon();
 // Connections are restored but re-verified on-chain: eligibility can change while you were away.
 const saved=(Array.isArray(d.quotes)?d.quotes:[]).filter(q=>address.test(q?.address||'')).slice(0,5);
 quotes=saved.map(q=>({address:q.address,symbol:Core.sanitizeForDisplay(String(q.symbol||'TOKEN'),{maxLength:16}),name:Core.sanitizeForDisplay(String(q.name||''),{maxLength:60}),intent:stripUnsafe(q.intent||'').slice(0,160),eligible:false}));
 renderQuotes();invalidateSimulation();
 if(quotes.length){$('assetStatus').className='asset-status';$('assetStatus').textContent='Re-checking '+quotes.length+' saved connection'+(quotes.length===1?'':'s')+' on-chain…';let bad=[];for(const q of quotes){try{const live=await inspectToken(q.address);q.symbol=live.symbol;q.name=live.name;q.eligible=live.eligible===true;if(!q.eligible)bad.push(q.symbol)}catch{bad.push(q.symbol)}}renderQuotes();$('assetStatus').className='asset-status '+(bad.length?'fail':'pass');$('assetStatus').textContent=bad.length?'Not eligible anymore or unreachable: '+bad.join(', ')+'. Remove or replace before continuing.':'Saved connections re-checked ✓'}
}finally{draftRestoring=false}}
(function offerDraft(){const d=readDraft(),b=$('draftBanner');if(!d||!b)return;const hasPrefill=new URL(location.href).searchParams.get('with');b.hidden=false;$('draftTitle').textContent='Continue your draft'+(d.name?' · '+Core.sanitizeForDisplay(String(d.name),{maxLength:40}):'')+(d.symbol?' ($'+String(d.symbol).toUpperCase().slice(0,10)+')':'')+'?';const open=records.unresolvedAll();$('draftMeta').textContent='Saved in this browser '+ago(Number(d.at))+'. Simulations and signatures are never saved — you will run a fresh one.'+(hasPrefill?' Continuing replaces the connection you just opened.':'')+(open.length?' Note: '+open.length+' launch attempt'+(open.length===1?' is':'s are')+' still unresolved — see MY LAUNCHES before launching again.':'');$('draftContinue').onclick=async()=>{b.hidden=true;await restoreDraft(d);toast('Draft restored');$('name').focus()};$('draftDiscard').onclick=()=>{clearDraft();b.hidden=true;toast('Draft discarded')}})();
['name','symbol','description','x','website','logo','creatorRecipient'].forEach(id=>$(id)?.addEventListener('input',saveDraft));
document.addEventListener('change',e=>{if(e.target.closest?.('.builder'))saveDraft()});
document.addEventListener('click',e=>{if(e.target.closest?.('.tax-btn,.asset-preset,.asset-remove,#checkAdd'))setTimeout(saveDraft,50)});
document.addEventListener('input',e=>{if(e.target.matches?.('[data-intent-address]'))saveDraft()});
function prefill(){const u=new URL(location.href),a=u.searchParams.get('with')||u.searchParams.get('buildOn');if(address.test(a||'')){$('customAsset').value=a;setStep(2);$('checkAdd').click();}}

// ---- Boot: server config (rollout gate), canonical identities, live PAR fees, RPC chain, unresolved launches.
async function boot(){
 renderNetworkBanner();
 if(REHEARSAL&&REHEARSAL.error){$('runSimulation').disabled=true;$('runSimulation').textContent='FIX REHEARSAL URL';launched=true}
 if(IS_REHEARSAL)document.body.classList.add('is-rehearsal');
 const tasks=[];
 tasks.push(fetch('/api/config',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(j=>{if(j&&typeof j==='object')serverConfig={...serverConfig,...j,loaded:true};}).catch(()=>{}));
 tasks.push(fetch('/syncnet-projects.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(j=>{canonicalAssets=(j?.projects||[]).filter(p=>p?.registry?.canonical===true&&address.test(p.token||'')).map(p=>({token:p.token.toLowerCase(),symbol:String(p.symbol||p.profile?.name||'').toUpperCase(),name:String(p.name||p.profile?.name||'')}))}).catch(()=>{}));
 tasks.push(rpc('eth_chainId',[]).then(h=>{rpcChainVerified=Number(h)}).catch(()=>{rpcChainVerified=null}));
 tasks.push(Chain.readParState(rpc,{}).then(s=>{if(s&&s.chainId===CHAIN_ID)liveParState=s}).catch(()=>{}));
 await Promise.all(tasks);
 renderWallet();renderFees();renderReview();renderQuotes();updateLiveUnlock();renderLaunchRecords();
 // Auto re-verify unresolved launches (read-only) so a lost tab never hides a launch that happened.
 for(const r of records.unresolvedAll()){if(Number(r.chainId)!==CHAIN_ID)continue;try{await Records.reverify(r,{store:records,rpc,fetchIndexer:fetchIndexerRow})}catch{}}
 renderLaunchRecords();
}
renderQuotes();renderWallet();renderLogoPreview();renderFees();renderWebsiteChoice();renderOpeningBuy();renderByteCounters();prefill();boot();
})();
