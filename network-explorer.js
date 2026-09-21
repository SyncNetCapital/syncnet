/* SyncNet v1.1.7 public network directory.
   - Discovers live $SYNC-connected PAR projects.
   - Always resolves locally registered SyncNet profile contracts directly, so a
     known launch is not lost because of indexer pagination.
   - Public provenance remains separate: a market connection is observable;
     "launched through SyncNet" requires registry/provenance verification. */
(function(){
"use strict";
const SYNC="0x6368e007b9f0b941560ed1f3bceb20247f5eca37";
const USDG="0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const API="https://api.par.family";
const RPC="https://rpc.mainnet.chain.robinhood.com/";
const PRICER="0x9EfC6EFA4c5F31e2BEC6CC174Ba7bB8f0b57d563";
const BLOCKSCOUT="https://robinhoodchain.blockscout.com";
const $=id=>document.getElementById(id);
const esc=v=>String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const attr=esc;
const same=(a,b)=>String(a||"").toLowerCase()===String(b||"").toLowerCase();
function imageUrl(v){v=String(v||"").trim();if(!v)return"";if(v.startsWith("/assets/")&&!v.includes("..")&&!/[?#\\]/.test(v))return v;if(v.startsWith("ipfs://"))return"https://ipfs.io/ipfs/"+v.slice(7);try{const u=new URL(v);return u.protocol==="https:"&&!u.username&&!u.password?u.href:""}catch{return""}}
function ethPrice(n){n=Number(n);if(!Number.isFinite(n)||n<=0)return"—";if(n>=.01)return n.toFixed(6).replace(/0+$/," ").trim().replace(/\.$/,"")+" ETH";return n.toPrecision(5)+" ETH"}
function volume(n){n=Number(n);if(!Number.isFinite(n)||n<0)return"—";if(n>=1000000)return(n/1000000).toFixed(2).replace(/\.?0+$/," ").trim()+"M ETH";if(n>=1000)return(n/1000).toFixed(2).replace(/\.?0+$/," ").trim()+"K ETH";return n.toLocaleString("en-US",{maximumFractionDigits:3})+" ETH"}
function rows(body){if(Array.isArray(body))return body;for(const k of ["launches","items","data","rows","results"])if(Array.isArray(body?.[k]))return body[k];return[]}
async function json(url,opts={}){const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),opts.timeout||12000);try{const r=await fetch(url,{cache:"no-store",signal:ctl.signal,headers:{Accept:"application/json"}});if(!r.ok)throw Error("HTTP "+r.status);return await r.json()}finally{clearTimeout(t)}}

async function holderCountFromBlockscout(address){
  const seen=new Set();
  const offset=200; // Blockscout currently caps/returns 200 on this endpoint.
  for(let page=1;page<=100;page++){
    const u=`${BLOCKSCOUT}/api?module=token&action=getTokenHolders&contractaddress=${encodeURIComponent(address)}&page=${page}&offset=${offset}`;
    const d=await json(u,{timeout:12000});
    if(String(d?.status)!=="1"||!Array.isArray(d.result))throw Error("Explorer holder API unavailable");
    for(const row of d.result){
      const a=String(row?.address||row?.holder_address||row?.hash||"").toLowerCase();
      if(a)seen.add(a); else seen.add(`page${page}:${seen.size}`);
    }
    if(d.result.length<offset)return {count:seen.size,exact:true,source:"Blockscout holder index"};
  }
  return {count:seen.size,exact:false,source:"Blockscout · at least"};
}
async function holderCountFallback(address){
  const d=await json(`${API}/holders?token=${encodeURIComponent(address)}&limit=500`);
  const a=Array.isArray(d)?d:(Array.isArray(d?.holders)?d.holders:Array.isArray(d?.items)?d.items:[]);
  const explicit=[d?.total,d?.count,d?.holderCount].map(Number).find(Number.isFinite);
  if(Number.isFinite(explicit))return{count:explicit,exact:true,source:"PAR indexer"};
  return{count:a.length,exact:a.length<500,source:a.length>=500?"PAR indexer · at least":"PAR indexer"};
}
async function getHolderCount(address){
  try{return await holderCountFromBlockscout(address)}catch{}
  try{return await holderCountFallback(address)}catch{return{count:null,exact:false,source:"holder data unavailable"}}
}
async function setHolderCount(address,valueId="holderCount",sourceId="holderSource"){
  const value=$(valueId),source=$(sourceId);if(!value)return null;
  const r=await getHolderCount(address);
  value.textContent=r.count==null?"—":(r.exact?"":"≥ ")+Number(r.count).toLocaleString("en-US");
  if(source)source.textContent=r.source;
  return r;
}

async function quoteReady(){
  const el=$("publicNetworkStatus");if(!el)return;
  el.textContent="CHECKING";el.className="";
  try{
    const viem=await import("/vendor/viem.js");
    const chain=viem.defineChain({id:4663,name:"Robinhood Chain",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:{default:{http:[RPC]}}});
    const client=viem.createPublicClient({chain,transport:viem.http(RPC,{timeout:12000,retryCount:1})});
    const ok=await client.readContract({address:PRICER,abi:[{type:"function",name:"isPriceable",stateMutability:"view",inputs:[{type:"address",name:"quoteToken"}],outputs:[{type:"bool"}]}],functionName:"isPriceable",args:[SYNC]});
    el.textContent=ok?"READY ✓":"PAUSED";el.className=ok?"ready":"offline";
    const note=$("publicNetworkStatusNote");if(note)note.textContent=ok?"new Network Sync launches available":"new Network Sync launches paused · existing markets stay live";
  }catch{el.textContent="STATUS UNAVAILABLE";el.className="offline"}
}

async function resolveLaunch(row){
  const token=row?.token||row?.address;
  if(!/^0x[a-fA-F0-9]{40}$/.test(String(token||"")))return null;
  if(Array.isArray(row.markets)&&row.markets.length)return {...row,token};
  try{const d=await json(`${API}/launches/${token}`);return {...d,token:d?.token||token}}catch{return {...row,token}}
}
function marketArray(d){return Array.isArray(d?.markets)&&d.markets.length?d.markets:[d]}
function marketPairAddress(m){return m?.pairToken||m?.quoteToken||m?.pairTokenAddress||m?.quoteTokenAddress||""}
function marketPairSymbol(m){return String(m?.quoteSymbol||m?.pairSymbol||m?.pairTokenSymbol||m?.symbolQuote||"QUOTE").toUpperCase()}
function isSyncConnected(d){return marketArray(d).some(m=>same(marketPairAddress(m),SYNC)||marketPairSymbol(m)==="SYNC")}
function isUsdgConnected(d){return marketArray(d).some(m=>same(marketPairAddress(m),USDG)||marketPairSymbol(m)==="USDG")}
function externalMarketSymbol(d,secondAddress){
  const other=marketArray(d).find(m=>!same(marketPairAddress(m),secondAddress));
  return other?marketPairSymbol(other):"ASSET";
}
function marketLabels(d){const sym=String(d?.symbol||"TOKEN").toUpperCase();return marketArray(d).map(m=>`${sym} / ${marketPairSymbol(m)}`)}
function card(d,profile={}){
  const token=String(d.token||""),name=esc(profile.name||d.name||"Token"),sym=esc(String(d.symbol||profile.symbol||"").toUpperCase()),logo=imageUrl(profile.image||profile.avatar||d.logoUrl||d.logo);
  const labels=marketLabels(d);
  return `<article class="connected-card">
    <div class="connected-card-top"><div class="connected-card-logo">${logo?`<img src="${attr(logo)}" alt="${sym||"token"}">`:"SYNC"}</div><div style="min-width:0"><h3>${name}</h3><div class="symbol">$${sym}</div></div></div>
    <div class="connected-badge">SYNC-CONNECTED · LIVE ON PAR</div>
    <div class="connected-markets">${labels.map(x=>`<span>${esc(x)}</span>`).join("")}</div>
    <div class="connected-card-metrics"><div><small>Price</small><strong>${ethPrice(d.lastPriceEth)}</strong></div><div><small>Volume</small><strong>${volume(d.totalVolumeEth)}</strong></div></div>
    <div class="connected-card-actions"><a class="btn primary" href="/token/${attr(token)}">View chart</a><a class="btn" href="https://par.family/token/${attr(token)}" target="_blank" rel="noreferrer">PAR ↗</a></div>
  </article>`;
}
async function registryEntries(){
  try{
    const d=await json("/syncnet-projects.json");
    return (Array.isArray(d?.projects)?d.projects:[]).filter(x=>/^0x[a-fA-F0-9]{40}$/.test(String(x?.token||"")));
  }catch{return[]}
}
function profileMap(entries){const m=new Map();for(const x of entries)m.set(String(x.token).toLowerCase(),x.profile||{});return m}

function renderModeExample(targetId,d,entry,secondAddress,label){
  const host=$(targetId);if(!host)return;
  if(!d){host.hidden=true;host.innerHTML="";return}
  const profile=entry?.profile||{};
  const token=String(d.token||entry?.token||"");
  const name=esc(profile.name||d.name||"Project");
  const sym=esc(String(d.symbol||profile.symbol||"").toUpperCase());
  const logo=imageUrl(profile.image||profile.avatar||d.logoUrl||d.logo);
  const ext=esc(externalMarketSymbol(d,secondAddress));
  const right=label==="NETWORK"?"$SYNC":"USDG";
  host.innerHTML=`<div class="mode-live-label"><span>Live example</span><span>${entry?.verified?"VERIFIED SYNCNET LAUNCH":"LIVE ON PAR"}</span></div>
    <div class="mode-live-project">${logo?`<img src="${attr(logo)}" alt="${sym||name}">`:`<div class="mode-live-fallback">SYNC</div>`}<div><strong>${name}</strong><small>${sym?`$${sym}`:""}</small></div></div>
    <div class="sn-market-connection mode-live-connection"><span>${ext}</span><span aria-hidden="true">←</span><strong>${sym||name}</strong><span aria-hidden="true">→</span><span>${right}</span></div>
    <a href="/token/${attr(token)}">View project →</a>`;
  host.hidden=false;
}

async function loadConnectedProjects(){
  const grid=$("connectedProjectsGrid"),count=$("connectedProjectCount");if(!grid)return;
  grid.innerHTML='<div class="network-empty">Reading live launches from PAR…</div>';
  try{
    const entries=await registryEntries();
    const profiles=profileMap(entries);
    const registryResolved=(await Promise.all(entries.map(e=>resolveLaunch({token:e.token})))).filter(Boolean);

    let recent=[];
    try{recent=rows(await json(`${API}/launches?orderBy=createdAt&orderDirection=desc&limit=100`))}catch{}
    const recentResolved=(await Promise.all(recent.map(resolveLaunch))).filter(Boolean);

    const seen=new Set(),all=[];
    for(const d of [...registryResolved,...recentResolved]){
      const k=String(d.token||"").toLowerCase();
      if(k&&!seen.has(k)){seen.add(k);all.push(d)}
    }
    const connected=all.filter(isSyncConnected);
    if(count)count.textContent=connected.length.toLocaleString("en-US");
    grid.innerHTML=connected.length?connected.map(d=>card(d,profiles.get(String(d.token||"").toLowerCase())||{})).join(""):'<div class="network-empty"><strong>No indexed $SYNC-connected project found yet.</strong><br>PAR may need a moment to index a new launch. Refresh shortly.</div>';

    // Automatic homepage examples. Prefer a registered SyncNet profile, then
    // fall back to the newest observable compatible PAR launch.
    let netEntry=entries.find(e=>String(e.mode||"").toLowerCase()==="network");
    let netLaunch=netEntry?all.find(d=>same(d.token,netEntry.token)&&isSyncConnected(d)):null;
    if(!netLaunch)netLaunch=connected[0]||null;
    if(!netEntry&&netLaunch)netEntry={token:netLaunch.token,profile:profiles.get(String(netLaunch.token).toLowerCase())||{},verified:false};
    renderModeExample("networkModeLiveExample",netLaunch,netEntry,SYNC,"NETWORK");

    let stableEntry=entries.find(e=>String(e.mode||"").toLowerCase()==="stable");
    let stableLaunch=stableEntry?all.find(d=>same(d.token,stableEntry.token)&&isUsdgConnected(d)&&!isSyncConnected(d)):null;
    renderModeExample("stableModeLiveExample",stableLaunch,stableEntry,USDG,"STABLE");
  }catch(e){
    if(count)count.textContent="—";
    grid.innerHTML='<div class="network-empty">Connected-project data is temporarily unavailable. Your on-chain markets are unaffected.</div>';
    renderModeExample("networkModeLiveExample",null,null,SYNC,"NETWORK");
    renderModeExample("stableModeLiveExample",null,null,USDG,"STABLE");
  }
}
function init(){
  setHolderCount(SYNC);
  quoteReady();
  loadConnectedProjects();
  $("refreshConnectedProjects")?.addEventListener("click",()=>{loadConnectedProjects();quoteReady();setHolderCount(SYNC)});
  setInterval(loadConnectedProjects,60000);setInterval(quoteReady,60000);setInterval(()=>setHolderCount(SYNC),120000);
}
window.SyncNetNetwork=Object.freeze({getHolderCount,setHolderCount,loadConnectedProjects,quoteReady});
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();
