(function(){
'use strict';
/*
 * MY LAUNCHES / RECOVER LAUNCH. Read-only: lists the launch records of this browser (launch-records.js), resolves
 * them from the chain (RE-VERIFY), recovers a launch from a transaction hash, a token address or a wallet, imports and
 * exports evidence, and (when the server-side gate allows it) submits a verified proof to the public Registry.
 * Records are never deleted. "Mark as not sent" is guarded and keeps the record and its history.
 */
const Core=window.SyncNetCore,Chain=window.SyncNetChain,Records=window.SyncNetRecords;
const API='https://api.par.family';
const rpc=Chain.makeRpc(Chain.ROBINHOOD.rpcUrl,{timeoutMs:12000,retries:1});
const records=Records.createStore('syncnet_');
try{records.migrateLegacy()}catch{}
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const disp=(v,n=64)=>Core.sanitizeForDisplay(String(v??''),{maxLength:n});
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
const isAddr=a=>/^0x[0-9a-fA-F]{40}$/.test(String(a||''));
const isHash=h=>/^0x[0-9a-fA-F]{64}$/.test(String(h||''));
const short=a=>String(a||'').slice(0,10)+'…'+String(a||'').slice(-6);
const explorerTx=h=>'https://robinhoodchain.blockscout.com/tx/'+h;
let serverConfig={registrySubmissions:false};
function toast(t){const el=$('toast');if(!el)return;el.textContent=t;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)}
function download(text,name){const blob=new Blob([text],{type:'application/json'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
async function fetchIndexer(token){try{const r=await fetch(API+'/launches/'+token,{cache:'no-store'});return r.ok?await r.json():null}catch{return null}}
function stateClass(s){return Records.UNRESOLVED.has(s)?'bad':Records.DEPLOYED.has(s)?(s==='FULLY_VERIFIED'||s==='ONCHAIN_VERIFIED'||s==='INDEXER_PENDING'?'ok':'warn'):s==='FAILED_POST_BROADCAST'?'warn':''}
const STATE_HELP={
 PREPARED:'Simulated only. Nothing was sent.',SIGNATURE_VALID:'Intent signed. Nothing was sent.',
 BROADCAST_ATTEMPTED:'The wallet was asked to send. Until the chain says otherwise, treat this launch as SENT.',
 BROADCAST_UNKNOWN:'The wallet returned an error or no hash. The launch may or may not have been broadcast. Check your wallet activity, then RE-VERIFY.',
 TX_HASH_RECEIVED:'The wallet returned a transaction hash. Waiting for the chain to confirm it.',
 MINED:'The token exists on-chain. Verification needs attention or has not completed.',
 ONCHAIN_VERIFIED:'Verified against the PAR factory on-chain.',INDEXER_PENDING:'Verified on-chain; the PAR indexer has not listed it yet. On-chain state is authoritative.',
 FULLY_VERIFIED:'Verified on-chain and listed by the PAR indexer.',FAILED_PRE_BROADCAST:'Not sent (rejected in the wallet or marked as not sent after checks).',
 FAILED_POST_BROADCAST:'Mined but reverted. No token was created.'};
function recordRow(r){
 const proof=Records.toProof(r);const deployed=Records.DEPLOYED.has(r.state);
 const canMarkNotSent=r.state==='BROADCAST_UNKNOWN'||r.state==='BROADCAST_ATTEMPTED'||r.state==='TX_HASH_RECEIVED';
 const hist=(r.history||[]).slice(-12).map(h=>`<li><span class="mono">${esc(String(h.at||'').replace('T',' ').slice(0,19))}</span> ${esc(String(h.state||'').replace(/_/g,' '))}${h.note?' — '+esc(disp(h.note,200)):''}</li>`).join('');
 const reg=r.registry?`<small>Registry: ${esc(r.registry.status)}</small>`:'';
 const v=r.verification&&r.verification.onchain;
 const fails=v&&v.checks?v.checks.filter(c=>c.hard&&!c.ok).map(c=>c.label):[];
 return `<div class="record-card" data-id="${esc(r.id)}"><div class="record-row"><span class="record-state ${stateClass(r.state)}">${esc(String(r.state).replace(/_/g,' '))}</span><strong>$${esc(disp(r.symbol||'?',16))}</strong><span class="mono">${esc(r.predicted||'')}</span>${r.txHash?`<a class="mono" href="${esc(explorerTx(r.txHash))}" target="_blank" rel="noreferrer">tx ${esc(short(r.txHash))}</a>`:'<span class="mono">no tx hash</span>'}<button class="btn small" type="button" data-act="reverify">RE-VERIFY</button><button class="btn small" type="button" data-act="export">EXPORT</button></div>
 <p class="field-help">${esc(STATE_HELP[r.state]||'')}${r.imported?' Imported from a file.':''}${r.legacy?' Migrated from an earlier SyncNet version.':''}${fails.length?' Mismatch in: '+esc(fails.join(', '))+'.':''}${r.lastCheck&&r.lastCheck.latestNonce!=null?' Wallet nonce at last check: '+esc(r.lastCheck.latestNonce)+(r.nonceAtSend!=null?' (launch nonce '+esc(r.nonceAtSend)+').':'.'):''}</p>
 ${reg}<div class="records-actions">${deployed?`<a class="btn small" href="/project/${esc(r.predicted)}">PROJECT PAGE</a>`:''}${proof?`<button class="btn small" type="button" data-act="proof">EXPORT PROOF</button>`:''}${proof&&deployed&&serverConfig.registrySubmissions&&!r.rehearsal?`<button class="btn small" type="button" data-act="publish">PUBLISH TO REGISTRY</button>`:''}${canMarkNotSent?`<button class="btn small" type="button" data-act="notsent">MARK AS NOT SENT…</button>`:''}</div>
 <details class="record-details"><summary>Evidence and history</summary><dl class="final-grid"><div><dt>Deployer</dt><dd class="mono">${esc(r.deployer||'')}</dd></div><div><dt>Predicted token</dt><dd class="mono">${esc(r.predicted||'')}</dd></div><div><dt>Intent recordHash</dt><dd class="mono">${esc(r.recordHash||'—')}</dd></div><div><dt>PAR salt</dt><dd class="mono">${esc(r.salt||'—')}</dd></div><div><dt>Transaction to</dt><dd class="mono">${esc(r.tx&&r.tx.to||'—')}</dd></div><div><dt>Value (wei)</dt><dd class="mono">${esc(r.tx&&r.tx.value||'—')}</dd></div><div><dt>Signature</dt><dd>${r.signature?esc(r.signature.scheme+' by '+r.signature.signer):'none'}</dd></div><div><dt>Recorded</dt><dd>${esc(String(r.createdAt||'').replace('T',' ').slice(0,19))} UTC</dd></div></dl><ul class="record-history">${hist}</ul></details>
 <div class="notsent-box" hidden><p class="field-help warn">Only continue if your wallet shows NO sent or pending launch transaction for this attempt. SyncNet re-checks the chain first; the record and its history are kept, and the predicted address stays under watch at your next launch.</p><label class="confirm-label">Type <strong>NOT SENT ${esc(disp(r.symbol||'',16))}</strong></label><div class="live-confirm-row"><input class="input mono" data-notsent-input autocomplete="off"><button class="btn danger-btn" type="button" data-act="notsent-confirm">MARK AS NOT SENT</button></div></div></div>`;
}
function render(){
 const all=records.all();
 const post=all.filter(r=>Records.POST_BROADCAST.has(r.state)||r.state==='FAILED_PRE_BROADCAST');
 const pre=all.filter(r=>!post.includes(r));
 const open=post.filter(r=>Records.UNRESOLVED.has(r.state));
 const up=$('unresolvedPanel');
 if(up){up.hidden=!open.length;up.innerHTML=open.length?`<div class="records-head"><h4>${open.length} UNRESOLVED LAUNCH${open.length===1?'':'ES'} — DO NOT LAUNCH AGAIN YET</h4></div><p class="field-help warn">SyncNet treats these as SENT until the chain says otherwise. RE-VERIFY reads the chain now.</p>`:''}
 const host=$('recordsPanel');
 host.innerHTML=`<div class="records-head"><h4>LAUNCH RECORDS IN THIS BROWSER · ${post.length}</h4><button class="btn small" type="button" id="reverifyAll">RE-VERIFY ALL</button></div>${post.length?`<div class="records-list">${[...open,...post.filter(r=>!open.includes(r))].map(recordRow).join('')}</div>`:'<p class="field-help">No launch has been sent from this browser. If you launched from another browser or device, use RECOVER A LAUNCH or import its exported records.</p>'}${pre.length?`<details class="record-details"><summary>${pre.length} simulated or signed launch${pre.length===1?'':'es'} that never reached the wallet</summary><div class="records-list">${pre.map(recordRow).join('')}</div></details>`:''}`;
 host.querySelectorAll('.record-card').forEach(card=>{
  const id=card.dataset.id;
  card.querySelectorAll('[data-act]').forEach(b=>b.addEventListener('click',()=>act(b.dataset.act,id,card,b)));
 });
 $('reverifyAll')?.addEventListener('click',reverifyAll);
}
async function reverify(id,quiet){
 const rec=records.get(id);if(!rec)return null;
 try{const res=await Records.reverify(rec,{store:records,rpc,fetchIndexer});if(!quiet)toast(String(res.record.state).replace(/_/g,' ')+(res.notes[0]?' · '+res.notes[0]:''));return res}
 catch(e){if(!quiet)toast('The chain could not be read right now. Nothing changed; try again.');return null}
}
async function reverifyAll(){const b=$('reverifyAll');if(b){b.disabled=true;b.textContent='CHECKING…'}for(const r of records.all().filter(x=>Records.POST_BROADCAST.has(x.state)))await reverify(r.id,true);render();toast('Re-verified from the chain')}
async function act(kind,id,card,btn){
 const r=records.get(id);if(!r)return;
 if(kind==='reverify'){btn.disabled=true;btn.textContent='CHECKING…';await reverify(id);render();return}
 if(kind==='export'){download(records.exportJson([id]),'syncnet-launch-record-'+String(r.symbol||'token').toLowerCase()+'.json');return}
 if(kind==='proof'){const p=Records.toProof(r);if(p)download(JSON.stringify(p,null,2),'syncnet-launch-proof-'+String(r.symbol||'token').toLowerCase()+'.json');return}
 if(kind==='publish'){
  const p=Records.toProof(r);if(!p)return;btn.disabled=true;btn.textContent='VERIFYING ON-CHAIN…';
  try{const s=await fetch('/api/registry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proof:p})});const j=await s.json().catch(()=>({}));
   if(s.ok&&j.status==='VERIFIED'){records.update(id,{registry:{status:'VERIFIED · PUBLISHED',at:new Date().toISOString()}},{note:'published to the SyncNet Registry after server-side on-chain verification'});toast('Published to the Registry ✓')}
   else toast(j.status==='UNVERIFIED'?'Not published: '+(j.failed||[]).slice(0,2).join('; '):(j.error||'Not published right now.'))}
  catch{toast('Registry not reachable right now.')}
  render();return}
 if(kind==='notsent'){const box=card.querySelector('.notsent-box');if(box)box.hidden=!box.hidden;return}
 if(kind==='notsent-confirm'){
  const typed=Core.normalizeText(card.querySelector('[data-notsent-input]')?.value||'').toUpperCase();
  if(typed!=='NOT SENT '+String(r.symbol||'').toUpperCase()){toast('Type NOT SENT '+String(r.symbol||'').toUpperCase());return}
  btn.disabled=true;btn.textContent='CHECKING THE CHAIN…';
  try{
   const launch=await Chain.readLaunch(rpc,r.predicted);
   if(launch){records.update(id,{},{state:'MINED',note:'predicted token exists on-chain — the launch happened'});await reverify(id,true);toast('The token EXISTS on-chain — this launch happened. Record updated.');render();return}
   if(r.txHash){const t=await Chain.findLaunchByTx(rpc,r.txHash);if(t.status==='pending'){toast('The transaction is still pending on-chain. It was sent.');btn.disabled=false;btn.textContent='MARK AS NOT SENT';return}if(t.status==='success'){toast('The transaction succeeded on-chain. RE-VERIFY instead.');btn.disabled=false;btn.textContent='MARK AS NOT SENT';return}}
   records.update(id,{notSentConfirmedAt:new Date().toISOString()},{state:'FAILED_PRE_BROADCAST',note:'marked as not sent by the user after an on-chain check (no token at the predicted address'+(r.txHash?', transaction not mined':'')+'); the predicted address is re-checked at every future launch of this ticker'});
   toast('Marked as not sent. The record is kept.');render();
  }catch{toast('The chain could not be read. Nothing changed.');btn.disabled=false;btn.textContent='MARK AS NOT SENT'}
  return}
}
// ---- RECOVER A LAUNCH
function resultRow(html){const d=document.createElement('div');d.className='record-card';d.innerHTML=html;return d}
async function recover(){
 const v=String($('recoverInput').value||'').trim();const st=$('recoverStatus'),out=$('recoverResults');out.innerHTML='';
 const msg=(t,c='')=>{st.className='asset-status'+(c?' '+c:'');st.textContent=t};
 if(isHash(v)){
  msg('Reading the transaction on-chain…');
  let t;try{t=await Chain.findLaunchByTx(rpc,v)}catch{msg('The chain could not be read right now.','fail');return}
  if(t.status==='unknown'){msg('The RPC does not know this transaction. If you just sent it, wait a minute and try again.','fail');return}
  if(t.status==='pending'){msg('The transaction is pending (not mined yet). Do not launch again.','fail');return}
  if(t.status==='reverted'){msg('The transaction was mined but REVERTED. No token was created by it.','fail');const rec=records.all().find(r=>same(r.txHash,v));if(rec)await reverify(rec.id,true);render();return}
  if(!t.launched){msg('This transaction did not launch a PAR token.','fail');return}
  await showToken(t.launched.token,v,t);return}
 if(isAddr(v)){
  msg('Checking whether this is a PAR token…');
  let launch=null;try{launch=await Chain.readLaunch(rpc,v)}catch{msg('The chain could not be read right now.','fail');return}
  if(launch){await showToken(v.toLowerCase(),'',null,launch);return}
  msg('Not a PAR token. Looking for PAR launches deployed by this wallet (PAR indexer, then checked on-chain)…');
  let rows=null;try{const r=await fetch(API+'/launches?deployer='+v.toLowerCase()+'&limit=100',{cache:'no-store'});if(r.ok){const j=await r.json();rows=Array.isArray(j)?j:(j.launches||[])}}catch{}
  const local=records.all().filter(r=>same(r.deployer,v));
  if(!rows&&!local.length){msg('The PAR indexer is not reachable and this browser has no records for that wallet. Try the transaction hash from your wallet’s activity instead.','fail');return}
  const tokens=[...new Set([...(rows||[]).map(x=>String(x.token||'').toLowerCase()),...local.map(r=>String(r.predicted).toLowerCase())].filter(isAddr))].slice(0,40);
  msg(tokens.length?`${tokens.length} candidate launch${tokens.length===1?'':'es'} for this wallet. Each is checked on-chain:`:'No PAR launches found for this wallet.',tokens.length?'pass':'');
  for(const tok of tokens){let l=null;try{l=await Chain.readLaunch(rpc,tok)}catch{}const rec=records.all().find(r=>same(r.predicted,tok));const row=(rows||[]).find(x=>same(x.token,tok));
   out.appendChild(resultRow(`<div class="record-row"><span class="record-state ${l?'ok':'bad'}">${l?'ON-CHAIN ✓':'NOT FOUND ON-CHAIN'}</span><strong>$${esc(disp(row&&row.symbol||rec&&rec.symbol||'?',16))}</strong><span class="mono">${esc(tok)}</span><span>${rec?'record: '+esc(String(rec.state).replace(/_/g,' ')):'no record in this browser'}</span>${l?`<a class="btn small" href="/project/${esc(tok)}">PROJECT PAGE</a>`:''}</div>`))}
  return}
 msg('Paste a 0x… transaction hash (66 characters) or a 0x… address (42 characters).','fail');
}
async function showToken(token,txHash,t,launch){
 const st=$('recoverStatus'),out=$('recoverResults');
 if(launch===undefined){try{launch=await Chain.readLaunch(rpc,token)}catch{launch=null}}
 const rec=records.all().find(r=>same(r.predicted,token));
 if(rec){
  if(txHash&&!rec.txHash)records.update(rec.id,{txHash:txHash.toLowerCase()},{note:'transaction hash added from RECOVER A LAUNCH'});
  await reverify(rec.id,true);const now=records.get(rec.id);
  st.className='asset-status pass';st.textContent='Found it: this launch matches a record in this browser. State: '+String(now.state).replace(/_/g,' ')+'.';
  render();return}
 st.className='asset-status pass';st.textContent=launch?'PAR token found on-chain. This browser has no record of it.':'Transaction found.';
 const meta=await Chain.readTokenMetadata(rpc,token).catch(()=>null);
 const row=resultRow(`<div class="record-row"><span class="record-state ok">ON-CHAIN ✓</span><strong>$${esc(disp(meta&&meta.symbol||'?',16))}</strong><span class="mono">${esc(token)}</span><span>deployer ${esc(short(launch&&launch.deployer||t&&t.launched&&t.launched.deployer||''))}</span><a class="btn small" href="/project/${esc(token)}">PROJECT PAGE</a><button class="btn small" type="button" data-add>ADD TO MY LAUNCHES</button></div><p class="field-help">Adding creates a record from on-chain data only. Without the original intent record and signature (import your exported records for that) it cannot become a SyncNet provenance proof.</p>`);
 out.appendChild(row);
 row.querySelector('[data-add]').addEventListener('click',async()=>{
  const id=Core.keccak256Utf8('recovered|'+token.toLowerCase());
  if(records.get(id)){toast('Already in MY LAUNCHES');return}
  try{records.put({id,state:'MINED',chainId:4663,deployer:String(launch&&launch.deployer||t&&t.launched&&t.launched.deployer||'').toLowerCase(),predicted:token.toLowerCase(),symbol:meta?disp(meta.symbol,16):'',name:meta?disp(meta.name,64):'',txHash:txHash?txHash.toLowerCase():'',recordHash:'',salt:'',intentJson:'',signature:null,source:'recovered',history:[{state:'MINED',at:new Date().toISOString(),note:'recovered from '+(txHash?'transaction '+txHash:'token address')+' (on-chain data only)'}]});await reverify(id,true);render();toast('Added to MY LAUNCHES')}catch(e){toast('Could not store the record in this browser.')}
 });
}
$('recoverRun')?.addEventListener('click',recover);
$('recoverInput')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();recover()}});
$('exportAll')?.addEventListener('click',()=>download(records.exportJson(),'syncnet-launch-records.json'));
$('importFile')?.addEventListener('change',async()=>{const f=$('importFile').files?.[0];const st=$('importStatus');if(!f)return;if(f.size>2*1024*1024){st.className='asset-status fail';st.textContent='That file is too large.';return}try{const n=records.importJson(await f.text());st.className='asset-status pass';st.textContent=n?`${n} record${n===1?'':'s'} imported. Re-verifying from the chain…`:'Nothing new to import.';render();for(const r of records.all().filter(x=>x.imported&&Records.POST_BROADCAST.has(x.state)))await reverify(r.id,true);render();if(n)st.textContent=`${n} record${n===1?'':'s'} imported and re-verified from the chain.`}catch(e){st.className='asset-status fail';st.textContent=String(e.message||e).slice(0,200)}finally{$('importFile').value=''}});
records.subscribe(render);
render();
fetch('/api/config',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(j=>{if(j)serverConfig={...serverConfig,...j};render()}).catch(()=>{});
// Read-only auto check of unresolved launches.
(async()=>{for(const r of records.unresolvedAll()){if(Number(r.chainId)!==4663)continue;await reverify(r.id,true)}render()})();
})();
