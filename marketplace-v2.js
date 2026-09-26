(function(){'use strict';
/*
 * SyncNet Marketplace V1 (client). Real records only:
 *  - listings/offers/deals/passports come from /api/marketplace (persistent, server-verified);
 *  - every write the user makes here is ONE EIP-712 signature (never a transaction, never an approval);
 *  - the two on-chain steps a Deal can contain are ordinary wallet transactions the USER sends and reviews:
 *      · "Pay seller": a plain value transfer to the seller wallet (no data, no contract);
 *      · "Transfer creator-fee right": PAR's own transferCreatorFeeRecipient(token, buyer) on the PAR factory;
 *    both are verified afterwards from the chain by the server, never assumed;
 *  - nothing in this file simulates success. What SyncNet cannot verify is labelled MANUAL / OFF-CHAIN.
 * This file writes NOTHING to browser storage: marketplace records exist only server-side.
 */
const Core=window.SyncNetCore,Chain=window.SyncNetChain,Market=window.SyncNetMarket,Ipfs=window.SyncNetIpfs;
const $=id=>document.getElementById(id);
if(!$('mp-listings'))return;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const disp=(v,n=64)=>Core.sanitizeForDisplay(String(v??''),{maxLength:n});
const short=a=>/^0x[0-9a-fA-F]{40}$/.test(String(a||''))?a.slice(0,6)+'…'+a.slice(-4):String(a||'');
const shortHash=h=>String(h||'').slice(0,10)+'…'+String(h||'').slice(-6);
const lc=v=>String(v||'').toLowerCase();
const same=(a,b)=>lc(a)===lc(b);
const rpc=Chain.makeRpc(Chain.ROBINHOOD.rpcUrl,{timeoutMs:10000,retries:1});
const nowSec=()=>Math.floor(Date.now()/1000);
const nonce=()=>{const a=new Uint8Array(32);crypto.getRandomValues(a);return'0x'+[...a].map(b=>b.toString(16).padStart(2,'0')).join('')};
const when=t=>{try{return new Date(t).toISOString().replace('T',' ').slice(0,16)+' UTC'}catch{return String(t||'')}};
const FEE_BADGE={wallet:['CREATOR FEE TRANSFERABLE','transferable'],vault:['CREATOR FEE: NOT TRANSFERABLE (PAR VAULT)','immutable'],contract:['CREATOR FEE: REQUIRES MANUAL VERIFICATION','conditional'],unknown:['CREATOR FEE: REQUIRES MANUAL VERIFICATION','conditional']};
const KIND_LABEL={onchain:'ON-CHAIN VERIFIED',syncnet:'SYNCNET-SIGNED',manual:'MANUAL / OFF-CHAIN'};
const KIND_CLS={onchain:'transferable',syncnet:'transferable',manual:'manual'};

// ---------------------------------------------------------------- wallet
// Same discovery + chooser model as the Builder (builder-v2.js): EIP-6963 announcements first, the legacy
// window.ethereum / window.ethereum.providers list as a fallback, deduplicated by provider object and rdns.
// With several wallets installed the user picks one explicitly — never providers[0], never window.ethereum alone.
let provider=null,account='',chainId=null,serviceOn=null;
const providers=[],providerSet=new Set();
function providerLabel(p,info){if(info?.name)return info.name;if(p?.isBraveWallet)return 'Brave Wallet';if(p?.isPhantom)return 'Phantom';if(p?.isRabby)return 'Rabby';if(p?.isMetaMask)return 'MetaMask';return 'EVM wallet'}
function addProvider(p,info){if(!p||typeof p.request!=='function'||providerSet.has(p))return;if(info?.rdns&&providers.some(x=>x.rdns===info.rdns))return;providerSet.add(p);providers.push({provider:p,name:info?.name||providerLabel(p,info),rdns:info?.rdns||''});}
function discoverLegacy(){if(providers.length)return;const legacy=window.ethereum?.providers?.length?window.ethereum.providers:[window.ethereum].filter(Boolean);legacy.forEach(p=>addProvider(p));}
window.addEventListener('eip6963:announceProvider',e=>addProvider(e.detail?.provider,e.detail?.info));window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(discoverLegacy,450);
const bound=new WeakSet();
function bind(p){if(typeof p.on!=='function'||bound.has(p))return;bound.add(p);p.on('accountsChanged',a=>{if(p!==provider)return;account=lc(a?.[0]||'');renderWallet();rerender()});p.on('chainChanged',id=>{if(p!==provider)return;chainId=Number(id);renderWallet()});p.on('disconnect',()=>{if(p!==provider)return;provider=null;account='';chainId=null;renderWallet();rerender()});}
let walletReturnFocus=null;
function closeWalletModal(){$('mpWalletModal').classList.remove('open');walletReturnFocus?.focus?.();}
/** CONNECT WALLET / CHANGE WALLET: one provider → connect it directly; several → explicit chooser. UI only: no signature, no transaction, no chain switch. */
function openWallet(){
 discoverLegacy();
 if(!providers.length){note('No EVM wallet was found in this browser. Install MetaMask, Rabby or another EVM wallet (on mobile: open this page inside your wallet app’s browser).','fail');return}
 if(providers.length===1){connectTo(providers[0].provider);return}
 walletReturnFocus=document.activeElement;const host=$('mpProviderList');host.innerHTML='';
 providers.forEach(d=>{const b=document.createElement('button');b.className='provider';b.type='button';b.textContent=d.name;b.addEventListener('click',()=>connectTo(d.provider));host.appendChild(b)});
 $('mpWalletModal').classList.add('open');requestAnimationFrame(()=>(host.querySelector('button')||$('mpCloseWallet'))?.focus());
}
// Phantom with a Solana-only account selected cannot expose an EVM account: explained by wallet-evm-notice.js; every other error keeps the generic note.
const walletInfo=p=>providers.find(x=>x.provider===p)||null;
async function connectTo(p){
 try{provider=p;bind(p);const accounts=await p.request({method:'eth_requestAccounts'});window.SyncNetEvmNotice?.check(p,walletInfo(p),accounts);account=lc(accounts?.[0]||'');chainId=Number(await p.request({method:'eth_chainId'}));note('');window.SyncNetEvmNotice?.hide();closeWalletModal()}catch(e){provider=null;account='';chainId=null;if(window.SyncNetEvmNotice?.matches(p,walletInfo(p),e)){note('');closeWalletModal();window.SyncNetEvmNotice.show({onRetry:()=>connectTo(p),returnFocus:$('mpConnect')})}else note('Wallet connection did not complete.','fail')}
 renderWallet();rerender();
}
function renderWallet(){
 $('mpWalletName').textContent=account?short(account):'Not connected';
 $('mpConnect').textContent=account?'Change wallet':'Connect wallet';
 $('mpWalletNote').textContent=account?(chainId===4663?'Robinhood Chain · MAINNET ✓ — Marketplace signatures are free; only Deal payments/fee transfers are transactions.':'Wallet on chain '+(chainId||'unknown')+'. Signatures still work; switch to Robinhood Chain (4663) before any Deal transaction.'):'Connect an EVM wallet to claim, list, offer or settle. Browsing needs no wallet.';
}
$('mpConnect').addEventListener('click',openWallet);
$('mpCloseWallet').addEventListener('click',closeWalletModal);
$('mpWalletModal').addEventListener('click',e=>{if(e.target===$('mpWalletModal'))closeWalletModal()});
$('mpWalletModal').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeWalletModal();return}if(e.key!=='Tab')return;const f=[...$('mpWalletModal').querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(x=>!x.disabled&&!x.hidden);if(!f.length)return;const first=f[0],last=f[f.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}});
async function signTyped(kind,message){
 if(!provider||!account)throw Error('Connect a wallet first.');
 const typed=Market.typedData(kind,message);
 try{return await provider.request({method:'eth_signTypedData_v4',params:[account,JSON.stringify(typed)]})}
 catch(e){
  if(e&&(e.code===4001||/rejected|denied/i.test(String(e.message))))throw Error('You rejected the signature. Nothing was saved.');
  if(e&&(e.code===-32601||/method not found|not supported/i.test(String(e.message))))throw Error('This wallet cannot sign EIP-712 typed data, which Marketplace V1 requires.');
  throw Error('The wallet could not sign: '+String(e?.message||e).slice(0,140));
 }
}

