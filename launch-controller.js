/* Network Sync public-beta simulation controller.
   New transaction submission is intentionally disabled in this build.
   Legacy receipt recovery remains available for transactions started by an earlier build. */
(function(){
'use strict';
const $=id=>document.getElementById(id),KEY='syncnet.network-launch.v1';
let prepared=null,busy=false,record=null,storageOK=true;
try{const raw=localStorage.getItem(KEY);if(raw){record=JSON.parse(raw);if(record.schemaVersion!==1||!record.prepared?.request)throw Error('Unsupported saved launch record.');}}catch{storageOK=false;record=null;}
function message(text){$('launchStatus').textContent=text;}
function save(value){localStorage.setItem(KEY,JSON.stringify(value));record=value;}
function current(){return window.SyncNetDraft.read();}
function snapshot(){return JSON.stringify(current().draft);}
function update(){
 const d=current().draft,legacyPending=record&&['awaiting-wallet','pending','unknown'].includes(record.state);
 $('launchReal').disabled=busy||!!legacyPending||d.mode!=='network';
 $('launchReal').textContent=busy?'SIMULATING…':'RUN LAUNCH SIMULATION';
 $('resumeLaunch').hidden=!legacyPending;$('resumeLaunch').disabled=busy;
 $('recoveryHashGroup').hidden=!!record?.hash||!legacyPending;
 $('launchConfirmGroup').hidden=true;
 $('launchFeeDetails').hidden=!prepared;
 if(d.mode!=='network'&&!legacyPending)message('Stable Sync is preview only. Choose Network Sync to run the launch simulation.');
}
function invalidate(){prepared=null;$('launchAcknowledge').checked=false;update();}
window.addEventListener('syncnet:draft-change',invalidate);
['publicLogo','launchWithoutLogo'].forEach(id=>$(id).addEventListener('input',invalidate));
function journalLink(h){$('launchTransaction').hidden=!h;if(h){$('launchTransaction').href='https://robinhoodchain.blockscout.com/tx/'+h;$('launchTransaction').textContent='View prior transaction on explorer';}}
function showResult(result){$('realSuccess').hidden=false;$('realToken').textContent=result.token;$('realName').textContent=result.name+' · $'+result.symbol;$('realPAR').href='https://par.family/token/'+result.token;$('realExplorer').href='https://robinhoodchain.blockscout.com/address/'+result.token;$('realProject').href='/token/'+result.token;$('copyRealToken').onclick=async()=>{try{await navigator.clipboard.writeText(result.token);$('copyRealToken').textContent='Copied';}catch{message('Copy the contract address shown above.')}};journalLink(result.transactionHash);message('A launch started in an earlier build was confirmed and verified from its on-chain receipt. New transaction submission is disabled in this public beta.');}
async function track(client,viem){journalLink(record.hash);message('Checking the prior transaction. No new transaction will be requested…');const receipt=await client.waitForTransactionReceipt({hash:record.hash,confirmations:2,timeout:180000,onReplaced:({transaction})=>{save({...record,hash:transaction.hash,state:'pending'});journalLink(transaction.hash);}});const result=await window.SyncNetLaunch.verify({client,viem,prepared:record.prepared,transactionHash:record.hash,receipt});save({...record,state:'confirmed',result});showResult(result);}
async function locked(fn){if(!navigator.locks?.request)throw Error('Use an updated browser with HTTPS to recover a prior transaction.');return navigator.locks.request(KEY,{ifAvailable:true},async lock=>{if(!lock)throw Error('Another tab is checking this prior launch. Use that tab.');const raw=localStorage.getItem(KEY);record=raw?JSON.parse(raw):null;return fn();});}
$('launchReal').onclick=async()=>{
 if(busy)return;busy=true;update();
 try{
  const {provider,draft}=current();if(!provider||!draft.account)throw Error('Connect your wallet first.');if(draft.invalidLinks)throw Error('Correct the X or website link before simulating.');if(draft.hasLocalArtwork&&!draft.logo&&!$('launchWithoutLogo').checked)throw Error('Your uploaded image is a local preview. Add its public HTTPS/IPFS URL below, or explicitly choose a simulation without an on-chain logo.');
  const fingerprint=snapshot(),assertCurrent=()=>{if(fingerprint!==snapshot()||provider!==current().provider)throw Error('Project or wallet changed. Run the simulation again.');};
  const viem=await window.SyncNetDraft.viem(),client=await window.SyncNetDraft.client();assertCurrent();
  message('Checking both assets, current fees, wallet eligibility and the exact PAR launch simulation…');
  const p=await window.SyncNetLaunch.prepare({client,provider,draft,viem,assertCurrent});assertCurrent();prepared=p;
  for(const id of ['checkLaunch','checkExternal','checkSecond','checkSimulation']){$(id).textContent='pass ✓';$(id).className='status pass';}
  $('parLaunchFee').textContent=viem.formatEther(BigInt(p.request.value))+' ETH';
  $('launchAcknowledge').checked=false;$('launchConfirmGroup').hidden=true;
  $('launchFeeDetails').textContent='SIMULATION ONLY · NO TRANSACTION REQUESTED\n'+p.draft.name+' ($'+p.draft.symbol+') · '+p.draft.external+' + SYNC\nWallet: '+p.request.from+'\nFactory: '+p.request.to+'\nPredicted token: '+p.predicted+'\nHolder Vault: '+window.SyncNetLaunch.VAULT+'\nCreator tax: '+(p.draft.tax/100)+'% · Total pool fee: '+(p.poolFee/10000)+'%\nPAR launch fee at simulation time: '+viem.formatEther(BigInt(p.request.value))+' ETH + estimated wallet gas if execution is enabled later. SyncNet platform fee: 0.\nLogo: '+(p.draft.logo||'none')+'\nNo dev buy. Metadata and tax would be fixed at launch.';
  message('SIMULATION PASSED · The current PAR launch path, calldata and gas estimate were checked. Transaction execution is temporarily disabled; your wallet was not asked to sign or submit anything.');
 }catch(e){message(String(e?.shortMessage||e?.message||e).slice(0,650)+' No transaction was requested.');prepared=null;}
 finally{busy=false;update();}
};
$('resumeLaunch').onclick=async()=>{if(busy)return;busy=true;update();try{await locked(async()=>{if(!record||record.state==='confirmed'){if(record?.result)showResult(record.result);return;}const supplied=$('recoveryHash').value.trim();if(!record.hash){if(!/^0x[a-fA-F0-9]{64}$/.test(supplied))throw Error('Paste the transaction hash from your wallet activity.');save({...record,state:'pending',hash:supplied});}await track(await window.SyncNetDraft.client(),await window.SyncNetDraft.viem());});}catch(e){if(e.reverted&&record){save({...record,state:'reverted'});}message(String(e.shortMessage||e.message||e).slice(0,650)+' No new transaction was requested.');}finally{busy=false;update();}};
$('downloadLaunchRecord').onclick=()=>{if(!record)return;const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='syncnet-launch-record.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
window.addEventListener('storage',e=>{if(e.key===KEY){try{record=e.newValue?JSON.parse(e.newValue):null;invalidate();if(record?.result)showResult(record.result);}catch{storageOK=false;record=null;update();}}});
if(record?.state==='confirmed'&&record.result){journalLink(record.hash);showResult(record.result);}else if(record&&['awaiting-wallet','pending','unknown'].includes(record.state)){journalLink(record.hash);message('A transaction started in an earlier SyncNet build is saved in this browser. You can check that existing transaction; this build will not request a new one.');}else{message('Public beta simulation mode · Connect a wallet and run the launch simulation. No transaction will be requested.');}
update();
})();
