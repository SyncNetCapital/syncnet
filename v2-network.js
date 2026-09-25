(function(){
'use strict';

const API='https://api.par.family';
const RPC='https://rpc.mainnet.chain.robinhood.com/';
const SYNC='0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
const DEMO='0xb0a3d82Bf46AE6303Aee263fc4d48E5c657fC967';
const FALLBACK_LIMIT=200;
const PAGE_SIZE=500;
const MAX_HISTORY=5000;
const CANONICAL=new Map([[SYNC.toLowerCase(),{rank:0,label:'SYNCNET NETWORK ASSET',symbol:'SYNC'}],[DEMO.toLowerCase(),{rank:1,label:'SYNCNET ORIGIN',symbol:'SYNCAT'}]]);
let historyCoverage={mode:'unknown',count:0,indexed:0};
const $=id=>document.getElementById(id);
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();
const valid=a=>/^0x[a-fA-F0-9]{40}$/.test(String(a||''));
const ZERO='0x0000000000000000000000000000000000000000';
const esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const cleanText=v=>String(v??'').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,'').replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim();
const safeSymbol=v=>{const x=cleanText(v).replace(/^\$/,'');return x&&x.length<=32?x.toUpperCase():''};
const safeName=v=>{const x=cleanText(v);return x&&x.length<=96?x:''};
const short=a=>valid(a)?`${a.slice(0,6)}…${a.slice(-4)}`:String(a||'');
const caches={resolve:new Map(),meta:new Map()};
let recentPromise=null,profilesPromise=null,tokenListPromise=null;
let currentRoot=DEMO;
// ---- Map UX: pressing MAP must always produce a visible consequence. ----
let mapSeq=0,searchSeq=0;
const reduceMotion=()=>Boolean(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
function topologySection(){const t=$('topologyGraph');return t?(t.closest('section')||t):null}
function showTopologySection(){const s=topologySection();if(s&&s.hidden)s.hidden=false;return s}
function reveal(el,block='start'){
  if(!el)return;
  try{el.scrollIntoView({behavior:reduceMotion()?'auto':'smooth',block})}catch{el.scrollIntoView()}
}
function focusQuietly(el){
  if(!el)return;
  if(!el.hasAttribute('tabindex'))el.setAttribute('tabindex','-1');
  try{el.focus({preventScroll:true})}catch{}
}
function focusIsNearSearch(){
  const a=document.activeElement;
  return !a||a===document.body||a===$('tokenSearch')||a===$('mapToken')||Boolean(a.closest&&a.closest('#searchMatches'));
}
function flashStatus(){
  const el=$('searchStatus');if(!el)return;
  el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');
  const r=el.getBoundingClientRect();
  if(r.top<70||r.bottom>window.innerHeight)reveal(el,'center');
}
function setMapBusy(on){
  const b=$('mapToken');if(!b)return;
  if(!b.dataset.label)b.dataset.label=b.textContent;
  b.disabled=on;b.setAttribute('aria-busy',on?'true':'false');
  b.textContent=on?'MAPPING…':b.dataset.label;
}

function rows(body){
  if(Array.isArray(body)) return body;
  for(const k of ['launches','items','data','rows','results']) if(Array.isArray(body?.[k])) return body[k];
  return [];
}
function markets(d){ return Array.isArray(d?.markets)&&d.markets.length?d.markets:[d]; }
function pairAddr(m){ return m?.pairToken||m?.quoteToken||m?.pairTokenAddress||m?.quoteTokenAddress||''; }
function pairSym(m){ return safeSymbol(m?.quoteSymbol||m?.pairSymbol||m?.pairTokenSymbol||''); }
function tokenAddr(d){ return d?.token||d?.tokenAddress||d?.address||''; }
function tokenSym(d){ return safeSymbol(d?.symbol||d?.tokenSymbol||'')||'TOKEN'; }

async function fetchJson(url){
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),14000);
  try{
    const r=await fetch(url,{cache:'no-store',signal:ctl.signal});
    if(!r.ok) throw Error(`HTTP ${r.status}`);
    return await r.json();
  }finally{ clearTimeout(timer); }
}

async function tokenList(){
  if(tokenListPromise) return tokenListPromise;
  tokenListPromise=(async()=>{
    const urls=['/api/par-tokenlist','https://par.family/tokenlist.json'];
    for(const url of urls){
      try{
        const body=await fetchJson(url);
        const list=Array.isArray(body)?body:(Array.isArray(body?.tokens)?body.tokens:[]);
        if(list.length) return list.filter(t=>!t?.chainId||Number(t.chainId)===4663);
      }catch{}
    }
    return [];
  })().catch(()=>[]);
  return tokenListPromise;
}