// ---------------------------------------------------------------- API
async function api(params){const u=new URL('/api/marketplace',location.origin);for(const[k,v]of Object.entries(params))u.searchParams.set(k,v);const r=await fetch(u,{cache:'no-store'});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'The Marketplace is unavailable right now.');serviceOn=j.enabled!==false;return j}
async function post(body){const r=await fetch('/api/marketplace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'The Marketplace refused the request.');return j}
function note(text,cls){const el=$('mpServiceNote');el.hidden=!text;el.className='asset-status'+(cls?' '+cls:'');el.textContent=text||''}

// ---------------------------------------------------------------- routing
const PANELS={browse:'mp-browse-panel',sell:'mp-sell-panel',mine:'mp-mine-panel',detail:'mp-detail-panel',deal:'mp-deal-panel'};
let route={view:'browse',id:''};
function parseHash(){const h=location.hash.replace(/^#\/?/,'');let m;if((m=/^listing=(0x[0-9a-fA-F]{64})$/.exec(h)))return{view:'detail',id:lc(m[1])};if((m=/^deal=(0x[0-9a-fA-F]{64})$/.exec(h)))return{view:'deal',id:lc(m[1])};if(h==='sell')return{view:'sell',id:''};if(h==='mine')return{view:'mine',id:''};return{view:'browse',id:''}}
function go(hash){if(('#'+hash)===location.hash||(!hash&&!location.hash)){onRoute()}else location.hash=hash}
function onRoute(){route=parseHash();for(const[v,id]of Object.entries(PANELS)){const el=$(id);if(el){el.hidden=v!==route.view;el.classList.toggle('active',v===route.view)}}
 document.querySelectorAll('.mp-workspace-tab').forEach(b=>{const active=b.dataset.mpView===route.view||(route.view==='detail'&&b.dataset.mpView==='browse')||(route.view==='deal'&&b.dataset.mpView==='mine');b.classList.toggle('active',active);if(b.getAttribute('role')==='tab')b.setAttribute('aria-selected',active?'true':'false')});
 rerender();
}
window.addEventListener('hashchange',onRoute);
document.querySelectorAll('[data-mp-view]').forEach(b=>b.addEventListener('click',()=>{const v=b.dataset.mpView;go(v==='browse'?'':v);document.getElementById('marketplace-workspace')?.scrollIntoView({behavior:'smooth',block:'start'})}));
function rerender(){({browse:renderBrowse,sell:renderSellState,mine:renderMine,detail:()=>renderDetail(route.id),deal:()=>renderDeal(route.id)})[route.view]()}

// ---------------------------------------------------------------- shared renderers
function statusPill(status){const cls={ACTIVE:'transferable',OFFER_ACCEPTED:'conditional',IN_TRANSFER:'conditional',COMPLETED:'transferable',CANCELLED:'immutable',EXPIRED:'immutable',OPEN:'conditional',PENDING:'conditional'}[status]||'manual';return`<strong class="mp-state ${cls}">${esc(status.replace(/_/g,' '))}</strong>`}
function projectHead(l){
 const sym=disp(l.snapshot?.symbol||'',16)||'TOKEN';
 const logo=Ipfs.imgHtml(l.snapshot?.logo||'',{letter:sym.charAt(0)});
 return`<div class="example-project">${logo||''}<div><h3>${esc(disp(l.snapshot?.name||'',64)||'PAR project')} · $${esc(sym)}</h3><p class="mono">${esc(l.token)}</p></div></div>`;
}
function feeBadge(l){const[label,cls]=FEE_BADGE[l.feeRight?.kind]||FEE_BADGE.unknown;return`<strong class="mp-state ${cls}">${esc(label)}</strong>`}
function card(l){
 return`<article class="mp-listing-card"><div class="mp-listing-top"><div>${projectHead(l)}</div><div class="mp-price"><strong>${esc(l.price)} ${esc(l.currency)}</strong><span>ASKING PRICE</span></div></div>
 <div class="mp-listing-meta"><span class="mp-state transferable">VERIFIED OPERATOR</span><span class="mp-state transferable">LIVE PAR PROJECT</span>${feeBadge(l)}${statusPill(l.status)}${l.terms.includeFeeRight?'':''}<span>${esc(when(l.createdAt))}</span></div>
 <p class="mp-listing-teaser">${esc(disp(l.terms.description,240))}${l.terms.description.length>240?'…':''}</p>
 <div class="actions mp-listing-actions"><a class="btn primary" href="#listing=${esc(l.id)}">OPEN LISTING</a><a class="btn" href="/project/${esc(l.token)}">PROJECT PAGE</a></div></article>`;
}
async function renderBrowse(){
 const host=$('mp-listings');
 try{
  const j=await api({view:'listings'});
  if(j.enabled===false){note('Marketplace listings are not enabled on this deployment (no durable store is configured). Nothing can be listed or bought here yet.','fail');host.innerHTML='<div class="mp-empty"><strong>MARKETPLACE NOT ENABLED</strong><span>This deployment has no persistent Marketplace storage, so there are no listings to show.</span></div>';return}
  note('');
  const rows=(j.listings||[]).filter(l=>l.status==='ACTIVE');
  const rest=(j.listings||[]).filter(l=>l.status!=='ACTIVE').slice(0,6);
  if(!rows.length&&!rest.length){host.innerHTML='<div class="mp-empty"><strong>NO PROJECTS LISTED YET</strong><span>The Marketplace shows only real, operator-signed listings. When a project is listed, it appears here for every visitor.</span><button class="btn primary mp-empty-action" type="button" data-mp-view="sell">SELL A PROJECT</button></div>';host.querySelector('[data-mp-view]')?.addEventListener('click',()=>go('sell'));return}
  host.innerHTML=rows.map(card).join('')+(rest.length?`<details class="technical-details mp-past"><summary>Past listings (${rest.length})</summary>${rest.map(card).join('')}</details>`:'');
 }catch(e){host.innerHTML=`<div class="network-empty">${esc(String(e.message||e))}</div>`}
}

// ---------------------------------------------------------------- listing detail + offers
async function renderDetail(id,flash){
 const host=$('mpDetail');host.innerHTML='<div class="network-empty">Loading the listing…</div>';
 let j;try{j=await api({view:'listing',id})}catch(e){host.innerHTML=`<div class="network-empty">${esc(String(e.message||e))}</div>`;return}
 const l=j.listing,p=j.passport,offers=j.offers||[];
 const isSeller=account&&same(account,l.seller),isBuyerParty=j.deal&&account&&(same(account,j.deal.buyer)||same(account,j.deal.seller));
 const included=(l.terms.included||[]).map(a=>`<div class="mp-listing-package-row"><span>${esc(a.label)}${a.note?` <small>· ${esc(a.note)}</small>`:''}</span><strong class="mp-state ${KIND_CLS[a.kind]||'manual'}">${esc(KIND_LABEL[a.kind]||a.kind)}</strong></div>`).join('');
 const excluded=(l.terms.notIncluded||[]).map(x=>`<div class="mp-listing-package-row"><span>${esc(x)}</span><strong class="mp-state immutable">NOT INCLUDED</strong></div>`).join('');
 const history=(p?.history||[]).slice(-8).reverse().map(h=>`<li><span class="mono">${esc(when(h.at))}</span> ${esc(h.type.replace(/-/g,' '))}${h.from?` · ${esc(short(h.from))} → ${esc(short(h.to))}`:h.operator?` · ${esc(short(h.operator))}`:''}</li>`).join('');
 host.innerHTML=`<div class="mp-panel-head"><div><div class="eyebrow">Listing</div><h2 class="section-title">${esc(disp(l.snapshot?.name||'PROJECT',40)).toUpperCase()}.</h2></div><div class="mp-panel-actions"><a class="btn" href="#">← ALL LISTINGS</a></div></div>
 <article class="mp-listing-card"><div class="mp-listing-top"><div>${projectHead(l)}</div><div class="mp-price"><strong>${esc(l.price)} ${esc(l.currency)}</strong><span>ASKING PRICE</span></div></div>
 <div class="mp-listing-meta">${statusPill(l.status)}<span class="mp-state transferable">VERIFIED OPERATOR ${esc(short(l.seller))}</span>${feeBadge(l)}<span>Listed ${esc(when(l.createdAt))}</span><span>Valid until ${esc(when(l.expiry*1000))}</span></div>
 <p class="mp-listing-teaser">${esc(l.terms.description)}</p>
 <div class="mp-card-package-head"><strong>WHAT THE BUYER GETS</strong><span>Signed by the seller · evidence levels are SyncNet’s, not the seller’s</span></div>
 <div class="mp-listing-package">${included}
 <div class="mp-listing-package-row"><span>Creator-fee right</span><strong class="mp-state ${l.terms.includeFeeRight?'transferable':'immutable'}">${l.terms.includeFeeRight?'INCLUDED · ON-CHAIN TRANSFER VERIFIED IN THE DEAL':'NOT INCLUDED'}</strong></div>
 ${excluded}
 <div class="mp-listing-package-row"><span>Token supply · holders’ tokens · locked liquidity · token metadata</span><strong class="mp-state immutable">NEVER SOLD · NEVER TRANSFERRED</strong></div></div>
 <div class="mp-seal"><span>LISTING COMMITMENT</span><strong class="mono">${esc(shortHash(l.termsHash))}</strong><em>EIP-712-signed by the seller · every offer binds to this exact terms hash</em></div>
 <div class="mp-card-package-head"><strong>OPERATOR PROVENANCE</strong><span>SyncNet Passport · signature-verified server records</span></div>
 <div class="passport-rows"><div class="passport-row"><span>Recognised operator</span><div><strong class="mono">${esc(p?.operator||'—')}</strong><small>${p?`Since ${esc(when(p.operatorSince))} · deployer ${esc(short(p.deployer))}`:''}</small></div></div>
 ${history?`<div class="passport-row"><span>Operator history</span><div><ul class="record-history">${history}</ul></div></div>`:''}</div>
 <div class="asset-status" id="mpDetailStatus" role="status" aria-live="polite" hidden></div>
 ${l.status==='ACTIVE'&&!isSeller?`
 <div class="mp-card-package-head"><strong>MAKE AN OFFER</strong><span>One free EIP-712 signature · the seller decides</span></div>
 <div class="field-grid"><div class="field"><label for="mpOfferAmount">Offer · ${esc(l.currency)}</label><input class="input" id="mpOfferAmount" inputmode="decimal" placeholder="${esc(l.price)}"></div>
 <div class="field"><label for="mpOfferExpiry">Offer valid for</label><select class="input" id="mpOfferExpiry"><option value="3">3 days</option><option value="7" selected>7 days</option><option value="30">30 days</option></select></div></div>
 <div class="actions"><button class="btn primary" id="mpMakeOffer" type="button">${account?'MAKE SIGNED OFFER':'CONNECT A WALLET TO OFFER'}</button></div>`:''}
 ${isSeller&&l.status==='ACTIVE'?`<div class="actions"><button class="btn" data-act="cancel-listing" type="button">CANCEL LISTING · SIGN</button></div>`:''}
 ${l.dealId&&isBuyerParty?`<div class="actions"><a class="btn primary" href="#deal=${esc(l.dealId)}">OPEN THE DEAL ROOM →</a></div>`:l.dealId?`<p class="field-help">An offer has been accepted; the deal is settled privately between buyer and seller.</p>`:''}
 ${offers.length&&(isSeller||offers.some(o=>account&&same(o.buyer,account)))?`
 <div class="mp-card-package-head"><strong>OFFERS (${offers.length})</strong><span>${isSeller?'Accept or reject — both are signatures':'Your offers on this listing'}</span></div>
 ${offers.filter(o=>isSeller||same(o.buyer,account)).map(o=>`<div class="mp-offer-row"><span class="mono">${esc(short(o.buyer))}</span><strong>${esc(o.amount)} ${esc(o.currency)}</strong>${statusPill(o.status)}<span>${esc(when(o.createdAt))}</span>${isSeller&&o.status==='PENDING'?`<button class="btn small" data-act="accept" data-offer="${esc(o.id)}" type="button">ACCEPT</button><button class="btn small" data-act="reject" data-offer="${esc(o.id)}" type="button">REJECT</button>`:''}</div>`).join('')}`:''}
 </article>`;
 const st=(t,cls)=>{const el=$('mpDetailStatus');el.hidden=!t;el.className='asset-status'+(cls?' '+cls:'');el.textContent=t||''};
 if(flash)st(flash,'pass');
 $('mpMakeOffer')?.addEventListener('click',async()=>{
  if(!account){connect();return}
  const btn=$('mpMakeOffer');if(btn.disabled)return;btn.disabled=true; // double-click guard
  try{
   const amount=Market.checkAmount($('mpOfferAmount').value);
   if(!amount)throw Error('Enter a positive amount (up to 18 decimals).');
   const expiry=nowSec()+Number($('mpOfferExpiry').value)*86400;
   const message={listingId:l.id,termsHash:l.termsHash,token:l.token,buyer:account,amount,currency:l.currency,nonce:nonce(),expiry};
   st('Waiting for the offer signature in your wallet… (a free signature, not a transaction)');
   const signature=await signTyped('Offer',message);
   await post({action:'offer',...message,signature});
   renderDetail(id,'Offer signed and delivered to the seller ✓');
  }catch(e){st(String(e.message||e),'fail');btn.disabled=false}
 });
 host.querySelectorAll('[data-act]').forEach(btn=>btn.addEventListener('click',async()=>{
  try{
   btn.disabled=true;
   if(btn.dataset.act==='cancel-listing'){
    const message={listingId:l.id,seller:account,nonce:nonce()};
    st('Waiting for the cancellation signature…');
    const signature=await signTyped('ListingCancel',message);
    await post({action:'cancel-listing',...message,signature});
    renderDetail(id,'Listing cancelled ✓');return;
   }
   const decision=btn.dataset.act==='accept'?'accept':'reject';
   const message={offerId:btn.dataset.offer,listingId:l.id,seller:account,decision,nonce:nonce()};
   st('Waiting for the '+decision+' signature…');
   const signature=await signTyped('OfferDecision',message);
   const r=await post({action:'offer-decision',...message,signature});
   if(decision==='accept'&&r.deal){st('Offer accepted ✓ — the Deal room is open.','pass');go('deal='+r.deal.id)}
   else renderDetail(id,'Offer '+(decision==='accept'?'accepted':'rejected')+' ✓');
  }catch(e){st(String(e.message||e),'fail');btn.disabled=false}
 }));
}

// ---------------------------------------------------------------- deal room
async function renderDeal(id){
 const host=$('mpDeal');host.innerHTML='<div class="network-empty">Loading the deal…</div>';
 let j;try{j=await api({view:'deal',id})}catch(e){host.innerHTML=`<div class="network-empty">${esc(String(e.message||e))}</div>`;return}
 const d=j.deal,l=j.listing;
 const role=account?(same(account,d.buyer)?'buyer':same(account,d.seller)?'seller':''):'';
 const c=d.checklist;
 const step=(title,state,cls,body)=>`<div class="mp-deal-step"><div class="mp-deal-step-head"><strong>${esc(title)}</strong><strong class="mp-state ${cls}">${esc(state)}</strong></div>${body||''}</div>`;
 const both=(conf)=>`buyer ${conf.buyer?'✓':'—'} · seller ${conf.seller?'✓':'—'}`;
 const opDone=c.operatorTransfer.done,intent=d.transfer&&d.transfer.intent;
 const feeStep=c.feeRight.required?step('Creator-fee right → buyer (on-chain)',c.feeRight.done?'VERIFIED ON-CHAIN':'PENDING',c.feeRight.done?'transferable':'conditional',
  c.feeRight.done?`<p class="field-help">Verified: the PAR factory now names the buyer as creator-fee recipient. Tx <span class="mono">${esc(shortHash(c.feeRight.txHash))}</span></p>`
  :role==='seller'?`<p class="field-help">Sends PAR’s own <span class="mono">transferCreatorFeeRecipient(token, buyer)</span> from your wallet to the PAR factory. SyncNet then verifies the recipient from the chain — the transaction hash alone proves nothing.</p><div class="actions"><button class="btn primary" data-act="fee-send" type="button">TRANSFER FEE RIGHT · WALLET TRANSACTION</button></div><div class="asset-entry"><input class="input mono" id="mpFeeTx" placeholder="already sent? paste the 0x… transaction hash"><button class="btn" data-act="fee-verify" type="button">VERIFY ON-CHAIN</button></div>`
  :`<p class="field-help">Waiting for the seller to transfer the fee right on-chain. Anyone can then verify it:</p><div class="asset-entry"><input class="input mono" id="mpFeeTx" placeholder="0x… transaction hash"><button class="btn" data-act="fee-verify" type="button">VERIFY ON-CHAIN</button></div>`):'';
 const payStep=c.payment.required?step(`Payment · ${esc(d.price)} ${esc(d.currency)}`,c.payment.done?(c.payment.kind==='onchain'?'VERIFIED ON-CHAIN':'CONFIRMED BY BOTH'):'PENDING',c.payment.done?'transferable':'conditional',
  c.payment.kind==='onchain'
   ?(c.payment.done?`<p class="field-help">Verified: ${esc(d.price)} ETH from the buyer wallet to the seller wallet. Tx <span class="mono">${esc(shortHash(c.payment.evidence.txHash))}</span></p>`
     :`<p class="field-help">SyncNet V1 does <strong>not</strong> escrow funds. Payment is a direct wallet-to-wallet transfer of <strong>${esc(d.price)} ETH</strong> to the seller wallet <span class="mono">${esc(d.seller)}</span>, sent and confirmed in YOUR wallet, then verified here from the chain.</p>${role==='buyer'?`<div class="actions"><button class="btn primary" data-act="pay" type="button">PAY SELLER · ${esc(d.price)} ETH · WALLET TRANSACTION</button></div>`:''}<div class="asset-entry"><input class="input mono" id="mpPayTx" placeholder="0x… payment transaction hash"><button class="btn" data-act="pay-verify" type="button">VERIFY PAYMENT ON-CHAIN</button></div>`)
   :`<p class="field-help">This deal is priced in ${esc(d.currency)}, settled outside SyncNet. Both parties confirm the payment by signature (${both(c.payment.confirmations)}).</p>${role&&!c.payment.confirmations[role]?`<div class="actions"><button class="btn" data-act="confirm" data-item="payment" type="button">CONFIRM PAYMENT · SIGN AS ${role.toUpperCase()}</button></div>`:''}`):'';
 const assetRows=(c.assets||[]).map(a=>`<div class="mp-listing-package-row"><span>${esc(a.label)} <small>· ${esc(both(a.confirmations))}</small></span>${a.done?'<strong class="mp-state transferable">CONFIRMED BY BOTH</strong>':role&&!a.confirmations[role]?`<button class="btn small" data-act="confirm" data-item="${esc(a.id)}" type="button">CONFIRM · SIGN</button>`:'<strong class="mp-state conditional">WAITING</strong>'}</div>`).join('');
 const allDone=opDone&&(!c.feeRight.required||c.feeRight.done)&&(!c.payment.required||c.payment.done)&&(c.assets||[]).every(a=>a.done);
 host.innerHTML=`<div class="mp-panel-head"><div><div class="eyebrow">Deal room · non-custodial settlement</div><h2 class="section-title">${esc(disp(l?.snapshot?.name||'PROJECT',40)).toUpperCase()} · ${esc(d.price)} ${esc(d.currency)}.</h2></div><div class="mp-panel-actions"><a class="btn" href="#listing=${esc(d.listingId)}">← LISTING</a></div></div>
 <article class="mp-listing-card">
 <div class="mp-listing-meta">${statusPill(d.status)}<span class="mono">seller ${esc(short(d.seller))}</span><span class="mono">buyer ${esc(short(d.buyer))}</span><span>${esc(when(d.createdAt))}</span>${role?`<strong class="mp-state transferable">YOU ARE THE ${role.toUpperCase()}</strong>`:'<strong class="mp-state manual">VIEW ONLY · NOT A PARTY</strong>'}</div>
 <div class="asset-status" id="mpDealStatus" role="status" aria-live="polite" hidden></div>
 ${step('Operator transfer (SyncNet Passport)',opDone?'TRANSFERRED · BOTH SIGNATURES VERIFIED':intent?'INTENT SIGNED · WAITING FOR THE BUYER':'PENDING',opDone?'transferable':'conditional',
  opDone?`<p class="field-help">The recognised operator is now the buyer. Recorded permanently in the Passport history.</p>`
  :intent?`<p class="field-help">The seller signed a transfer intent (${esc(shortHash(intent.hash))}, valid until ${esc(when(intent.expiry*1000))}). The buyer’s acceptance signature completes it — both signatures are verified server-side.</p>${role==='buyer'?`<div class="actions"><button class="btn primary" data-act="transfer-accept" type="button">ACCEPT OPERATOR TRANSFER · SIGN</button></div>`:''}`
  :`<p class="field-help">The operator handover needs BOTH parties: the seller signs a transfer intent, then the buyer signs the acceptance.</p>${role==='seller'?`<div class="actions"><button class="btn primary" data-act="transfer-intent" type="button">SIGN TRANSFER INTENT</button></div>`:''}`)}
 ${feeStep}
 ${payStep}
 ${assetRows?`<div class="mp-card-package-head"><strong>MANUAL / OFF-CHAIN ITEMS</strong><span>SyncNet cannot verify these — both parties confirm each one</span></div><div class="mp-listing-package">${assetRows}</div>`:''}
 ${step('Completion',d.status==='COMPLETED'?'COMPLETED':d.status==='CANCELLED'?'CANCELLED':allDone?'READY · NEEDS BOTH SIGNATURES':'BLOCKED UNTIL EVERY STEP IS DONE',d.status==='COMPLETED'?'transferable':d.status==='CANCELLED'?'immutable':allDone?'conditional':'manual',
  d.status==='COMPLETED'?`<p class="field-help">Completed ${esc(when(d.completedAt))}. The settlement record and the operator history are permanent.</p>`
  :d.status==='CANCELLED'?`<p class="field-help">Cancelled by the ${esc(d.cancelledBy)} ${esc(when(d.cancelledAt))}${d.cancelReason?': '+esc(d.cancelReason):''}.</p>`
  :`<p class="field-help">Confirmations: ${both(d.confirmations.complete)}. Completing signs the exact checklist state above — if anything changes, the signature is refused.</p>${role&&allDone&&!d.confirmations.complete[role]?`<div class="actions"><button class="btn primary" data-act="complete" type="button">CONFIRM COMPLETION · SIGN AS ${role.toUpperCase()}</button></div>`:''}${role&&d.status==='OPEN'?`<div class="actions"><button class="btn" data-act="deal-cancel" type="button">CANCEL DEAL…</button></div>`:''}`)}
 </article>`;
 const st=(t,cls)=>{const el=$('mpDealStatus');el.hidden=!t;el.className='asset-status'+(cls?' '+cls:'');el.textContent=t||''};
 host.querySelectorAll('[data-act]').forEach(btn=>btn.addEventListener('click',async()=>{
  const act=btn.dataset.act;btn.disabled=true;
  try{
   if(!account&&act!=='fee-verify'&&act!=='pay-verify'){connect();btn.disabled=false;return}
   if(act==='transfer-intent'){
    const message={dealId:d.id,token:d.token,from:account,to:d.buyer,nonce:nonce(),expiry:nowSec()+7*86400};
    st('Waiting for the transfer-intent signature…');
    await post({action:'transfer-intent',...message,signature:await signTyped('TransferIntent',message)});
   }else if(act==='transfer-accept'){
    const message={dealId:d.id,token:d.token,from:d.seller,to:account,intentHash:intent.hash,nonce:nonce(),expiry:nowSec()+7*86400};
    st('Waiting for the acceptance signature…');
    await post({action:'transfer-accept',...message,signature:await signTyped('TransferAccept',message)});
   }else if(act==='fee-send'){
    const launch=await Chain.readLaunch(rpc,d.token);
    if(!launch)throw Error('The PAR record could not be read right now. Nothing was sent.');
    if(!same(launch.creatorFeeRecipient,account))throw Error('Your wallet ('+short(account)+') is not the current on-chain fee recipient ('+short(launch.creatorFeeRecipient)+'). Nothing was sent.');
    const data=Core.functionSelector('transferCreatorFeeRecipient(address,address)')+Core.abiEncode(['address','address'],[d.token,d.buyer]).slice(2);
    if(!confirm('Send transferCreatorFeeRecipient to the PAR factory '+launch.factory+'?\n\ntoken: '+d.token+'\nnew recipient (buyer): '+d.buyer+'\nvalue: 0 ETH\n\nThis is irreversible.'))throw Error('Cancelled. Nothing was sent.');
    st('Confirm the transaction in your wallet…');
    const hash=await provider.request({method:'eth_sendTransaction',params:[{from:account,to:launch.factory,data,value:'0x0'}]});
    st('Transaction sent ('+shortHash(hash)+'). Verifying the new recipient on-chain…');
    await new Promise(r=>setTimeout(r,1500));
    await post({action:'fee-right-evidence',dealId:d.id,txHash:hash});
   }else if(act==='fee-verify'){
    const hash=String($('mpFeeTx').value||'').trim();
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw Error('Paste a 0x… transaction hash.');
    st('Verifying the fee-right transfer on-chain…');
    await post({action:'fee-right-evidence',dealId:d.id,txHash:hash});
   }else if(act==='pay'){
    const wei=Market.toWei(d.price);
    if(!confirm('Pay the seller directly from your wallet?\n\nto (seller): '+d.seller+'\namount: '+d.price+' ETH\n\nSyncNet does not escrow this payment.'))throw Error('Cancelled. Nothing was sent.');
    st('Confirm the payment in your wallet…');
    const hash=await provider.request({method:'eth_sendTransaction',params:[{from:account,to:d.seller,value:'0x'+wei.toString(16),data:'0x'}]});
    st('Payment sent ('+shortHash(hash)+'). Verifying on-chain…');
    await new Promise(r=>setTimeout(r,1500));
    await post({action:'payment-evidence',dealId:d.id,txHash:hash});
   }else if(act==='pay-verify'){
    const hash=String($('mpPayTx').value||'').trim();
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw Error('Paste the 0x… payment transaction hash.');
    st('Verifying the payment on-chain…');
    await post({action:'payment-evidence',dealId:d.id,txHash:hash});
   }else if(act==='confirm'){
    const message={dealId:d.id,wallet:account,role,item:btn.dataset.item,stateHash:d.completeHash,nonce:nonce()};
    st('Waiting for the confirmation signature…');
    await post({action:'deal-confirm',...message,signature:await signTyped('DealConfirm',message)});
   }else if(act==='complete'){
    if(Market.hashJson(d.checklistState)!==d.completeHash)throw Error('The deal state looks inconsistent. Reload and try again.');
    const message={dealId:d.id,wallet:account,role,item:'complete',stateHash:d.completeHash,nonce:nonce()};
    st('Waiting for the completion signature…');
    await post({action:'deal-confirm',...message,signature:await signTyped('DealConfirm',message)});
   }else if(act==='deal-cancel'){
    const reason=prompt('Cancel this deal? State a short reason (recorded permanently):','');
    if(reason===null)throw Error('Cancellation aborted.');
    const message={dealId:d.id,wallet:account,reason:disp(reason,300),nonce:nonce()};
    st('Waiting for the cancellation signature…');
    await post({action:'deal-cancel',...message,signature:await signTyped('DealCancel',message)});
   }
   st('Done ✓','pass');renderDeal(id);
  }catch(e){st(String(e.message||e),'fail');btn.disabled=false}
 }));
}

// ---------------------------------------------------------------- sell flow
let claimCheck=null; // {token, launch, feeRight, basis, passport} bound to the exact checked token+account
function sellStatus(t,cls){const el=$('mpClaimStatus');el.className='asset-status'+(cls?' '+cls:'');el.textContent=t}
function sellError(t){const el=$('mpSellError');el.hidden=!t;el.textContent=t||''}
function renderSellState(){
 const canList=Boolean(claimCheck&&claimCheck.claimed);
 $('mpCreateListing').disabled=!canList;
 renderFeeRow();
}
function renderFeeRow(){
 const cb=$('mpIncludeFee'),state=$('mpFeeRowState');
 if(!claimCheck||!claimCheck.feeRight){cb.disabled=true;cb.checked=false;state.textContent='CHECK THE PROJECT FIRST';state.className='mp-state conditional';return}
 const fr=claimCheck.feeRight;
 if(fr.kind==='wallet'&&same(fr.recipient,account)){cb.disabled=false;state.textContent='ON-CHAIN TRANSFERABLE · YOUR WALLET IS THE RECIPIENT';state.className='mp-state transferable'}
 else if(fr.kind==='vault'){cb.disabled=true;cb.checked=false;state.textContent='NOT TRANSFERABLE · FIXED TO A PAR VAULT';state.className='mp-state immutable'}
 else if(fr.kind==='wallet'){cb.disabled=true;cb.checked=false;state.textContent='HELD BY ANOTHER WALLET ('+short(fr.recipient).toUpperCase()+') · CANNOT BE INCLUDED';state.className='mp-state conditional'}
 else{cb.disabled=true;cb.checked=false;state.textContent='RECIPIENT IS A CONTRACT · REQUIRES MANUAL VERIFICATION';state.className='mp-state conditional'}
}
async function checkProject(){
 const token=lc(String($('mpToken').value||'').trim());claimCheck=null;renderSellState();$('mpSignClaim').disabled=true;$('mpClaimFacts').hidden=true;
 if(!/^0x[0-9a-f]{40}$/.test(token)){sellStatus('Enter a valid 0x token contract.','fail');return}
 sellStatus('Reading the PAR factory record on Robinhood Chain…');
 let launch=null;try{launch=await Chain.readLaunch(rpc,token)}catch{sellStatus('Robinhood Chain could not be read right now. Try again.','fail');return}
 if(!launch){sellStatus('This address is not a PAR launch, so it cannot be claimed or listed.','fail');return}
 let passport=null;try{passport=(await api({view:'passport',token})).passport}catch{}
 let recipientKind='unknown';try{const code=String(await Chain.getCode(rpc,launch.creatorFeeRecipient)).toLowerCase();recipientKind=code==='0x'||code.startsWith('0xef0100')?'wallet':'contract'}catch{}
 const VA={[lc(Chain.ROBINHOOD.holderVault)]:'holders',[lc(Chain.ROBINHOOD.burnVault)]:'burn',[lc(Chain.ROBINHOOD.floorVault)]:'floor'};
 const vault=VA[lc(launch.creatorFeeRecipient)];
 const feeRight={recipient:lc(launch.creatorFeeRecipient),kind:vault?'vault':recipientKind,vault};
 // Deployer / fee-recipient evidence only ESTABLISHES the first Passport; once one exists only its operator may claim
 // (refresh) and control changes only through the signed Marketplace transfer — the fee right never moves it.
 let basis='';
 if(passport)basis=account&&same(passport.operator,account)?'operator':'';
 else if(account&&same(launch.deployer,account))basis='deployer';
 else if(account&&same(launch.creatorFeeRecipient,account)&&feeRight.kind==='wallet')basis='fee-recipient';
 claimCheck={token,launch,feeRight,basis,passport,claimed:Boolean(account&&passport&&same(passport.operator,account))};
 const rows=[
  ['PAR factory record','EXISTS · '+launch.kind+' factory','ok'],
  ['Deployer (on-chain)',launch.deployer,account&&same(launch.deployer,account)?'ok':''],
  ['Creator-fee recipient (on-chain)',launch.creatorFeeRecipient+(vault?' · PAR '+vault+' vault':feeRight.kind==='wallet'?' · wallet':' · contract'),account&&same(launch.creatorFeeRecipient,account)?'ok':''],
  ['Recognised operator (SyncNet)',passport?passport.operator:'none recorded yet',claimCheck.claimed?'ok':''],
  ['Your wallet',account||'not connected',basis?'ok':''],
 ];
 $('mpClaimFacts').innerHTML=rows.map(r=>`<div class="passport-row"><span>${esc(r[0])}</span><div><strong class="mono ${r[2]}">${esc(r[1])}</strong></div></div>`).join('');
 $('mpClaimFacts').hidden=false;
 if(!account){sellStatus('Connect the wallet that operates this project, then check again.','fail');return}
 if(claimCheck.claimed){sellStatus('This wallet is already the recognised operator ✓ — continue to step 02.','pass');renderSellState();return}
 if(passport&&!basis){sellStatus('An operator is already recognised for this project ('+short(passport.operator)+'). Operational control changes only through a Marketplace Passport transfer — being the deployer or the creator-fee recipient does not transfer it.','fail');return}
 if(!basis){sellStatus('This wallet is neither the deployer nor the current fee-recipient wallet, so it cannot claim this project.','fail');return}
 sellStatus('Evidence found: your wallet is the on-chain '+(basis==='deployer'?'deployer':'creator-fee recipient')+'. Sign the operator claim to create the Passport record.','pass');
 $('mpSignClaim').disabled=false;
 renderSellState();
}
$('mpCheckProject').addEventListener('click',checkProject);
$('mpToken').addEventListener('input',()=>{claimCheck=null;$('mpSignClaim').disabled=true;$('mpClaimFacts').hidden=true;renderSellState()});
$('mpSignClaim').addEventListener('click',async()=>{
 if(!claimCheck||!claimCheck.basis)return;
 const cc=claimCheck;
 try{
  $('mpSignClaim').disabled=true;
  const message={token:cc.token,operator:account,basis:cc.basis,nonce:nonce(),expiry:nowSec()+900};
  sellStatus('Waiting for the operator-claim signature… (free signature, no transaction)');
  const signature=await signTyped('OperatorClaim',message);
  if(claimCheck!==cc)throw Error('The project changed while signing. Check again.');
  const r=await post({action:'claim',...message,signature});
  cc.passport=r.passport;cc.claimed=true;
  sellStatus('Operator claim verified and recorded ✓ ('+r.passport.history[r.passport.history.length-1].type+'). Continue to step 02.','pass');
  renderSellState();
 }catch(e){sellStatus(String(e.message||e),'fail');$('mpSignClaim').disabled=false}
});
$('mpCreateListing').addEventListener('click',async()=>{
 sellError('');
 const cc=claimCheck;
 if(!cc||!cc.claimed){sellError('Claim the project first (step 01).');return}
 try{
  $('mpCreateListing').disabled=true;
  const price=Market.checkAmount($('mpPrice').value);
  if(!price)throw Error('Enter a positive asking price (up to 18 decimals).');
  const currency=$('mpCurrency').value;
  const description=String($('mpDescription').value||'').trim();
  const included=[{label:'SyncNet operator record (Project Passport)',kind:'syncnet'}];
  document.querySelectorAll('.mp-asset:checked').forEach(x=>included.push({label:x.dataset.label,kind:'manual'}));
  String($('mpCustomAssets').value||'').split('\n').map(s=>s.trim()).filter(Boolean).slice(0,10).forEach(s=>included.push({label:s.slice(0,140),kind:'manual'}));
  const includeFeeRight=$('mpIncludeFee').checked&&!$('mpIncludeFee').disabled;
  if(includeFeeRight)included.push({label:'Creator-fee right (transferCreatorFeeRecipient to the buyer)',kind:'onchain'});
  const terms={description,included,notIncluded:['Token supply and holders’ tokens','Locked PAR launch liquidity','Immutable token metadata','X account / handle'].concat(includeFeeRight?[]:['Creator-fee right']),includeFeeRight};
  const t=Market.normalizeTerms(terms);
  if(!t.ok)throw Error('Listing terms: '+t.error+'.');
  const message={token:cc.token,seller:account,price,currency,termsHash:Market.hashJson(t.terms),nonce:nonce(),expiry:nowSec()+Number($('mpExpiry').value)*86400};
  sellStatus('Waiting for the listing signature… it covers the project, price, currency, exact terms and expiry.');
  const signature=await signTyped('Listing',message);
  const r=await post({action:'list',...message,terms,signature});
  sellStatus('Listing signed and published ✓','pass');
  go('listing='+r.listing.id);
 }catch(e){sellError(String(e.message||e))}
 finally{renderSellState()}
});

// ---------------------------------------------------------------- my activity
async function renderMine(){
 const host=$('mpMine');
 if(!account){host.innerHTML='<div class="network-empty">Connect a wallet to see your listings, offers and deals.</div>';return}
 let j;try{j=await api({view:'wallet',address:account})}catch(e){host.innerHTML=`<div class="network-empty">${esc(String(e.message||e))}</div>`;return}
 const row=(title,items,render)=>`<div class="mp-card-package-head"><strong>${esc(title)} (${items.length})</strong></div>${items.length?items.map(render).join(''):'<p class="field-help">None yet.</p>'}`;
 host.innerHTML=`<div class="mp-panel-head"><div><div class="eyebrow">My activity</div><h2 class="section-title">LISTINGS · OFFERS · DEALS.</h2></div></div><article class="mp-listing-card">
 ${row('My listings',j.listings||[],l=>`<div class="mp-offer-row"><span>${esc(disp(l.snapshot?.name||l.token,40))}</span><strong>${esc(l.price)} ${esc(l.currency)}</strong>${statusPill(l.status)}<a class="btn small" href="#listing=${esc(l.id)}">OPEN</a></div>`)}
 ${row('My offers',j.offers||[],o=>`<div class="mp-offer-row"><span class="mono">${esc(short(o.token))}</span><strong>${esc(o.amount)} ${esc(o.currency)}</strong>${statusPill(o.status)}<a class="btn small" href="#listing=${esc(o.listingId)}">OPEN</a></div>`)}
 ${row('My deals',j.deals||[],d=>`<div class="mp-offer-row"><span class="mono">${esc(short(d.token))}</span><strong>${esc(d.price)} ${esc(d.currency)}</strong>${statusPill(d.status)}<a class="btn small" href="#deal=${esc(d.id)}">DEAL ROOM</a></div>`)}
 </article>`;
}

// ---------------------------------------------------------------- boot
(async()=>{try{const c=await api({view:'config'});if(c.enabled===false)note('Marketplace writes are not enabled on this deployment (persistent storage is not configured). Existing pages stay read-only.','fail')}catch{}})();
// Silent reconnect after a refresh: eth_accounts never prompts. It restores a wallet only when EXACTLY ONE
// discovered provider already authorised this page; with several authorised wallets the user chooses explicitly.
async function silentReconnect(){
 discoverLegacy();if(account)return;
 const found=[];
 for(const d of providers){try{const a=await d.provider.request({method:'eth_accounts'});if(a&&a[0])found.push({p:d.provider,a:a[0]})}catch{}}
 if(found.length!==1)return;
 try{provider=found[0].p;bind(provider);account=lc(found[0].a);chainId=Number(await provider.request({method:'eth_chainId'}));renderWallet();rerender()}catch{provider=null;account='';chainId=null}
}
setTimeout(silentReconnect,providers.length?0:500);
renderWallet();
onRoute();
})();
