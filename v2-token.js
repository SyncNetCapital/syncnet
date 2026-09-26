(function(){'use strict';
/*
 * Project page (/project/<address>). Trust boundary (M3): the PAR factory record is read on-chain FIRST.
 * Only a verified PAR launch gets launch claims (markets, creator-fee recipient, ownerless token, NETWORK HUB).
 * Anything else is shown neutrally as NOT VERIFIED AS A PAR LAUNCH, with no ownership, economic or security claims.
 * Provenance statuses come from lib/syncnet-provenance.js (checked live). Browser-local launch records are shown
 * separately and are never presented as public provenance.
 */
const Core=window.SyncNetCore,Chain=window.SyncNetChain,Prov=window.SyncNetProvenance,Records=window.SyncNetRecords,Origins=window.SyncNetOrigins;
const API='https://api.par.family';
const rpc=Chain.makeRpc(Chain.ROBINHOOD.rpcUrl,{timeoutMs:10000,retries:1});
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const disp=(v,n=64)=>Core.sanitizeForDisplay(String(v??''),{maxLength:n});
const safeSymbol=v=>{const x=disp(v,24).replace(/^\$/,'');return x?x.toUpperCase():'TOKEN'};
const valid=a=>/^0x[a-fA-F0-9]{40}$/.test(String(a||'')),same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
const short=a=>valid(a)?a.slice(0,6)+'…'+a.slice(-4):String(a||'');
const VAULTS={[Chain.ROBINHOOD.holderVault]:'holders',[Chain.ROBINHOOD.burnVault]:'burn',[Chain.ROBINHOOD.floorVault]:'floor'};
function markets(d){return Array.isArray(d?.markets)&&d.markets.length?d.markets:[d]}
function pairAddr(m){return m?.pairToken||m?.quoteToken||m?.pairTokenAddress||m?.quoteTokenAddress||''}
function tokenAddr(d){return d?.token||d?.tokenAddress||d?.address||''}
const Ipfs=window.SyncNetIpfs; // one canonical IPFS renderer: Pinata → ipfs.io → dweb.link → deterministic placeholder
let projectsPromise=null;
function projects(){return projectsPromise||(projectsPromise=fetch('/syncnet-projects.json',{cache:'no-store'}).then(r=>r.ok?r.json():{projects:[]}).then(j=>Array.isArray(j.projects)?j.projects:[]).catch(()=>[]))}
async function serverEntry(a){try{const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),6000);const r=await fetch('/api/registry',{cache:'no-store',signal:ctl.signal});clearTimeout(t);if(!r.ok)return null;const j=await r.json();return(j.entries||[]).find(e=>same(e.token,a))||null}catch{return null}}
function localRecords(a){try{return Records.createStore('syncnet_').all().filter(r=>same(r.predicted,a))}catch{return[]}}
function rows(body){if(Array.isArray(body))return body;for(const k of['launches','items','data','rows','results'])if(Array.isArray(body?.[k]))return body[k];return[]}
async function history(){try{const r=await fetch('/api/par-launches-all',{cache:'no-store'});if(r.ok)return rows(await r.json())}catch{}try{const r=await fetch(`${API}/launches?orderBy=createdAt&orderDirection=desc&limit=500`,{cache:'no-store'});if(r.ok)return rows(await r.json())}catch{}return[]}
async function ercSymbol(a){if(/^0x0{40}$/i.test(a))return'ETH';try{const h=await Chain.ethCall(rpc,a,Chain.SEL.symbol);return safeSymbol(Core.abiDecode(['string'],h)[0])}catch{return short(a)}}
function originOf(v){try{const u=new URL(String(v||'').trim());return u.protocol==='https:'?u.origin:''}catch{return''}}
/** L13: a permanent website field is shown as it is — https as a link, http:// as text with an insecure warning, never replaced by "None". */
function websiteView(raw){const v=disp(raw,256);if(!v)return{html:'None',note:'This token has no website link in its metadata.'};let u=null;try{u=new URL(v)}catch{}
 if(u&&u.protocol==='https:')return{html:`<a href="${esc(u.href)}" target="_blank" rel="noreferrer">${esc(u.href)}</a>`,note:'Permanent on-chain field.',origin:u.origin};
 if(u&&u.protocol==='http:')return{html:`<span class="warn">${esc(v)}</span>`,note:'INSECURE LINK: http:// (not encrypted). Shown as text, not opened by SyncNet. Permanent on-chain field.'};
 return{html:`<span class="warn">${esc(v)}</span>`,note:'Not a valid web address. Shown exactly as stored in the token metadata.'}}
