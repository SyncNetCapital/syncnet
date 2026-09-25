/*
 * SyncNet launch records — durable, append-only evidence for every prepared / signed / broadcast launch.
 *
 * A record is written BEFORE the wallet is asked to send anything and is never deleted by the UI.
 * Lifecycle states:
 *   PREPARED → SIGNATURE_VALID → BROADCAST_ATTEMPTED → (TX_HASH_RECEIVED | BROADCAST_UNKNOWN | FAILED_PRE_BROADCAST)
 *   → MINED → ONCHAIN_VERIFIED → (INDEXER_PENDING | FULLY_VERIFIED);  FAILED_POST_BROADCAST = mined but reverted.
 * Unresolved states (BROADCAST_ATTEMPTED, BROADCAST_UNKNOWN, TX_HASH_RECEIVED) block any new launch of the same
 * ticker from the same wallet until RE-VERIFY resolves them from the chain.
 *
 * Browser only (localStorage + Web Locks). Exposes window.SyncNetRecords.
 */
(function(){
'use strict';
const Core=window.SyncNetCore, Chain=window.SyncNetChain;
const STATES=Object.freeze(['PREPARED','SIGNATURE_VALID','BROADCAST_ATTEMPTED','BROADCAST_UNKNOWN','TX_HASH_RECEIVED','MINED','ONCHAIN_VERIFIED','INDEXER_PENDING','FULLY_VERIFIED','FAILED_PRE_BROADCAST','FAILED_POST_BROADCAST']);
const UNRESOLVED=new Set(['BROADCAST_ATTEMPTED','BROADCAST_UNKNOWN','TX_HASH_RECEIVED']);
const DEPLOYED=new Set(['MINED','ONCHAIN_VERIFIED','INDEXER_PENDING','FULLY_VERIFIED']);
const POST_BROADCAST=new Set([...UNRESOLVED,...DEPLOYED,'FAILED_POST_BROADCAST']);
const lc=v=>String(v==null?'':v).toLowerCase();
const nowIso=()=>new Date().toISOString();
const json=(v)=>JSON.stringify(v,(k,x)=>typeof x==='bigint'?x.toString():x);
function mergeHistory(a,b){const out=[...(Array.isArray(a)?a:[])];const seen=new Set(out.map(h=>h&&h.state+'|'+h.at+'|'+h.note));for(const h of Array.isArray(b)?b:[]){const k=h&&h.state+'|'+h.at+'|'+h.note;if(h&&!seen.has(k)){out.push(h);seen.add(k)}}return out.slice(-60)}

function createStore(ns){
 const KEY=ns+'launch_records_v1';
 const MIGRATED=ns+'launch_records_migrated_v1';
 function readRaw(){try{const a=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(a)?a.filter(r=>r&&typeof r==='object'&&typeof r.id==='string'):[]}catch{return[]}}
 function writeRaw(list){
  // Keep every post-broadcast record forever; prune only old pre-broadcast drafts beyond 40.
  const post=list.filter(r=>POST_BROADCAST.has(r.state));
  const pre=list.filter(r=>!POST_BROADCAST.has(r.state)).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,40);
  const out=[...post,...pre].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  const text=json(out);
  localStorage.setItem(KEY,text);
  if(localStorage.getItem(KEY)!==text)throw Error('Browser storage did not keep the launch record.');
  return out;
 }
 function all(){return readRaw()}
 function get(id){return readRaw().find(r=>r.id===id)||null}
 /** Write-ahead insert/replace. Throws if the browser refuses to store it — callers must not send in that case. */
 function put(record){
  if(!record||!record.id)throw Error('Invalid launch record.');
  if(!STATES.includes(record.state))throw Error('Invalid launch record state '+record.state);
  const raw=readRaw(),prev=raw.find(r=>r.id===record.id)||null;
  // Evidence is never destroyed: a record that reached the wallet (or the chain) cannot be overwritten by a pre-broadcast state.
  if(prev&&POST_BROADCAST.has(prev.state)&&!POST_BROADCAST.has(record.state)&&record.state!=='FAILED_PRE_BROADCAST')throw Error('This launch already reached the wallet; its record cannot be reset.');
  if(prev&&DEPLOYED.has(prev.state)&&!DEPLOYED.has(record.state))throw Error('A deployed launch cannot be marked as not sent.');
  const list=raw.filter(r=>r.id!==record.id);
  const r={...(prev||{}),...record,updatedAt:nowIso()};
  r.history=mergeHistory(prev&&prev.history,record.history);
  r.createdAt=(prev&&prev.createdAt)||record.createdAt||r.updatedAt;
  list.push(r);writeRaw(list);
  const back=get(r.id);
  if(!back||back.state!==r.state)throw Error('Browser storage did not keep the launch record.');
  return back;
 }
 /** Moves a record to a new state (or just patches it) and appends to its history. */
 function update(id,patch,{state,note}={}){
  const cur=get(id);if(!cur)throw Error('Launch record not found: '+id);
  const next={...cur,...(patch||{})};
  if(state&&state!==cur.state){
   // Never move a deployed launch back to a "not sent" state.
   if(DEPLOYED.has(cur.state)&&(state==='FAILED_PRE_BROADCAST'||state==='BROADCAST_UNKNOWN'||state==='BROADCAST_ATTEMPTED'))throw Error('A deployed launch cannot be marked as not sent.');
   next.state=state;
  }
  next.history=[...(cur.history||[]),{state:next.state,at:nowIso(),note:note||''}].slice(-60);
  return put(next);
 }
 function acknowledge(id){return update(id,{acknowledgedAt:nowIso()},{note:'notice acknowledged — record kept'})}
 function sameLaunchKey(r,{chainId,deployer,symbol}){return Number(r.chainId)===Number(chainId)&&lc(r.deployer)===lc(deployer)&&String(r.symbol||'').toUpperCase()===String(symbol||'').toUpperCase()}
 /** Records that must stop (unresolved) or warn about (deployed) a new launch of the same ticker by the same wallet. */
 function conflicts(key){
  const rs=readRaw().filter(r=>sameLaunchKey(r,key));
  return{unresolved:rs.filter(r=>UNRESOLVED.has(r.state)),deployed:rs.filter(r=>DEPLOYED.has(r.state)),all:rs};
 }
 function unresolvedAll(){return readRaw().filter(r=>UNRESOLVED.has(r.state))}
 function exportJson(ids){
  const list=readRaw().filter(r=>!ids||ids.includes(r.id));
  return JSON.stringify({schema:'syncnet.launch.records.v1',exportedAt:nowIso(),origin:typeof location!=='undefined'?location.origin:'',records:list},null,2);
 }
 /** Imports records exported elsewhere. Imported evidence stays local and is re-verified from the chain before any claim. */
 function importJson(text){
  let j;try{j=JSON.parse(text)}catch{throw Error('That file is not valid JSON.')}
  const incoming=Array.isArray(j?.records)?j.records:(j&&j.schema==='syncnet.launch.proof.v2'?[fromProof(j)]:[]);
  if(!incoming.length)throw Error('No SyncNet launch records found in that file.');
  let n=0;const list=readRaw();
  for(const r of incoming){
   if(!r||typeof r.id!=='string'||!/^0x[0-9a-f]{64}$/i.test(r.id)||!STATES.includes(r.state))continue;
   if(!Chain.isAddr(r.predicted)||!Chain.isAddr(r.deployer))continue;
   if(list.some(x=>x.id===r.id))continue;
   // Imported evidence claims nothing until the chain confirms it: any post-broadcast state becomes BROADCAST_UNKNOWN
   // ("treat as sent, not verified") and imported verification/registry fields are dropped. RE-VERIFY resolves it.
   const neutral=POST_BROADCAST.has(r.state)?'BROADCAST_UNKNOWN':r.state;
   const {verification,registry,...rest}=r;
   list.push({...rest,state:neutral,imported:true,importedState:r.state,history:[...(Array.isArray(r.history)?r.history.slice(-40):[]),{state:neutral,at:nowIso(),note:'imported from file (claimed '+r.state+') — not verified here until RE-VERIFY reads the chain'}]});n++;
  }
  writeRaw(list);return n;
 }
 function fromProof(p){
  return{id:String(p.recordHash||'').toLowerCase(),state:'BROADCAST_UNKNOWN',chainId:p.chainId,deployer:p.deployer,predicted:p.token,symbol:(()=>{try{return JSON.parse(p.intentJson).symbol}catch{return''}})(),
   name:(()=>{try{return JSON.parse(p.intentJson).name}catch{return''}})(),txHash:p.txHash,recordHash:p.recordHash,salt:p.salt,intentJson:p.intentJson,
   signature:p.signature,createdAt:nowIso(),history:[],source:'proof-import'};
 }
 /** One-time import of the pre-RC keys (pending_launches, live_launch_proofs) so nothing recorded earlier is lost. */
 function migrateLegacy(){
  try{if(localStorage.getItem(MIGRATED))return 0}catch{return 0}
  let n=0;const list=readRaw();
  const read=(k)=>{try{const a=JSON.parse(localStorage.getItem(ns+k)||'[]');return Array.isArray(a)?a:[]}catch{return[]}};
  for(const p of read('pending_launches')){
   if(!Chain.isAddr(p?.token))continue;const id=/^0x[0-9a-f]{64}$/i.test(p.recordHash||'')?p.recordHash.toLowerCase():'legacy-'+lc(p.hash||p.token);
   if(list.some(x=>x.id===id))continue;
   list.push({id,state:p.hash?'TX_HASH_RECEIVED':'BROADCAST_UNKNOWN',legacy:true,chainId:Number(p.chainId||4663),deployer:p.account,predicted:p.token,symbol:p.symbol,name:p.name,txHash:p.hash||'',recordHash:p.recordHash||'',salt:p.salt||'',
    intentJson:p.intentRecord?JSON.stringify(p.intentRecord):'',signature:p.intentSignature?{scheme:p.signatureScheme||'EIP-712',typedData:p.typedData&&p.typedData.types?p.typedData:null,message:p.typedData&&p.typedData.message&&typeof p.typedData.message==='string'?p.typedData.message:null,signature:p.intentSignature}:null,
    request:{value:p.value},createdAt:p.createdAt||nowIso(),history:[{state:'TX_HASH_RECEIVED',at:nowIso(),note:'migrated from the pre-release pending list'}]});n++;
  }
  for(const p of read('live_launch_proofs')){
   if(!Chain.isAddr(p?.token))continue;const id=/^0x[0-9a-f]{64}$/i.test(p.recordHash||'')?p.recordHash.toLowerCase():'legacy-'+lc(p.txHash||p.token);
   if(list.some(x=>x.id===id))continue;
   list.push({id,state:'MINED',legacy:true,chainId:Number(p.chainId||4663),deployer:p.deployer,predicted:p.token,symbol:p.project?.symbol,name:p.project?.name,txHash:p.txHash||'',recordHash:p.recordHash||'',salt:p.salt||'',
    intentJson:p.intentRecord?JSON.stringify(p.intentRecord):'',signature:p.intentSignature?{scheme:p.signatureScheme||'EIP-712',typedData:p.typedData&&p.typedData.types?p.typedData:null,signature:p.intentSignature}:null,createdAt:p.createdAt||nowIso(),
    history:[{state:'MINED',at:nowIso(),note:'migrated from the pre-release proof list — re-verify to confirm'}]});n++;
  }
  try{writeRaw(list);localStorage.setItem(MIGRATED,nowIso())}catch{}
  return n;
 }
 function subscribe(cb){const h=e=>{if(!e||e.key===KEY)cb()};window.addEventListener('storage',h);return()=>window.removeEventListener('storage',h)}
 return Object.freeze({KEY,all,get,put,update,acknowledge,conflicts,unresolvedAll,exportJson,importJson,migrateLegacy,subscribe});
}

/** Exclusive launch lock across tabs (Web Locks); falls back to a short-lived localStorage mutex. Returns null when busy elsewhere. */
async function withLaunchLock(name,fn){
 if(typeof navigator!=='undefined'&&navigator.locks&&navigator.locks.request){
  let ran=false,result=null;
  await navigator.locks.request(name,{ifAvailable:true},async lock=>{if(!lock)return;ran=true;result=await fn()});
  return ran?{ran:true,result}:{ran:false};
 }
 const k='syncnet_lock_'+name,me=Math.random().toString(36).slice(2);
 try{const cur=JSON.parse(localStorage.getItem(k)||'null');if(cur&&cur.exp>Date.now())return{ran:false};localStorage.setItem(k,JSON.stringify({id:me,exp:Date.now()+5*60e3}));if(JSON.parse(localStorage.getItem(k)).id!==me)return{ran:false}}catch{}
 try{return{ran:true,result:await fn()}}finally{try{localStorage.removeItem(k)}catch{}}
}

/** Public, verifiable proof (syncnet.launch.proof.v2) from a record. Only for records with a tx hash, a signature and an intent record. */
function toProof(r){
 if(!r||!r.txHash||!r.intentJson||!r.signature||!r.signature.signature)return null;
 return{schema:'syncnet.launch.proof.v2',chainId:Number(r.chainId),factory:(r.factory||Chain.ROBINHOOD.multiFactory).toLowerCase(),token:lc(r.predicted),deployer:lc(r.deployer),txHash:lc(r.txHash),
  blockNumber:r.receipt&&r.receipt.blockNumber!=null?String(r.receipt.blockNumber):null,recordHash:lc(r.recordHash),salt:lc(r.salt),intentJson:r.intentJson,
  signature:{scheme:r.signature.scheme,typedData:r.signature.typedData||null,message:r.signature.message||null,signature:r.signature.signature,signer:lc(r.signature.signer||r.deployer)},
  expected:r.expected||null,actual:r.verification&&r.verification.onchain?r.verification.onchain.actualSummary||null:null,createdBy:'SyncNet v2.5-rc'};
}

/** Expected on-chain values for verifyDeployment(), rebuilt from a record. */
function expectedOf(r){
 const i=(()=>{try{return JSON.parse(r.intentJson||'{}')}catch{return{}}})();
 return{token:r.predicted,deployer:r.deployer,name:i.name??r.name,symbol:i.symbol??r.symbol,logo:i.logo??'',description:i.description??'',twitter:i.twitter??'',website:i.website??'',
  creatorFeeRecipient:i.creatorFeeRecipient??r.expected?.creatorFeeRecipient,creatorTaxBps:i.creatorTaxBps??r.expected?.creatorTaxBps,
  pairTokens:(i.connections||[]).map(c=>c.address),economics:r.expected?.economics||null,openingBuy:r.expected?.openingBuy||null};
}

/**
 * RE-VERIFY: rebuilds the launch status from stored evidence + current chain state. On-chain factory state is authoritative;
 * the indexer only upgrades ONCHAIN_VERIFIED to FULLY_VERIFIED. Never marks a deployed token as "not sent".
 * deps: { store, rpc, fetchIndexer(token) -> row|null }
 */
async function reverify(record,{store,rpc,fetchIndexer}){
 let r=store.get(record.id)||record;
 const notes=[];
 // 1) What does the transaction say (if we have its hash)?
 if(r.txHash){
  const t=await Chain.findLaunchByTx(rpc,r.txHash).catch(e=>({status:'error',error:e}));
  if(t.status==='success'){
   if(t.launched&&!Chain.same(t.launched.token,r.predicted))notes.push('Transaction launched '+t.launched.token+', not the predicted '+r.predicted+'.');
   r=store.update(r.id,{receipt:{status:t.receipt.status,blockNumber:Number(t.receipt.blockNumber),gasUsed:String(t.receipt.gasUsed||''),launchedToken:t.launched?t.launched.token:null}},{state:DEPLOYED.has(r.state)?r.state:'MINED',note:'receipt: success'});
  }else if(t.status==='reverted'){
   const exists=await Chain.readLaunch(rpc,r.predicted).catch(()=>null);
   if(!exists){r=store.update(r.id,{receipt:{status:t.receipt.status,blockNumber:Number(t.receipt.blockNumber)}},{state:'FAILED_POST_BROADCAST',note:'transaction reverted; no token at the predicted address'});return{record:r,notes:notes.concat('The transaction reverted. No token was created.')}}
  }else if(t.status==='pending'){notes.push('Transaction is known but not mined yet.')}
  else if(t.status==='unknown'){notes.push('The RPC does not know this transaction hash (yet).')}
 }
 // 2) Is the predicted token on-chain? (authoritative)
 const launch=await Chain.readLaunch(rpc,r.predicted);
 if(!launch){
  if(DEPLOYED.has(r.state)){notes.push('The factory did not return the token right now; keeping the deployed state. Retry later.');return{record:r,notes}}
  let nonce=null;try{nonce=Number(await rpc('eth_getTransactionCount',[r.deployer,'latest']))}catch{}
  if(r.state==='BROADCAST_ATTEMPTED'||r.state==='BROADCAST_UNKNOWN'){
   const moved=r.nonceAtSend!=null&&nonce!=null&&nonce>r.nonceAtSend;
   r=store.update(r.id,{lastCheck:{at:nowIso(),tokenExists:false,latestNonce:nonce}},{state:'BROADCAST_UNKNOWN',note:moved?'wallet nonce moved past the launch nonce but no token exists':'no token at the predicted address yet'});
   notes.push(moved?'A transaction with the launch nonce was mined from this wallet, but no token exists at the predicted address — that transaction was not this launch or it reverted.':'No token exists at the predicted address. If your wallet shows no pending or sent launch transaction, you may mark this attempt as not sent.');
  }else{notes.push('No token exists at the predicted address yet.')}
  return{record:r,notes};
 }
 // 3) Deployed: authoritative field-by-field verification.
 const v=await Chain.verifyDeployment(rpc,expectedOf(r),{attempts:2,delayMs:800});
 const summary=v.actual&&v.actual.launch?{kind:v.actual.launch.kind,poolFee:v.actual.launch.poolFee,baseFeeBps:v.actual.launch.baseFeeBps,protocolFeeShareBps:v.actual.launch.protocolFeeShareBps,creatorTaxBps:v.actual.launch.creatorTaxBps,creatorFeeRecipient:lc(v.actual.launch.creatorFeeRecipient),marketCount:v.actual.launch.marketCount,markets:(v.actual.markets||[]).map(m=>({pairToken:lc(m.pairToken),phantomQuote:m.phantomQuote,positionId:m.positionId})),launchedAt:v.actual.launch.launchedAt,openingBuyBalance:v.actual.openingBuyBalance==null?null:String(v.actual.openingBuyBalance)}:null;
 const onchain={status:v.status,checks:v.checks,economicsChanged:Boolean(v.economicsChanged),actualSummary:summary,verifiedAt:nowIso()};
 let state=v.status==='verified'?'ONCHAIN_VERIFIED':'MINED';
 let indexer=r.verification&&r.verification.indexer||null;
 let row=null;
 if(fetchIndexer)row=await fetchIndexer(r.predicted).catch(()=>null);
 // A launch whose wallet never returned a hash: take the indexer's launchTx, but only after the chain confirms it launched this token.
 if(row&&!r.txHash&&/^0x[0-9a-fA-F]{64}$/.test(String(row.launchTx||''))){
  const t=await Chain.findLaunchByTx(rpc,row.launchTx).catch(()=>null);
  if(t&&t.status==='success'&&t.launched&&Chain.same(t.launched.token,r.predicted)&&Chain.same(t.launched.deployer,r.deployer)&&Chain.same(t.tx&&t.tx.from,r.deployer)){
   r=store.update(r.id,{txHash:lc(row.launchTx),receipt:{status:t.receipt.status,blockNumber:Number(t.receipt.blockNumber),launchedToken:t.launched.token}},{note:'transaction hash recovered from the PAR indexer and confirmed on-chain'});
   notes.push('Launch transaction found: '+lc(row.launchTx)+' (confirmed on-chain).');
  }
 }
 if(v.status==='verified'&&fetchIndexer){
  if(row){indexer={status:'found',at:nowIso(),feeMode:row.feeMode||null};state='FULLY_VERIFIED'}
  else{indexer={status:'pending',at:nowIso()};state='INDEXER_PENDING'}
 }
 r=store.update(r.id,{verification:{...(r.verification||{}),onchain,indexer}},{state:DEPLOYED.has(r.state)&&state==='MINED'?r.state:state,note:'re-verify: on-chain '+v.status+(indexer?'; indexer '+indexer.status:'')});
 const hardFails=v.checks.filter(c=>c.hard&&!c.ok);
 const wasVerified=Boolean(record.verification&&record.verification.onchain&&record.verification.onchain.status==='verified');
 if(v.status!=='verified'&&wasVerified&&hardFails.every(c=>c.id==='recipient'))notes.push('The creator-fee recipient changed after launch (the recipient can transfer this right, and PAR can move it through a Community Takeover). Everything else still matches.');
 else if(v.status!=='verified')notes.push('The token exists but differs from the prepared launch in: '+hardFails.map(c=>c.label).join(', ')+'. Do not launch again; inspect the transaction.');
 if(v.economicsChanged)notes.push('PAR fee parameters at inclusion differed from the ones read at preparation; the actual values are recorded.');
 return{record:r,notes};
}

window.SyncNetRecords=Object.freeze({STATES,UNRESOLVED,DEPLOYED,POST_BROADCAST,createStore,withLaunchLock,toProof,expectedOf,reverify});
})();