async function profiles(){
  if(profilesPromise) return profilesPromise;
  profilesPromise=fetch('/syncnet-projects.json',{cache:'no-store'}).then(r=>r.ok?r.json():{projects:[]}).then(j=>{
    const map=new Map();
    for(const p of (j?.projects||[])) if(valid(p?.token)) map.set(p.token.toLowerCase(),p);
    return map;
  }).catch(()=>new Map());
  return profilesPromise;
}
async function rpc(method,params){
  const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  if(!r.ok) throw Error(`RPC ${r.status}`);
  const j=await r.json();
  if(j.error) throw Error(j.error.message||'RPC error');
  return j.result;
}
function decodeAbiString(hex){
  if(!hex||hex==='0x') return '';
  const raw=hex.slice(2);
  try{
    if(raw.length===64){
      const bytes=raw.match(/.{2}/g)||[];
      return new TextDecoder().decode(new Uint8Array(bytes.map(x=>parseInt(x,16)))).replace(/\0+$/,'').trim();
    }
    const offset=parseInt(raw.slice(0,64),16)*2;
    const len=parseInt(raw.slice(offset,offset+64),16);
    const data=raw.slice(offset+64,offset+64+len*2);
    const bytes=data.match(/.{2}/g)||[];
    return new TextDecoder().decode(new Uint8Array(bytes.map(x=>parseInt(x,16)))).replace(/\0+$/,'').trim();
  }catch{return '';}
}
async function resolve(address){
  const key=String(address).toLowerCase();
  if(caches.resolve.has(key)) return caches.resolve.get(key);
  let out=null;
  try{ out=await fetchJson(`${API}/launches/${address}`); }catch{}
  caches.resolve.set(key,out);
  return out;
}
async function chainMeta(address){
  const key=String(address).toLowerCase();
  if(caches.meta.has(key)) return caches.meta.get(key);
  let name='',symbol='';
  try{
    const [n,s]=await Promise.all([
      rpc('eth_call',[{to:address,data:'0x06fdde03'},'latest']).catch(()=>null),
      rpc('eth_call',[{to:address,data:'0x95d89b41'},'latest']).catch(()=>null)
    ]);
    name=safeName(decodeAbiString(n));
    symbol=safeSymbol(decodeAbiString(s));
  }catch{}
  const meta={address,name:safeName(name)||safeSymbol(symbol)||'Token',symbol:safeSymbol(symbol)||'TOKEN'};
  caches.meta.set(key,meta);
  return meta;
}
async function metaFor(address,launch,hintSymbol=''){
  const a=address||tokenAddr(launch);
  const profileMap=await profiles();
  const profile=valid(a)?profileMap.get(a.toLowerCase()):null;
  let base=null;
  if(launch){
    base={address:a,name:safeName(launch.name||launch.tokenName)||tokenSym(launch),symbol:tokenSym(launch)};
  }
  if(!base||base.symbol==='TOKEN') base=valid(a)?await chainMeta(a):{address:a,name:hintSymbol||'Token',symbol:hintSymbol||'TOKEN'};
  if(hintSymbol && (!base.symbol||base.symbol==='TOKEN')) base.symbol=hintSymbol;
  if(profile?.profile?.name) base.name=profile.profile.name;
  return {...base,profile:profile||null,isLaunch:Boolean(launch)};
}
async function fetchRecent(){
  if(recentPromise) return recentPromise;
  recentPromise=(async()=>{
    // Preferred path: a cached Netlify function pages the complete PAR launch history.
    try{
      const body=await fetchJson('/api/par-launches-all');
      const list=rows(body);
      if(list.length){
        historyCoverage={mode:'full',count:Number(body?.count||list.length),indexed:list.length};
        return list.slice(0,MAX_HISTORY);
      }
    }catch{}
    // Local/static fallback: page PAR directly. This keeps the Map complete even outside Netlify.
    try{
      const countBody=await fetchJson(`${API}/launches/count`);
      const count=Number(countBody?.count??countBody?.total??countBody??0)||0;
      const target=Math.min(MAX_HISTORY,count||PAGE_SIZE);
      const offsets=[];for(let o=0;o<target;o+=PAGE_SIZE)offsets.push(o);if(!offsets.length)offsets.push(0);
      const pages=await Promise.all(offsets.map(o=>fetchJson(`${API}/launches?orderBy=createdAt&orderDirection=desc&limit=${PAGE_SIZE}&offset=${o}`)));
      const list=pages.flatMap(rows);
      if(list.length){historyCoverage={mode:'full-direct',count:count||list.length,indexed:list.length};return list.slice(0,MAX_HISTORY);}
    }catch{}
    // Last-resort recent window. UI explicitly discloses degraded coverage.
    const body=await fetchJson(`${API}/launches?orderBy=createdAt&orderDirection=desc&limit=${FALLBACK_LIMIT}`);
    const list=rows(body).slice(0,FALLBACK_LIMIT);
    historyCoverage={mode:'fallback',count:list.length,indexed:list.length};
    return list;
  })().catch(e=>{recentPromise=null;historyCoverage={mode:'unavailable',count:0,indexed:0};throw e;});
  return recentPromise;
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length); let i=0;
  async function worker(){
    while(i<items.length){
      const idx=i++;
      try{ out[idx]=await fn(items[idx],idx); }catch{ out[idx]=null; }
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  return out;
}
async function detailedRecent(){
  const base=await fetchRecent();
  const unique=[]; const seen=new Set();
  for(const row of base){
    const a=tokenAddr(row);
    if(!valid(a)||seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    unique.push(row);
  }
  // PAR launch-list rows normally include market data. Avoid turning a complete-history scan
  // into 1,000+ per-token requests; root details are resolved lazily when a token is opened.
  return unique;
}
function coverageText(){
  if(historyCoverage.mode==='full'||historyCoverage.mode==='full-direct') return `Indexed ${historyCoverage.indexed.toLocaleString()} current PAR launch records.`;
  if(historyCoverage.mode==='fallback') return `Degraded mode: only the ${historyCoverage.indexed} most recent PAR launch records are currently indexed.`;
  return 'PAR launch-history coverage is temporarily unavailable.';
}
function usageMap(recent){
  const map=new Map();
  for(const d of recent) for(const m of markets(d)){const a=pairAddr(m);if(valid(a)){const k=a.toLowerCase();map.set(k,(map.get(k)||0)+1)}}
  return map;
}
function uniqByAddress(list){
  const seen=new Set(),out=[];
  for(const x of list){
    if(!valid(x.address)) continue;
    const k=x.address.toLowerCase();
    if(seen.has(k)) continue;
    seen.add(k);out.push(x);
  }
  return out;
}
// Map labels never claim verification: provenance is checked live on the Registry and project pages.
// Canonical identity is matched by contract address only (M4).
function provenance(meta){
  const r=meta?.profile?.registry||{};
  const canonical=r.canonical===true&&same(meta?.profile?.token,meta?.address);
  if(r.status==='origin'&&canonical) return {label:`SYNCNET ORIGIN${r.id?' · '+r.id.replace('SYNCNET-','#'):''}`,cls:'origin'};
  if(r.status==='network'&&canonical) return {label:'SYNCNET NETWORK ASSET',cls:'network'};
  if(r.status==='origin') return {label:'SYNCNET ORIGIN',cls:'origin'};
  if(meta?.profile) return {label:'SYNCNET PROFILE · SEE REGISTRY',cls:'profile'};
  if(impostorOf(meta)) return {label:'NOT THE CANONICAL $'+impostorOf(meta),cls:'impostor'};
  return {label:meta?.isLaunch===false?'INDEXED MARKET ASSET':'PAR INDEXED',cls:'auto'};
}
function skeleton(v){const C=window.SyncNetCore;return C?C.confusableSkeleton(String(v||'')):String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'')}
function impostorOf(meta){if(!meta||!valid(meta.address))return'';for(const [addr,c] of CANONICAL){if(same(addr,meta.address))return'';const sym=c.symbol||'';if(sym&&skeleton(meta.symbol)===skeleton(sym))return sym}return''}
function provenanceMarkup(meta){const p=provenance(meta);return `<em class="node-status ${p.cls}">${p.label}</em>`;}
function node(meta,kind=''){
  const label=meta.symbol&&meta.symbol!=='TOKEN'?`$${meta.symbol}`:(meta.name||short(meta.address));
  return `<a class="topology-node ${kind}" href="/network.html?token=${encodeURIComponent(meta.address)}"><strong>${esc(label)}</strong><span>${esc(short(meta.address))}</span>${provenanceMarkup(meta)}</a>`;
}
function branchCard(x){
  const via=x.via?.symbol&&x.via.symbol!=='TOKEN'?`$${x.via.symbol}`:short(x.via?.address);
  const label=x.symbol&&x.symbol!=='TOKEN'?`$${x.symbol}`:(x.name||short(x.address));
  return `<a class="branch-chip" href="/network.html?token=${encodeURIComponent(x.address)}"><strong>${esc(label)}</strong><span>shares ${esc(via)} · ${esc(provenance(x).label)}</span></a>`;
}
function setProfileState(meta){
  const el=$('profileState');if(!el)return;
  const p=provenance(meta);
  if(p.cls==='origin') el.innerHTML=`<strong>${esc(p.label)}</strong> · Recorded SyncNet origin provenance. Connected markets still do not imply affiliation with those token teams.`;
  else if(p.cls==='network') el.innerHTML='<strong>SYNCNET NETWORK ASSET</strong> · Canonical SyncNet asset record. Market edges still do not imply affiliation with other token teams.';
  else if(p.cls==='built') el.innerHTML='<strong>BUILT WITH SYNCNET</strong> · Signed SyncNet launch provenance. Connected markets still do not imply affiliation.';
  else if(p.cls==='verified') el.innerHTML='<strong>VERIFIED PROFILE</strong> · Profile provenance verified by SyncNet. This does not imply affiliation with connected tokens.';
  else if(p.cls==='profile') el.innerHTML='<strong>SYNCNET PROFILE</strong> · Profile metadata is present, but launch provenance is not recorded. Market edges are still read independently.';
  else el.innerHTML='<strong>INDEXED FROM CHAIN</strong> · Observable PAR/on-chain market data only. No SyncNet launch provenance, verification, endorsement or project affiliation is inferred.';
  el.className='profile-state '+p.cls;
}
async function loadTopology(address,opts={}){
  const reveal_=opts.reveal!==false;
  if(!valid(address)){
    if($('searchStatus')){$('searchStatus').className='asset-status fail';$('searchStatus').textContent='Paste a valid 0x… token contract.';}
    flashStatus();
    return;
  }
  const seq=++mapSeq;
  currentRoot=address;
  if($('tokenSearch')) $('tokenSearch').value=address;
  if($('searchStatus')){$('searchStatus').className='asset-status';$('searchStatus').textContent='Mapping live connections…';}
  if($('topologyGraph')) $('topologyGraph').innerHTML='<div class="network-empty">Reading live PAR connections…</div>';
  if($('sameBranch')) $('sameBranch').innerHTML='';
  if($('buildAround')) $('buildAround').href=`/build.html?with=${encodeURIComponent(address)}`;
  if($('openProjectPage')) $('openProjectPage').href=`/project/${encodeURIComponent(address)}`;
  if($('topologyTitle')) $('topologyTitle').innerHTML='MAPPING<br><span class="cyan">CONNECTIONS…</span>';
  if($('topologyMeta')) $('topologyMeta').textContent=`Reading PAR markets for ${short(address)}…`;
  const section=showTopologySection();
  if(section) section.setAttribute('aria-busy','true');
  // Move the user to the consequence immediately: the loading state lives where the result will appear.
  if(reveal_&&section) reveal(section,'start');

  try{
    const [rootLaunch,recent]=await Promise.all([resolve(address),detailedRecent(),profiles()]);
    if(seq!==mapSeq) return;
    const rootMeta=await metaFor(address,rootLaunch);
    const parents=[];
    if(rootLaunch){
      for(const m of markets(rootLaunch)){
        const a=pairAddr(m);
        if(valid(a)&&!same(a,address)) parents.push(await metaFor(a,null,pairSym(m)));
      }
    }

    const children=[];
    for(const d of recent){
      const a=tokenAddr(d);
      if(!valid(a)||same(a,address)) continue;
      if(markets(d).some(m=>same(pairAddr(m),address))) children.push(await metaFor(a,d));
    }

    const parentAll=uniqByAddress(parents),childAll=uniqByAddress(children);
    const parentUnique=parentAll.slice(0,8);
    const childUnique=childAll.slice(0,12);
    let rootCode=null;if(!rootLaunch){try{rootCode=await rpc('eth_getCode',[address,'latest'])}catch{}}
    const siblingRaw=[];
    const branchParents=parentUnique.filter(p=>!['ETH','WETH','USDG'].includes(String(p.symbol||'').toUpperCase()));
    if(branchParents.length){
      for(const d of recent){
        const a=tokenAddr(d);
        if(!valid(a)||same(a,address)||childUnique.some(c=>same(c.address,a))) continue;
        for(const p of branchParents){
          if(markets(d).some(m=>same(pairAddr(m),p.address))){
            siblingRaw.push({...await metaFor(a,d),via:p});
            break;
          }
        }
      }
    }
    const siblings=[]; const seenSib=new Set();
    for(const s of siblingRaw){
      const k=s.address.toLowerCase();
      if(seenSib.has(k)) continue;
      seenSib.add(k);siblings.push(s);
      if(siblings.length>=12) break;
    }

    if(seq!==mapSeq) return; // a newer MAP request superseded this one
    const rootLabel=rootMeta.symbol&&rootMeta.symbol!=='TOKEN'?`$${rootMeta.symbol}`:rootMeta.name;
    if($('topologyTitle')) $('topologyTitle').innerHTML=`${esc(rootLabel)}<br><span class="cyan">IN CONTEXT.</span>`;
    if($('topologyMeta')) $('topologyMeta').textContent=rootCode==='0x'?'No contract exists at this address on Robinhood Chain.':`${rootLaunch?parentAll.length+' direct market'+(parentAll.length===1?'':'s'):'Not a PAR launch'} · ${childAll.length} project${childAll.length===1?'':'s'} use${childAll.length===1?'s':''} it as a market${childAll.length>childUnique.length?` (showing ${childUnique.length})`:''}. ${coverageText()}`;
    if($('attentionQuery')) $('attentionQuery').value=rootMeta.name&&rootMeta.name!=='Token'?rootMeta.name:(rootMeta.symbol||'');
    setProfileState(rootMeta);

    const top=parentUnique.length?parentUnique.map(p=>node(p)).join(''):(rootLaunch?'<div class="topology-empty">No direct markets were found in this token’s PAR launch record.</div>':rootCode==='0x'?'<div class="topology-empty">No contract exists at this address on Robinhood Chain.</div>':'<div class="topology-empty">Not launched on PAR, so SyncNet cannot read this token’s own markets. The projects below use it as a market.</div>');
    const bottom=childUnique.length?childUnique.map(c=>node(c,'child')).join(''):'<div class="topology-empty">No projects using this contract as a market were found in the currently indexed PAR history.</div>';
    if($('topologyGraph')) $('topologyGraph').innerHTML=`
      <div class="topology-tree">
        <div class="topology-label">THIS TOKEN IS SYNCED WITH</div>
        <div class="topology-row">${top}</div>
        <div class="topology-line"><span>MARKET</span></div>
        <a class="topology-root" href="/project/${esc(address)}"><strong>${esc(rootLabel)}</strong><span>${esc(short(address))}</span>${provenanceMarkup(rootMeta)}</a>
        <div class="topology-line"><span>MARKET</span></div>
        <div class="topology-label">PROJECTS USING THIS TOKEN AS A MARKET</div>
        <div class="topology-row">${bottom}</div>
      </div>`;

    if($('sameBranch')){
      if(siblings.length){
        $('sameBranch').innerHTML=`<div class="same-branch-head"><span>NEIGHBOURS</span><p>Other projects sharing one of ${esc(rootLabel)}’s non-hub market connections. ETH, WETH and USDG are excluded here to reduce noise.</p></div><div class="branch-row">${siblings.map(branchCard).join('')}</div>`;
      }else{
        $('sameBranch').innerHTML='<div class="same-branch-head"><span>NEIGHBOURS</span><p>No additional projects sharing a non-hub first-degree market were found in the indexed history.</p></div>';
      }
    }

    const u=new URL(location.href);u.searchParams.set('token',address);history.replaceState(null,'',u);
    if($('searchStatus')){$('searchStatus').className='asset-status pass';$('searchStatus').textContent=`${rootLabel} mapped below. Market connection ≠ affiliation.`;}
    if(section) section.setAttribute('aria-busy','false');
    if(reveal_&&focusIsNearSearch()) focusQuietly($('topologyTitle'));
  }catch(e){
    if(seq!==mapSeq) return;
    if(section) section.setAttribute('aria-busy','false');
    if($('topologyTitle')) $('topologyTitle').innerHTML='TOPOLOGY<br><span class="cyan">UNAVAILABLE.</span>';
    if($('topologyMeta')) $('topologyMeta').textContent='The live indexer or RPC did not return enough data to map this contract right now.';
    if($('topologyGraph')) $('topologyGraph').innerHTML='<div class="network-empty">Live topology data is temporarily unavailable. No relationship has been inferred.</div>';
    if($('profileState')){$('profileState').className='profile-state';$('profileState').textContent='Profile state unavailable until the token can be mapped.';}
    if($('searchStatus')){$('searchStatus').className='asset-status fail';$('searchStatus').textContent='Live topology data is temporarily unavailable. Try again, or paste the contract.';}
    if(reveal_&&focusIsNearSearch()) focusQuietly($('topologyTitle'));
  }
}
async function searchTokens(raw){
  const seq=++searchSeq;
  setMapBusy(true);
  try{ await searchTokensInner(raw,seq); }
  finally{ if(seq===searchSeq) setMapBusy(false); }
}
async function searchTokensInner(raw,seq){
  const host=$('searchMatches');
  const q=String(raw||'').trim();
  if(host) host.innerHTML='';
  if(!q){
    if($('searchStatus')){$('searchStatus').className='asset-status';$('searchStatus').textContent='Enter a name, ticker, or 0x… contract.';}
    flashStatus();$('tokenSearch')?.focus();
    return;
  }
  if(valid(q)){ await loadTopology(q); return; }
  const normalized=cleanText(q).replace(/^\$/,'').toLowerCase();
  if(normalized.length>64){
    if($('searchStatus')){$('searchStatus').className='asset-status fail';$('searchStatus').textContent='Search terms are limited to 64 characters. Paste a contract address for an exact lookup.';}
    flashStatus();
    return;
  }
  if(normalized.length<2){
    if($('searchStatus')){$('searchStatus').className='asset-status fail';$('searchStatus').textContent='Type at least 2 characters, or paste a full contract.';}
    flashStatus();
    return;
  }
  if($('searchStatus')){$('searchStatus').className='asset-status';$('searchStatus').textContent='Searching Registry + canonical assets + full PAR market history…';}
  try{
    const [recent,profileMap,listed]=await Promise.all([detailedRecent(),profiles(),tokenList()]);
    if(seq!==searchSeq) return;
    const usage=usageMap(recent);
    const candidates=[]; const seen=new Set();
    const add=(address,name,symbol,profile=null,launch=null,source='indexed')=>{
      if(!valid(address)||same(address,ZERO)||seen.has(address.toLowerCase()))return;
      const cleanSym=safeSymbol(symbol);
      const cleanNm=safeName(name);
      // Ignore malformed/spam metadata rather than letting one adversarial symbol destroy the search UI.
      if(!cleanSym&&!cleanNm)return;
      const n=cleanNm.toLowerCase(),sy=cleanSym.toLowerCase();
      const exact=(sy===normalized||n===normalized);
      const prefix=(sy.startsWith(normalized)||n.startsWith(normalized));
      // Fuzzy substring matching is deliberately conservative. Symbols only match exact/prefix;
      // names with obvious keyword stuffing do not enter substring search.
      const wordCount=n?n.split(/\s+/).filter(Boolean).length:0;
      const contains=(normalized.length>=3)&&Boolean(n&&n.includes(normalized)&&wordCount<=6);
      if(!(exact||prefix||contains))return;
      seen.add(address.toLowerCase());
      const canonical=CANONICAL.get(address.toLowerCase())||(profile?.registry?.canonical?{rank:2,label:profile.registry.label||'RECORDED CANONICAL ASSET'}:null);
      candidates.push({address,name:cleanNm||cleanSym||'Token',symbol:cleanSym||'TOKEN',profile,launch,source,score:exact?0:prefix?1:2,canonical,usage:usage.get(address.toLowerCase())||0});
    };

    // 1) Recorded SyncNet projects: strongest human-readable source.
    for(const p of profileMap.values()){
      const d=await resolve(p.token).catch(()=>null);
      add(p.token,p.profile?.name||d?.name||d?.tokenName||'Project',d?tokenSym(d):(p.profile?.name||'TOKEN'),p,d,'registry');
    }

    // 2) PAR's complete token list (when reachable) covers names/tickers for PAR-launched assets beyond the recent discovery window.
    for(const t of listed){
      const a=t?.address||t?.token||t?.tokenAddress||'';
      add(a,t?.name||t?.symbol||'Token',t?.symbol||'TOKEN',profileMap.get(String(a).toLowerCase())||null,null,'par-tokenlist');
    }

    // 3) Recent launches AND both sides of their markets. This is important: an asset such as CASHCAT may be a quote/connection
    //    without itself being a PAR launch, so searching only launched tokens makes valid network nodes invisible by ticker.
    for(const d of recent){
      const a=tokenAddr(d);
      add(a,d.name||d.tokenName||tokenSym(d),tokenSym(d),profileMap.get(String(a).toLowerCase())||null,d,'par-launch');
      for(const m of markets(d)){
        const pa=pairAddr(m), ps=pairSym(m);
        if(valid(pa)&&!same(pa,ZERO)&&ps){
          add(pa,ps,ps,profileMap.get(String(pa).toLowerCase())||null,null,'market-asset');
        }
      }
    }
    candidates.sort((a,b)=>a.score-b.score||(a.canonical?.rank??99)-(b.canonical?.rank??99)||b.usage-a.usage||String(a.symbol).localeCompare(String(b.symbol)));
    const symbolCounts=new Map();for(const x of candidates){const k=String(x.symbol||'').toUpperCase();if(k&&k!=='TOKEN')symbolCounts.set(k,(symbolCounts.get(k)||0)+1)}
    const list=candidates.slice(0,8);
    if(!list.length){
      if($('topologyGraph'))$('topologyGraph').innerHTML='<div class="network-empty">No token mapped for this search.</div>';
      if($('topologyMeta'))$('topologyMeta').textContent='No indexed match. Paste a contract address for an authoritative lookup.';
      if($('searchStatus')){$('searchStatus').className='asset-status fail';$('searchStatus').textContent='No indexed name/ticker match found. Try a contract address for a direct lookup. Name/ticker search can still be ambiguous; contract lookup is authoritative.';}
      flashStatus();
      return;
    }
    const exacts=list.filter(x=>x.score===0);
    const keyOf=x=>`${String(x.symbol||'').toLowerCase()}|${String(x.name||'').toLowerCase()}`;
    const ambiguousExact=exacts.length===1&&candidates.some(x=>x.address.toLowerCase()!==exacts[0].address.toLowerCase()&&(String(x.symbol||'').toLowerCase()===String(exacts[0].symbol||'').toLowerCase()||String(x.name||'').toLowerCase()===String(exacts[0].name||'').toLowerCase()));
    if(seq!==searchSeq) return;
    if(exacts.length===1&&!ambiguousExact){ await loadTopology(exacts[0].address); return; }
    if($('searchStatus')){$('searchStatus').className='asset-status pass';$('searchStatus').textContent=`${list.length} possible match${list.length===1?'':'es'} found. Choose one to map.`;}
    if(host){
      host.innerHTML=list.map(x=>{const pv=provenance({profile:x.profile,address:x.address,symbol:x.symbol,isLaunch:Boolean(x.launch)});const label=x.symbol&&x.symbol!=='TOKEN'?`$${x.symbol}`:x.name;const status=x.canonical?.label||pv.label;const cls=x.canonical?'network':pv.cls;const use=x.usage?` · used by ${x.usage} market${x.usage===1?'':'s'}`:'';const sc=symbolCounts.get(String(x.symbol||'').toUpperCase())||0;const collision=sc>1?` · ${sc} tokens share this ticker`:'';return `<button class="search-match" type="button" data-map-address="${esc(x.address)}"><strong>${esc(label)}</strong><span>${esc(x.name)} · ${esc(short(x.address))}${esc(use)}${esc(collision)}</span><em class="node-status ${cls}">${esc(status)}</em></button>`}).join('');
      host.querySelectorAll('[data-map-address]').forEach(b=>b.addEventListener('click',()=>{host.innerHTML='';loadTopology(b.dataset.mapAddress)}));
      // Ambiguous: take the user to the chooser, not to a map SyncNet cannot pick authoritatively.
      host.setAttribute('aria-label','Possible matches — choose one to map');
      reveal(host,'nearest');
      focusQuietly(host.querySelector('[data-map-address]'));
    }
  }catch(e){
    if($('searchStatus')){$('searchStatus').className='asset-status fail';$('searchStatus').textContent='Search is temporarily unavailable. Paste a full contract for direct mapping, or try again.';}
    flashStatus();
  }
}
// Images: window.SyncNetIpfs is the one canonical renderer (Pinata → ipfs.io → dweb.link → placeholder).
function card(d){
  const token=tokenAddr(d),sym=tokenSym(d),name=safeName(d.name||d.tokenName)||sym||'Token',logoHtml=window.SyncNetIpfs.imgHtml(d.logoUrl||d.logo,{letter:(sym||'S').charAt(0)}),ms=markets(d);
  return `<article class="network-card"><div class="network-card-top"><div class="network-card-logo">${logoHtml||'SYNC'}</div><div><h3>${esc(name)}</h3><div class="ticker">$${esc(sym)}</div></div></div><div class="chip-row">${ms.map(m=>`<span class="chip">${esc(sym)} / ${esc(pairSym(m)||'TOKEN')}</span>`).join('')}</div><p>Observable market connection on PAR. No affiliation is implied.</p><div class="network-actions"><a class="btn primary" href="/network.html?token=${esc(token)}">MAP</a><a class="btn" href="/build.html?with=${esc(token)}">SYNC WITH IT</a></div></article>`;
}
async function loadRecentSync(){
  const grid=$('networkGrid');if(!grid)return;
  grid.innerHTML='<div class="network-empty">Reading live PAR markets…</div>';
  try{
    const recent=await detailedRecent(),out=[];
    for(const d of recent){
      // $SYNC is identified by its contract address only (M4): a token merely named SYNC is not the network asset.
      if(markets(d).some(m=>same(pairAddr(m),SYNC))) out.push(d);
      if(out.length>=9) break;
    }
    grid.innerHTML=out.length?out.map(card).join(''):`<div class="network-empty">No $SYNC-connected PAR launches were returned in the currently indexed PAR history.</div>`;
  }catch{
    grid.innerHTML='<div class="network-empty">Live network data is temporarily unavailable. On-chain markets are unaffected.</div>';
  }
}
async function loadRecentActivity(){
  const host=$('recentActivity');if(!host)return;
  try{
    const recent=await detailedRecent(),cut=Date.now()-7*24*60*60*1000,counts=new Map();
    for(const d of recent){const t=Date.parse(d?.createdAt||d?.created_at||'');if(Number.isFinite(t)&&t<cut)continue;for(const m of markets(d)){const a=pairAddr(m),sym=pairSym(m);if(!valid(a)||!sym||['ETH','WETH','USDG'].includes(sym))continue;const k=a.toLowerCase(),x=counts.get(k)||{address:a,symbol:sym,count:0};x.count++;counts.set(k,x)}}
    const top=[...counts.values()].sort((a,b)=>b.count-a.count||a.symbol.localeCompare(b.symbol)).slice(0,5);
    host.innerHTML=top.length?top.map(x=>`<a class="activity-card" href="/network.html?token=${esc(x.address)}"><strong>$${esc(x.symbol)}</strong><span>${x.count} new market${x.count===1?'':'s'} · MAP →</span></a>`).join(''):`<div class="network-empty">No non-hub market activity was returned for the last 7 days.</div>`;
  }catch{host.innerHTML='<div class="network-empty">Recent network activity is temporarily unavailable.</div>'}
}

async function loadRegistryPreview(){
  const grid=$('registryPreview');if(!grid)return;
  try{
    const map=await profiles(),items=[];
    for(const p of map.values()) if(['origin','network','built'].includes(p?.registry?.status)) items.push(p);
    if(!items.length){grid.innerHTML='<div class="network-empty">No recorded SyncNet projects yet.</div>';return;}
    const cards=await mapLimit(items.slice(0,6),4,async p=>{
      const d=await resolve(p.token),m=await metaFor(p.token,d),pv=provenance(m),sym=m.symbol&&m.symbol!=='TOKEN'?`$${m.symbol}`:(m.name||short(m.address));
      return `<article class="registry-mini"><div><span class="registry-status ${pv.cls}">${esc(pv.label)}</span><h3>${esc(sym)}</h3><p>${esc(short(p.token))}</p></div><div class="network-actions"><a class="btn primary" href="/network.html?token=${esc(p.token)}">MAP</a><a class="btn" href="/project/${esc(p.token)}">PROJECT</a></div></article>`;
    });
    grid.innerHTML=cards.filter(Boolean).join('');
  }catch{grid.innerHTML='<div class="network-empty">Registry preview is temporarily unavailable.</div>'}
}
function attentionQuery(){
  const input=$('attentionQuery');if(!input)return null;
  const q=input.value.trim();
  if(!q){
    const note=document.querySelector('.attention-note');if(note)note.innerHTML='<strong>Add a search term first.</strong> Use a project name, ticker or narrative.';
    return null;
  }
  return q;
}
function openExternal(url){
  const w=window.open(url,'_blank','noopener,noreferrer');
  if(w) w.opener=null;
}
$('mapToken')?.addEventListener('click',()=>searchTokens($('tokenSearch').value.trim()));
$('tokenSearch')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();if(!$('mapToken').disabled)$('mapToken').click();}});
$('refreshNetwork')?.addEventListener('click',()=>{recentPromise=null;loadRecentSync();});
$('openTrends')?.addEventListener('click',()=>{
  const q=attentionQuery();if(!q)return;
  const geo=$('attentionGeo').value,time=$('attentionTime').value;
  const params=new URLSearchParams({date:time,q});
  if(geo) params.set('geo',geo);
  openExternal(`https://trends.google.com/trends/explore?${params.toString()}`);
});
$('openXSearch')?.addEventListener('click',()=>{
  const q=attentionQuery();if(!q)return;
  openExternal(`https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`);
});
$('openNews')?.addEventListener('click',()=>{
  const q=attentionQuery();if(!q)return;
  openExternal(`https://www.google.com/search?tbm=nws&q=${encodeURIComponent(q)}`);
});

const initial=new URLSearchParams(location.search).get('token');
if($('topologyGraph')){
  // Arriving with ?token= (e.g. from a MAP link) is an explicit map request: show the result.
  if(valid(initial)) loadTopology(initial,{reveal:true});
  else if(document.body.dataset.topologyDemo!=='false') loadTopology(DEMO,{reveal:false});
}
loadRecentSync();
loadRegistryPreview();
loadRecentActivity();
})();