function row(label,value,note='',cls=''){return`<div class="passport-row"><span>${esc(label)}</span><div><strong class="${esc(cls)}">${value}</strong>${note?`<small>${note}</small>`:''}</div></div>`}
function fact(label,value){return value?`<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`:''}
function fmtEth(w){try{w=BigInt(w||0)}catch{return'?'}const i=w/10n**18n,f=(w%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return i+(f?'.'+f:'')}

async function renderPassport(a,launch,meta,prov,profile,mkt){
 const host=$('passportPanel');if(!host)return;
 let recipientCode='';try{recipientCode=await Chain.getCode(rpc,launch.creatorFeeRecipient)}catch{recipientCode=''}
 const pass=mkt&&mkt.passport,activeListing=mkt&&mkt.listing&&mkt.listing.status==='ACTIVE'?mkt.listing:null;
 const web=websiteView(meta&&meta.socials?meta.socials.website:'');
 const vault=VAULTS[String(launch.creatorFeeRecipient).toLowerCase()];
 let feeType='Unknown',transfer='Unknown',tcls='warn';
 if(vault){feeType={holders:'PAR holder vault · fees to holders',burn:'PAR burn vault · buyback & burn',floor:'PAR floor vault · price floor'}[vault];transfer='No — fixed to a PAR vault';tcls='bad'}
 else if(recipientCode==='0x'){feeType='Wallet (externally owned account)';transfer='Yes — this wallet can transfer the right on-chain';tcls='ok'}
 else if(String(recipientCode).toLowerCase().startsWith('0xef0100')){feeType='Wallet with delegated code (EIP-7702)';transfer='Yes — this wallet can transfer the right on-chain';tcls='ok'}
 else if(recipientCode){feeType='Contract (multisig, X/GitHub creator account or other)';transfer='Depends on that contract';tcls='warn'}
 const op=pass?`<span class="mono">${esc(pass.operator)}</span>`:prov&&prov.status===Prov.STATUS.OPERATOR&&prov.operator?`<span class="mono">${esc(prov.operator.operator)}</span>`:'Not recorded yet';
 const opNote=pass?'SYNCNET OPERATOR VERIFIED · signed operator record on the SyncNet Marketplace (signatures verified server-side, since '+esc(String(pass.operatorSince).slice(0,10))+'). It proves control of that wallet, not project quality.':prov&&prov.status===Prov.STATUS.OPERATOR?esc(prov.detail):(profile&&valid(profile.operator)?'SyncNet has a curated note naming '+esc(short(profile.operator))+', but no signed operator claim — not shown as verified.':'No signed operator claim. The deployer is not automatically the operator.');
 const histRows=(pass&&pass.history?pass.history.slice(-6).reverse():[]).map(h=>`<li><span class="mono">${esc(String(h.at).replace('T',' ').slice(0,16))}</span> ${esc(String(h.type).replace(/-/g,' '))}${h.from?` · ${esc(short(h.from))} → ${esc(short(h.to))}`:h.operator?` · ${esc(short(h.operator))}`:''}</li>`).join('');
 host.innerHTML=`<h4>Project Passport</h4><p>Who runs this project, who receives its creator fees, and what can change. Read from the PAR factory on-chain unless marked otherwise.</p><div class="passport-rows">
 ${row('Token contract','Ownerless · immutable metadata','PAR launch tokens have no owner and no function that changes their name, ticker, image, description or links (PAR’s published source). Launch liquidity is held by PAR’s launch locker, which has no withdrawal function in PAR’s published source.','ok')}
 ${row('Deployer',`<a class="mono" href="https://robinhoodchain.blockscout.com/address/${esc(launch.deployer)}" target="_blank" rel="noreferrer">${esc(launch.deployer)}</a>`,'The wallet that launched the token (PAR factory record).')}
 ${row('Recognised operator',op,opNote,prov&&prov.status===Prov.STATUS.OPERATOR?'ok':'warn')}
 ${row('Creator-fee beneficiary',`<span class="mono">${esc(launch.creatorFeeRecipient)}</span>`,esc(feeType)+'. The fee beneficiary is not necessarily the operator.')}
 ${row('Fee right can follow a new operator',esc(transfer),tcls==='warn'?'X/GitHub creator accounts move only through their linked wallet, and cover every token launched for that account — not one project.':vault?'Normal operators cannot move it; PAR’s Community Takeover process can.':'',tcls)}
 ${row('Trading fee',`${(launch.baseFeeBps+launch.creatorTaxBps)/100}% per trade`,`${launch.baseFeeBps/100}% PAR base + ${launch.creatorTaxBps/100}% creator tax · pool fee ${launch.poolFee} (hundredths of a bip) · ${launch.marketCount} market${launch.marketCount===1?'':'s'} · read from the factory record`)}
 ${row('What can still change','Only the creator-fee recipient','By its current wallet, or by PAR’s Community Takeover after review and a 3-day public notice. Token, pool, supply and tax do not change.')}
 ${row('Website in token metadata',web.html,web.note)}
 ${row('Website link status','<span id="siteStatus">Not checked</span>','<span id="siteNote">SyncNet shows WEBSITE LINKED only when the token points to the site and the site’s /syncnet.json points back to this token.</span>')}
 ${row('Operator history',histRows?`<ul class="record-history">${histRows}</ul>`:'Not recorded yet',histRows?'Append-only Marketplace record: operator claims, listings and two-party transfers. Previous operators are never deleted.':'No Marketplace operator record exists for this project yet.')}
 ${row('Marketplace',activeListing?`<a href="/marketplace.html#listing=${esc(activeListing.id)}">FOR SALE · ${esc(activeListing.price)} ${esc(activeListing.currency)} →</a>`:pass&&pass.history&&pass.history.some(h=>h.type==='deal-completed')?'Not for sale · previously changed hands on the Marketplace':'Not for sale',activeListing?'A live, operator-signed listing exists on the SyncNet Marketplace.':'')}
 </div><div class="passport-actions"><label class="sr-only" for="siteUrl">Website to check</label><input class="input" id="siteUrl" placeholder="https://your-site…" value="${esc(web.origin||'')}"><button class="btn" id="checkSite" type="button">CHECK WEBSITE</button><a class="btn" href="/kit.html?token=${esc(a)}">PROJECT KIT →</a></div>`;
 const site=web.origin||'';
 async function check(){
  const url=originOf($('siteUrl').value),st=$('siteStatus'),nt=$('siteNote');
  if(!url){st.className='bad';st.textContent='Enter an https:// address';return}
  st.className='';st.textContent='Checking…';
  try{const r=await fetch('/api/site-check?url='+encodeURIComponent(url),{cache:'no-store'});const j=await r.json().catch(()=>({}));
   if(!r.ok)throw Error(j.error||'Check unavailable');
   if(!j.found){st.className='warn';st.textContent='No syncnet.json found';nt.textContent='Add the declaration file from the Project Kit to the root of the site.';return}
   const declared=j.declaration?.token,pointsBack=same(declared,a),tokenPoints=site&&originOf(j.origin)===site;
   if(pointsBack&&tokenPoints){st.className='ok';st.textContent='WEBSITE LINKED ✓';nt.textContent='Token metadata → '+j.origin+' and '+j.origin+'/syncnet.json → this token. This proves the link, not the quality or safety of the site.'}
   else if(pointsBack){st.className='warn';st.textContent='Site declares this project · unconfirmed';nt.textContent='The site points to this token, but the token metadata does not point to the site. Anyone can publish such a file; treat it as unverified.'}
   else{st.className='bad';st.textContent=declared?'Site declares a different token':'Site declares no token yet';nt.textContent=declared?'Declared: '+declared:'Regenerate syncnet.json in the Project Kit after launch.'}
  }catch(e){st.className='bad';st.textContent='Website check unavailable right now'}
 }
 $('checkSite')?.addEventListener('click',check);
 if(site)check();
}

/** L8: expected (intent) vs actual (chain) vs verified (check) for a verified SyncNet proof. */
function evidenceTable(prov,sym){
 const r=prov&&prov.proofResult;if(!r||!r.actual)return'';
 const act=r.actual,checks=r.checks||[];const ok=id=>{const c=checks.find(x=>x.id===id);return c?(c.ok?'✓ VERIFIED':'✕ MISMATCH'):'—'};
 const exp=prov.expected||{};
 const lines=[
  ['Markets',(exp.markets||[]).map(a=>sym+' / '+short(a)).join(', ')||'—',(act.markets||[]).map(m=>sym+' / '+short(m.pairToken)).join(', ')||'—',ok('factory-markets')],
  ['Creator-fee recipient at launch',short(exp.recipient)||'—',short(act.creatorFeeRecipientAtLaunch)||'—',ok('tx-fees')],
  ['Creator-fee recipient now','—',short(act.creatorFeeRecipientNow)||'—','read now'],
  ['Creator tax',exp.tax!=null?(exp.tax/100)+'%':'—',act.launch?(act.launch.creatorTaxBps/100)+'%':'—',ok('factory-tax')],
  ['PAR base fee · protocol share','—',act.launch?(act.launch.baseFeeBps/100)+'% · '+(act.launch.protocolFeeShareBps/100)+'%':'—','read from factory'],
  ['Pool fee','—',act.launch?String(act.launch.poolFee):'—','read from factory'],
  ['Launch block',r.actual.blockNumber?String(r.actual.blockNumber):'—',r.actual.launchedAt?new Date(r.actual.launchedAt*1000).toISOString().slice(0,19).replace('T',' ')+' UTC':'—','from receipt'],
 ];
 return `<div class="evidence-table"><div class="evidence-head"><span>Evidence</span><span>Expected (signed intent)</span><span>Actual (on-chain)</span><span>Status</span></div>${lines.map(l=>`<div class="evidence-row"><span>${esc(l[0])}</span><span class="mono">${esc(l[1])}</span><span class="mono">${esc(l[2])}</span><span>${esc(l[3])}</span></div>`).join('')}</div>`;
}

async function run(){
 const m=location.pathname.match(/\/(?:token|project)\/(0x[a-fA-F0-9]{40})/),a=m?.[1]?.toLowerCase();
 if(!a){$('tokenTitle').textContent='Invalid contract';$('tokenDescription').textContent='The URL does not contain a valid token contract.';announce({invalid:true});return}
 $('tokenTitle').textContent='CHECKING…';$('tokenDescription').textContent='Reading the launch record on Robinhood Chain.';
 let launch;try{launch=await Chain.readLaunch(rpc,a)}catch{launch='unavailable'}
 const isPar=Boolean(launch&&launch!=='unavailable');
 // Other supported origins (Pons V2) — read live from their canonical factory only when the token is not a PAR launch.
 let pons=null;if(!isPar&&launch!=='unavailable'&&Origins){try{pons=await Origins.resolveProject(rpc,a)}catch{pons='unavailable'}}
 const isPons=Boolean(pons&&pons!=='unavailable'&&pons.origin==='PONS_V2'),isPonsV1=Boolean(pons&&pons!=='unavailable'&&pons.origin==='PONS_V1');
 // Marketplace passport: server-verified operator provenance (signed claims + two-party transfers). Precise labels:
 // SYNCNET OPERATOR VERIFIED (server-checked signatures) is not PAR INDEXED and not a curated profile note.
 const [all,srv,idxRes,h,meta,mkt]=await Promise.all([projects(),serverEntry(a),fetch(`${API}/launches/${a}`,{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null),history(),Chain.readTokenMetadata(rpc,a).catch(()=>null),fetch('/api/marketplace?view=passport&token='+a,{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null)]);
 const marketPassport=mkt&&mkt.passport||null;
 const profile=all.find(p=>same(p.token,a))||null;
 const canonicalList=all.filter(p=>p?.registry?.canonical===true&&valid(p.token)).map(p=>({token:p.token.toLowerCase(),symbol:String(p.symbol||p.profile?.name||'').toUpperCase()}));
 const local=localRecords(a);
 const prov=await Prov.assess(rpc,{token:a,profile,serverEntry:srv,launch}).catch(()=>({status:Prov.STATUS.UNVERIFIED,detail:'Provenance could not be checked right now.',checks:[]}));
 if(prov.proofResult){try{const pr=(srv&&srv.proof)||(profile&&profile.proof);const i=JSON.parse(pr.intentJson);prov.expected={markets:(i.connections||[]).map(c=>c.address),recipient:i.creatorFeeRecipient,tax:i.creatorTaxBps}}catch{}}
 const usedBy=h.filter(x=>!same(tokenAddr(x),a)&&markets(x).some(mm=>same(pairAddr(mm),a)));
 const chainName=disp(meta&&meta.name,64),chainSym=meta&&meta.symbol?safeSymbol(meta.symbol):'';
 const canonical=prov.canonical;
 const sym=chainSym||safeSymbol(profile?.symbol||profile?.profile?.name||'TOKEN');
 const name=(isPar||isPons||canonical?(chainName||disp(profile?.profile?.name,64)):chainName)||'Unnamed contract';
 const impostor=!canonical?canonicalList.find(c=>c.token!==a&&Core.confusableSkeleton(c.symbol)===Core.confusableSkeleton(sym)&&sym!=='TOKEN'):null;
 document.title=`${name} — SyncNet`;$('tokenTitle').textContent=name;$('tokenDescription').textContent=`$${sym}`;
 const logoUri=isPar||isPons?(meta&&meta.logo||profile?.profile?.image||''):canonical?(profile?.profile?.image||''):'';
 const logoHtml=Ipfs.imgHtml(logoUri,{letter:(sym||'S').charAt(0)});
 const badges=[];
 if(isPar)badges.push('<span class="badge">PAR LAUNCH · FACTORY RECORD ON-CHAIN</span>');
 else if(launch==='unavailable')badges.push('<span class="badge registry-badge unverified">PAR STATUS UNAVAILABLE</span>');
 else if(isPons)badges.push('<span class="badge">PONS V2 LAUNCH · FACTORY RECORD ON-CHAIN</span>');
 else if(isPonsV1)badges.push(`<span class="badge">PONS V1 LAUNCH · ${pons.generation==='LEGACY'?'LEGACY ':''}FACTORY RECORD ON-CHAIN</span>`);
 else if(pons==='unavailable')badges.push('<span class="badge registry-badge unverified">LAUNCHPAD STATUS UNAVAILABLE</span>');
 else badges.push('<span class="badge registry-badge unverified">NOT VERIFIED AS A PAR LAUNCH</span>');
 if(isPar&&usedBy.length)badges.push('<span class="badge">NETWORK HUB</span>');
 if(canonical)badges.push('<span class="badge registry-badge network">CANONICAL SYNCNET ASSET · BY CONTRACT ADDRESS</span>');
 if(prov.status)badges.push(`<span class="badge registry-badge ${esc(prov.status.cls)}">${esc(prov.status.label)}</span>`);
 if(marketPassport)badges.push('<span class="badge registry-badge verified">SYNCNET OPERATOR VERIFIED</span>');
 const impostorNote=impostor?`<div class="registry-inline unverified-record"><span>NOT THE CANONICAL $${esc(impostor.symbol)}</span><strong>Same ticker, different contract</strong><small>The canonical $${esc(impostor.symbol)} is ${esc(impostor.token)}. SyncNet identifies canonical assets by contract address only.</small><a href="/project/${esc(impostor.token)}">OPEN CANONICAL →</a></div>`:'';
 const provBox=prov.status?`<div class="registry-inline"><span>SYNCNET PROVENANCE</span><strong>${esc(prov.status.label)}</strong><small>${esc(prov.detail)} This is not a quality, safety or affiliation signal.</small><a href="/registry.html">VIEW REGISTRY →</a></div>${prov.status===Prov.STATUS.BUILT?evidenceTable(prov,sym):''}`:'';
 const localBox=local.length?`<div class="registry-inline local-record"><span>THIS BROWSER ONLY · NOT PUBLIC</span><strong>${esc(local.map(r=>String(r.state).replace(/_/g,' ')).join(' · '))}</strong><small>Your browser holds ${local.length===1?'a launch record':local.length+' launch records'} for this address. Browser records are private evidence, not public Registry provenance.${local.map(r=>r.expected&&r.expected.openingBuy?` Opening buy in the launch transaction: ${esc(fmtEth(r.expected.openingBuy.ethWei))} ETH (from this browser’s launch record).`:'').join('')}</small><a href="/launches.html">MY LAUNCHES →</a></div>`:'';
 let ownMarkets='',marketContracts='';
 if(isPar){
  let mk=[];try{mk=await Chain.readMarkets(rpc,a,launch)}catch{mk=[]}
  const syms=await Promise.all(mk.map(x=>{const row=markets(idxRes).find(r=>same(pairAddr(r),x.pairToken));return row&&row.quoteSymbol?Promise.resolve(safeSymbol(row.quoteSymbol)):ercSymbol(x.pairToken)}));
  ownMarkets=`<div class="eyebrow" style="margin-top:28px">Direct markets · read from the PAR factory</div><div class="chip-row">${mk.map((x,i)=>`<span class="chip">${esc(sym)} / ${esc(syms[i])}</span>`).join('')||'<span class="chip">markets not readable right now</span>'}</div>`;
  marketContracts=mk.length?`<div class="economic-card"><strong>Market contracts</strong><p>${mk.map((x,i)=>`${esc(syms[i])}: <span class="mono">${esc(x.pairToken)}</span>`).join('<br>')}</p></div>`:'';
 }else if(isPons){
  // Pons V2 project: verified origin facts + SyncNet Passport/Marketplace state. No PAR analytics are shown for Pons.
  let pair=null;try{pair=await Origins.pairInfo(rpc,pons.pair.address)}catch{pair=null}
  const fr=await Origins.classifyFeeRight(rpc,pons).catch(()=>null);
  const pass=mkt&&mkt.passport,lst=mkt&&mkt.listing||null;
  const row=(l,v)=>`<div class="passport-row"><span>${esc(l)}</span><div><strong>${v}</strong></div></div>`;
  const pairText=pair?(pair.native?'ETH':pair.symbol||short(pair.address)):short(pons.pair.address);
  const frText=fr?(fr.kind==='wallet'?' · wallet':fr.kind==='encumbered'?' · wallet · Pons protocol override pending':' · contract'):'';
  ownMarkets=`<div class="eyebrow" style="margin-top:28px">Origin · read from the Pons V2 factory</div><div class="passport-rows">${row('Origin','PONS V2 · ON-CHAIN VERIFIED')}${row('Token contract',`<span class="mono">${esc(a)}</span>`)}${row('Pair asset',esc(pairText))}${row('Status',esc(pons.state.label))}${row('Creator tax',esc((pons.creatorTaxBps/100)+'%'))}${row('Deployer',`<span class="mono">${esc(pons.deployer)}</span>`)}${row('Creator-fee recipient',`<span class="mono">${esc(pons.creatorFeeRecipient)}</span>${esc(frText)}`)}${row('Project Passport',pass?`SYNCNET OPERATOR <span class="mono">${esc(pass.operator)}</span>`:'Not claimed yet')}${row('Marketplace',lst?`<a href="/marketplace.html#listing=${esc(lst.id)}">${lst.status==='ACTIVE'?'FOR SALE · '+esc(lst.price)+' '+esc(lst.currency):'LISTING · '+esc(String(lst.status||'').replace(/_/g,' '))} →</a>`:'Not listed')}</div><p class="coverage-note">A Project Passport is SyncNet-recognised operational control, not ownership of the token contract. No partnership with or endorsement by Pons is implied.</p>`;
 }else if(isPonsV1){
  ownMarkets=`<p class="example-copy">An earlier-generation Pons launch: its record is on the ${pons.generation==='LEGACY'?'legacy ':''}Pons V1 factory. SyncNet recognises it but does not support this launch generation, so it cannot hold a Project Passport or be listed in the Marketplace. No ownership, fee or security claims are made about it.</p>`;
 }else{
  ownMarkets=`<p class="example-copy">${launch==='unavailable'?'Robinhood Chain could not be read right now, so SyncNet cannot say whether this contract is a PAR launch. No launch, ownership, fee or security claims are made.':'SyncNet could not verify this contract as a PAR launch. No ownership, fee, market or security claims are made about it.'}${usedBy.length?` The PAR indexer lists ${usedBy.length} PAR launch${usedBy.length===1?'':'es'} that use this contract as a market.`:''}</p>`;
 }
 const children=usedBy.slice(0,12).map(x=>{const cs=safeSymbol(x.symbol||x.tokenSymbol),imp=canonicalList.some(c=>c.token!==String(tokenAddr(x)).toLowerCase()&&Core.confusableSkeleton(c.symbol)===Core.confusableSkeleton(cs));return`<a class="chip${imp?' impostor-chip':''}" href="/project/${esc(tokenAddr(x))}">$${esc(cs)}${imp?' (not canonical)':''} · ${esc(short(tokenAddr(x)))}</a>`}).join('');
 const facts=isPar?`<div class="registry-facts">${fact('Deployer',short(launch.deployer))}${fact('Fee mode',VAULTS[String(launch.creatorFeeRecipient).toLowerCase()]||'creator wallet')}${fact('Launched (indexer)',idxRes?.createdAt?String(idxRes.createdAt).replace('T',' ').slice(0,16)+(/^\d{4}-/.test(String(idxRes.createdAt))?' UTC':''):'')}${fact('Projects using this token as a market',String(usedBy.length))}</div>`:(isPons||isPonsV1)?'':`<div class="registry-facts">${fact('Projects using this contract as a market (indexer)',String(usedBy.length))}</div>`; // Pons pages show no PAR-indexer-derived counts
 let desc='';
 if(isPar&&meta&&meta.description){const full=Core.sanitizeForDisplay(meta.description,{maxLength:2048,multiline:true});const head=Array.from(full).slice(0,420).join('');desc=full.length>head.length?`<div class="example-copy token-description"><strong>Description:</strong> <span>${esc(head)}…</span><details><summary>Show the full description</summary><p>${esc(full)}</p></details></div>`:`<p class="example-copy token-description"><strong>Description:</strong> ${esc(full)}</p>`}
 $('tokenCard').innerHTML=`<div class="example-top"><div class="example-project">${logoHtml}<div><h3>${esc(name)}</h3><p class="mono">${esc(a)}</p></div></div><div class="badge-stack">${badges.join('')}</div></div>${impostorNote}${provBox}${localBox}${facts}${desc}${ownMarkets}${usedBy.length&&!isPons&&!isPonsV1?`<div class="eyebrow" style="margin-top:28px">${isPar?'Projects using this token as a market':'PAR launches using this contract as a market (indexer)'}</div><div class="chip-row">${children}</div>${usedBy.length>12?`<p class="coverage-note">Showing 12 of ${usedBy.length}. Open Map for the network view.</p>`:''}`:''}${isPar?'<div class="passport-panel" id="passportPanel" aria-live="polite"><div class="network-empty">Reading Passport data from PAR…</div></div>':''}${marketContracts}`;
 if(isPar)renderPassport(a,launch,meta,prov,profile,mkt).catch(()=>{const h=$('passportPanel');if(h)h.innerHTML='<div class="network-empty">Passport data is temporarily unavailable.</div>'});
 // The Project Page rows (project-page.js) are built from the SAME facts this page just verified — never re-derived.
 const origin=isPar?'PAR':isPons?'PONS_V2':isPonsV1?'PONS_V1':(launch==='unavailable'||pons==='unavailable')?'UNAVAILABLE':'UNVERIFIED';
 const src=isPar?launch:isPons?pons:null;
 announce({token:a,name,symbol:sym,logoUri,origin,originLabel:{PAR:'PAR launch',PONS_V2:'Pons V2 launch',PONS_V1:'Pons V1 launch',UNAVAILABLE:'Origin unavailable',UNVERIFIED:'Not a verified launch'}[origin],
  claimable:Boolean(src),deployer:src?String(src.deployer||'').toLowerCase():'',feeRecipient:src?String(src.creatorFeeRecipient||'').toLowerCase():'',
  passport:marketPassport,listing:mkt&&mkt.listing||null,registryOperator:prov&&prov.status===Prov.STATUS.OPERATOR&&prov.operator?String(prov.operator.operator||'').toLowerCase():'',
  canonical:Boolean(canonical),usedBy:usedBy.length,directMarkets:isPar?Number(launch.marketCount||0):isPons?1:0,tradeUrl:isPar?'https://par.family/token/'+a:''});
}
function announce(detail){window.__snProject=detail;window.dispatchEvent(new CustomEvent('syncnet:project',{detail}))}
run().catch(()=>{announce({unavailable:true});$('tokenTitle').textContent='Project data unavailable';$('tokenDescription').textContent='The chain or the indexer did not answer.';$('tokenCard').innerHTML='<div class="network-empty">The chain/indexer did not return enough data for this contract right now. No provenance or relationship has been inferred.</div>'});
})();
