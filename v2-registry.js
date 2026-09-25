(function(){
'use strict';
/*
 * SyncNet Registry page. Public entries come from syncnet-projects.json (curated) and /api/registry (chain-verified
 * submissions). Every status is decided by lib/syncnet-provenance.js from evidence checked live; nothing says
 * "VERIFIED" without saying what was verified. Browser-local launch records are listed in their own section and are
 * never counted or styled as public provenance.
 */
const Core=window.SyncNetCore,Chain=window.SyncNetChain,Prov=window.SyncNetProvenance,Records=window.SyncNetRecords;
const API='https://api.par.family';
const rpc=Chain.makeRpc(Chain.ROBINHOOD.rpcUrl,{timeoutMs:10000,retries:1});
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const valid=a=>/^0x[a-fA-F0-9]{40}$/.test(String(a||''));
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
const disp=(v,n=64)=>Core.sanitizeForDisplay(String(v??''),{maxLength:n});
const short=a=>valid(a)?a.slice(0,6)+'…'+a.slice(-4):String(a||'');
function rows(d){return Array.isArray(d?.markets)&&d.markets.length?d.markets:(d?[d]:[])}
function pairSym(m){return disp(m?.quoteSymbol||m?.pairSymbol||m?.pairTokenSymbol||'TOKEN',16).toUpperCase()}
const Ipfs=window.SyncNetIpfs; // canonical IPFS renderer (gateway fallback + placeholder); stored URIs stay ipfs://
async function indexRow(token){try{const r=await fetch(`${API}/launches/${token}`,{cache:'no-store'});return r.ok?await r.json():null}catch{return null}}
async function serverEntries(){try{const r=await fetch('/api/registry',{cache:'no-store'});if(!r.ok)return[];const j=await r.json();return Array.isArray(j.entries)?j.entries.filter(e=>valid(e.token)):[]}catch{return[]}}
function downloadJson(text,name){const blob=new Blob([text],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
async function assessEntry(e){
 let launch;try{launch=await Chain.readLaunch(rpc,e.token)}catch{launch='unavailable'}
 const [idx,prov]=await Promise.all([indexRow(e.token),Prov.assess(rpc,{token:e.token,profile:e.profile,serverEntry:e.server,launch}).catch(()=>({status:Prov.STATUS.UNVERIFIED,detail:'Could not be checked right now.',checks:[]}))]);
 return{...e,launch,idx,prov};
}
function verifiedLines(p){
 const r=p.prov&&p.prov.proofResult;if(!r||p.prov.status!==Prov.STATUS.BUILT)return'';
 const pick=id=>r.checks.find(c=>c.id===id);const mark=c=>c?(c.ok?'✓':'✕'):'—';
 const items=[['signature','Deployer signature over the intent'],['tx-salt','Launch transaction carried the committed salt'],['tx-launched','That transaction deployed this token'],['tx-markets','Markets in the transaction = intent'],['factory-markets','Markets on the factory record = intent'],['tx-fees','Fee recipient and tax in the transaction = intent']];
 return `<div class="registry-verified-lines">${items.map(([id,l])=>`<span>${mark(pick(id))} ${esc(l)}</span>`).join('')}${r.actual&&r.actual.blockNumber?`<span>Launch block ${esc(r.actual.blockNumber)}</span>`:''}</div>`;
}
function card(p){
 const d=p.idx||{},isPar=Boolean(p.launch&&p.launch!=='unavailable');
 const sym=disp(p.symbol||d.symbol||p.profile?.symbol||p.profile?.name||'TOKEN',16).toUpperCase();
 const name=disp(p.profile?.profile?.name||p.name||d.name||sym,64);
 const logoHtml=Ipfs.imgHtml(p.profile?.profile?.image||d.logoUrl||d.logo,{letter:(sym||'S').charAt(0)});
 const ms=isPar?rows(d):[],reg=p.profile?.registry||{};
 const st=p.prov.status||Prov.STATUS.PROFILE;
 const links=[];
 if(p.profile?.links?.x&&/^https:\/\//.test(p.profile.links.x))links.push(`<a class="btn" href="${esc(p.profile.links.x)}" target="_blank" rel="noreferrer">X ↗</a>`);
 const tx=p.server?.txHash||p.profile?.proof?.txHash;if(tx&&/^0x[0-9a-fA-F]{64}$/.test(tx))links.push(`<a class="btn" href="https://robinhoodchain.blockscout.com/tx/${esc(tx)}" target="_blank" rel="noreferrer">LAUNCH TX ↗</a>`);
 const parLine=isPar?'PAR launch · factory record read on-chain':p.launch==='unavailable'?'PAR status could not be read right now':'NOT VERIFIED AS A PAR LAUNCH';
 return `<article class="registry-card" data-search="${esc((name+' '+sym+' '+p.token).toLowerCase())}" data-token="${esc(p.token)}"><div class="registry-card-head"><div class="registry-identity"><div class="registry-logo">${logoHtml||'S'}</div><div><div class="registry-status ${esc(st.cls)}">${esc(st.label)}${reg.id&&st===Prov.STATUS.ORIGIN?' · '+esc(String(reg.id).replace('SYNCNET-','#')):''}</div>${p.prov.canonical?'<div class="registry-status network">CANONICAL · BY CONTRACT ADDRESS</div>':''}<h3>${esc(name)}</h3><p class="mono">${esc(p.token)}</p></div></div></div><div class="registry-facts"><div><span>Provenance</span><strong>${esc(st.label)}</strong></div><div><span>PAR status</span><strong>${esc(parLine)}</strong></div></div><p class="registry-note">${esc(p.prov.detail||st.what)}</p>${verifiedLines(p)}${ms.length?`<div class="market-preview"><div class="market-preview-title">Markets (PAR indexer)</div><div class="market-list">${ms.map(m=>`<span class="market-pill">${esc(sym)} / ${esc(pairSym(m))}</span>`).join('')}</div></div>`:''}${reg.note?`<p class="registry-note">${esc(disp(reg.note,400))}</p>`:''}<div class="network-actions"><a class="btn primary" href="/network.html?token=${esc(p.token)}">MAP</a><a class="btn" href="/project/${esc(p.token)}">PROJECT PAGE</a>${links.join('')}</div></article>`;
}
function localCard(r){
 const proof=Records.toProof(r);
 return `<article class="registry-card local-record" data-search="${esc((String(r.name||'')+' '+String(r.symbol||'')+' '+r.predicted).toLowerCase())}"><div class="registry-card-head"><div class="registry-identity"><div class="registry-logo">S</div><div><div class="registry-status local">THIS BROWSER ONLY · NOT PUBLIC</div><h3>${esc(disp(r.name||r.symbol||'Launch record',64))}</h3><p class="mono">${esc(r.predicted)}</p></div></div></div><div class="registry-facts"><div><span>Launch record state</span><strong>${esc(String(r.state).replace(/_/g,' '))}</strong></div><div><span>Transaction</span><strong class="mono">${esc(r.txHash?short(r.txHash):'no hash recorded')}</strong></div></div><p class="registry-note">Private evidence stored in this browser. It is not a public Registry entry and carries no public badge. ${proof?'It can be exported as a verifiable proof (syncnet.launch.proof.v2).':'It has no complete proof yet (needs the transaction hash, the intent record and the signature).'}</p><div class="network-actions"><a class="btn" href="/launches.html">MY LAUNCHES →</a>${proof?`<button class="btn" type="button" data-export-local="${esc(r.id)}">EXPORT PROOF JSON</button>`:''}</div></article>`;
}
function filter(){const q=($('registrySearch')?.value||'').trim().toLowerCase();for(const el of document.querySelectorAll('.registry-card'))el.hidden=Boolean(q&&!el.dataset.search.includes(q));}
async function run(){
 try{
  const r=await fetch('/syncnet-projects.json',{cache:'no-store'});if(!r.ok)throw Error('Registry data unavailable');const j=await r.json();
  const seen=new Set();const entries=[];
  for(const p of j.projects||[]){if(!valid(p.token)||!p.registry)continue;const k=p.token.toLowerCase();if(seen.has(k))continue;seen.add(k);entries.push({token:k,profile:p,symbol:p.symbol,name:p.name})}
  for(const e of await serverEntries()){const k=e.token.toLowerCase();const ex=entries.find(x=>x.token===k);if(ex)ex.server=e;else{seen.add(k);entries.push({token:k,server:e,symbol:e.symbol,name:e.name})}}
  $('registryGrid').innerHTML='<div class="network-empty">Checking every entry against Robinhood Chain…</div>';
  const pub=await Promise.all(entries.map(assessEntry));
  $('registryCount').textContent=String(pub.length);
  if($('registryVerifiedCount'))$('registryVerifiedCount').textContent=String(pub.filter(p=>p.prov.status===Prov.STATUS.BUILT).length);
  $('registryGrid').innerHTML=pub.length?pub.map(card).join(''):'<div class="network-empty">No public registry records yet.</div>';
  let local=[];try{local=Records.createStore('syncnet_').all().filter(x=>Records.POST_BROADCAST.has(x.state))}catch{}
  if($('localRegistrySection'))$('localRegistrySection').hidden=!local.length;
  if($('localRegistryGrid'))$('localRegistryGrid').innerHTML=local.map(localCard).join('');
  document.querySelectorAll('[data-export-local]').forEach(b=>b.addEventListener('click',()=>{const rec=local.find(x=>x.id===b.dataset.exportLocal);const proof=rec&&Records.toProof(rec);if(proof)downloadJson(JSON.stringify(proof,null,2),'syncnet-launch-proof-'+String(rec.symbol||'token').toLowerCase()+'.json')}));
  filter();
 }catch(e){$('registryCount').textContent='—';$('registryGrid').innerHTML='<div class="network-empty">The Registry could not be loaded right now.</div>'}
}
$('registrySearch')?.addEventListener('input',filter);$('clearRegistry')?.addEventListener('click',()=>{$('registrySearch').value='';filter();$('registrySearch').focus()});run();
})();
