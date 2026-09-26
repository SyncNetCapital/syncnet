(function(){
'use strict';
// SyncNet Project Kit — deterministic prompt builder. No AI runs here and nothing is sent anywhere
// except read-only PAR/chain lookups when the user presses LOAD FROM CHAIN.
const API='https://api.par.family',RPC='https://rpc.mainnet.chain.robinhood.com/';
const SITE='https://syncnet.capital';
const $=id=>document.getElementById(id);
const valid=a=>/^0x[a-fA-F0-9]{40}$/.test(String(a||'').trim());
const UNSAFE=/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const clean=(v,max=1500)=>String(v??'').replace(UNSAFE,'').trim().slice(0,max);
const line=v=>clean(v).replace(/\s+/g,' ');
const FIELDS=['kitName','kitSymbol','kitTagline','kitDescription','kitConnections','kitX','kitTelegram','kitLogo','kitAccent','kitTone','kitLang','kitToken'];
let kind='site';

function status(t,cls=''){$('kitStatus').className='asset-status'+(cls?' '+cls:'');$('kitStatus').textContent=t}
function toast(t){const el=$('toast');if(!el)return;el.textContent=t;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1400)}

function parseConnections(){
  const out=[],bad=[];
  for(const raw of clean($('kitConnections').value).split(/\n+/)){
    const l=raw.trim();if(!l)continue;
    const [sym,addr,...why]=l.split('|').map(x=>x.trim());
    const s=line(sym).replace(/^\$/,'').toUpperCase().slice(0,16);
    if(!s){bad.push(l);continue}
    const a=valid(addr)?addr.toLowerCase():'';
    if(addr&&!a)bad.push(l);
    out.push({symbol:s,address:a,reason:line(why.join('|')).slice(0,160)});
  }
  return {list:out.slice(0,5),bad,tooMany:out.length>5};
}
function xUrl(v){v=line(v);if(!v)return'';if(v.startsWith('@'))return'https://x.com/'+v.slice(1).replace(/[^A-Za-z0-9_]/g,'');try{const u=new URL(v);return /^(x|twitter)\.com$/.test(u.hostname.replace(/^www\./,''))?u.href:''}catch{return''}}
function httpsUrl(v){v=line(v);if(!v)return'';try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password?u.href:''}catch{return''}}
function imgUrl(v){v=line(v);if(!v)return'';if(/^ipfs:\/\/[A-Za-z0-9]+(\/[A-Za-z0-9._~\/-]+)?$/.test(v))return'https://gateway.pinata.cloud/ipfs/'+v.slice(7);return httpsUrl(v)}

function facts(){
  const token=valid($('kitToken').value)?$('kitToken').value.trim().toLowerCase():'';
  const c=parseConnections();
  return {
    name:line($('kitName').value).slice(0,40)||'YOUR PROJECT',
    symbol:line($('kitSymbol').value).replace(/^\$/,'').toUpperCase().slice(0,10)||'TICKER',
    tagline:line($('kitTagline').value).slice(0,140),
    description:clean($('kitDescription').value),
    connections:c.list,badConnections:c.bad,tooMany:c.tooMany,
    x:xUrl($('kitX').value),telegram:httpsUrl($('kitTelegram').value),
    logo:imgUrl($('kitLogo').value),logoUri:line($('kitLogo').value),
    accent:$('kitAccent').value,tone:$('kitTone').value,lang:$('kitLang').value,token,
  };
}
function declaration(f){
  return JSON.stringify({
    schema:'syncnet.site.v1',
    project:f.name,symbol:f.symbol,chainId:4663,
    token:f.token||null,
    syncnet:f.token?`${SITE}/project/${f.token}`:null,
    note:'Declares that this website belongs to the project above. SyncNet shows it as linked only when the token metadata points back to this site.'
  },null,2);
}
const RULES=f=>`NON-NEGOTIABLE RULES
- Use every contract address exactly as written here. Never invent, shorten or "fix" an address. ${f.token?'':'The token is NOT launched yet: do not show any contract address; show "Contract address: published at launch".'}
- Never invent numbers: no price, market cap, supply, APY, yield, holder count, roadmap dates or partnerships unless they appear in this brief.
- A market connection is NOT a partnership, endorsement, affiliation or shared team. Describe connections only as "has a direct market with <TOKEN>". Never write "official", "backed by", "partnered with" or "endorsed by" about a connected token or its team.
- No promises: no "guaranteed", "risk-free", "to the moon", price predictions or investment advice.
- No wallet connection, no "connect wallet" or "claim" buttons, no forms asking for seed phrases, private keys or personal data, no trackers, no external scripts, fonts or CDNs. Plain HTML + CSS only; JavaScript only if strictly needed and fully inline.
- Include this footer text: "Cryptoassets are volatile and may lose all value. Trading ${f.symbol} is risky. A market connection with another token does not imply endorsement. Nothing here is financial advice."`;

function connectionLines(f){return f.connections.length?f.connections.map(c=>`- ${f.symbol} / ${c.symbol}${c.address?` (contract ${c.address})`:''}${c.reason?` — why: ${c.reason}`:''}`).join('\n'):'- (no connections entered yet)'}
function linkLines(f){const l=[];if(f.token){l.push(`- Trade on PAR: https://par.family/token/${f.token}`);l.push(`- SyncNet project page: ${SITE}/project/${f.token}`);l.push(`- Explorer: https://robinhoodchain.blockscout.com/address/${f.token}`)}else l.push('- SyncNet: https://syncnet.capital (project page appears after launch)');if(f.x)l.push(`- X: ${f.x}`);if(f.telegram)l.push(`- Telegram: ${f.telegram}`);return l.join('\n')}
function brief(f){return `PROJECT BRIEF
Name: ${f.name}
Ticker: $${f.symbol}
Chain: Robinhood Chain (chain id 4663), launched through PAR${f.token?`\nToken contract: ${f.token}`:'\nStatus: not launched yet'}
One-line idea: ${f.tagline||'(not provided — ask me for one before writing)'}
Description:
${f.description||'(not provided — ask me for it before writing)'}
Connected to (direct markets opened by the PAR launch):
${connectionLines(f)}
Links:
${linkLines(f)}${f.logo?`\nProject image: ${f.logo}`:''}`}

const PROMPTS={
  site:{hint:'Returns a complete one-page website as a zip you can drop onto Netlify.',build:f=>`You are a senior web designer. Build a one-page website for a crypto project and give it to me as ONE downloadable .zip file.

${brief(f)}

DESIGN
- Tone: ${f.tone}. Language: ${f.lang}.
- Dark, clean and legible: near-black background, off-white text, accent colour ${f.accent}. Body text at least 16px, no text under 12px, strong contrast.
- Sections: hero (name, $${f.symbol}, one-line idea${f.logo?', project image':''}), About, "Connected to" (one card per connection, each saying "Direct market: ${f.symbol} / TOKEN" plus the reason), Links, and a risk footer.
- Mobile-first, no horizontal scrolling at 360px width, buttons at least 44px tall, visible keyboard focus, meaningful alt text.
- Fast: no frameworks, no web fonts from other domains, images compressed.

FILES IN THE ZIP (at the root, no extra folder)
- index.html
- style.css
- images/ (only if needed${f.logo?'; you may reference the project image by its URL instead':''})
- syncnet.json with EXACTLY this content:
${declaration(f)}

${RULES(f)}

Before giving me the zip, list every factual claim on the page next to its source line in the brief, so I can check it.`},
  description:{hint:'The token description is permanent on-chain. Ask for several short options and check every word.',build:f=>`Write 3 alternative descriptions for a token launch. Each at most 280 characters, in ${f.lang}, tone: ${f.tone}. This text will be stored permanently on-chain and can never be edited, so be precise and timeless (no dates, no "soon", no numbers that will change).

${brief(f)}

${RULES(f)}

After the 3 options, point out any word in them that could be read as a promise or an endorsement claim.`},
  connections:{hint:'Short, honest notes for why each connection exists. SyncNet commits them into your launch intent.',build:f=>`For each connection below, write one sentence (max 160 characters, ${f.lang}) explaining why ${f.name} ($${f.symbol}) opens a direct market with that token. These notes become part of a signed launch-intent record, so they must be factual and must not claim any relationship with the other token's team.

${connectionLines(f)}

Project idea: ${f.tagline||f.description.slice(0,300)||'(ask me)'}

${RULES(f)}`},
  announce:{hint:'A launch post for X. Post it yourself, from your own account.',build:f=>`Write a launch post for X in ${f.lang} (max 280 characters) and an optional 4-post thread for ${f.name} ($${f.symbol}). Tone: ${f.tone}.

${brief(f)}

Also: say where people can verify the contract (the SyncNet project page or explorer link above), and do not tag the teams of connected tokens as if they were involved.

${RULES(f)}`},
  listing:{hint:'Public text for a SyncNet Marketplace listing. Evidence levels are set by SyncNet, not by the text.',build:f=>`Write a public Marketplace listing description (max 420 characters, ${f.lang}) for selling the operational project ${f.name} ($${f.symbol}) — not the token.

${brief(f)}

Rules specific to listings:
- The token contract has no owner and is never sold. Say "the operating project" is being transferred.
- Do not claim that any asset (domain, repo, socials, fee rights) is included or verified; the listing's transfer package shows that separately.
- X accounts are not presented as saleable.

${RULES(f)}`},
};

function warnings(f){
  const w=[];
  if(f.name==='YOUR PROJECT')w.push('Add a project name.');
  if(!f.description&&!f.tagline)w.push('Add an idea or description — otherwise the AI will ask for one, or invent one.');
  if(f.badConnections.length)w.push('Some connection lines have an invalid contract address and were kept without it: '+f.badConnections.slice(0,2).join(' · '));
  if(f.tooMany)w.push('Only the first 5 connections are used — PAR allows at most 5 markets.');
  if(line($('kitX').value)&&!f.x)w.push('X link not recognised; use @handle or an x.com URL.');
  if(line($('kitTelegram').value)&&!f.telegram)w.push('Telegram link must be an https:// URL.');
  if(f.logoUri&&!f.logo)w.push('Image must be ipfs:// or https://.');
  if($('kitToken').value.trim()&&!f.token)w.push('Token contract is not a valid 0x address; the prompts treat the project as not launched.');
  return w;
}
function render(){
  const f=facts();
  $('kitPrompt').value=PROMPTS[kind].build(f);
  $('kitPromptHint').textContent=PROMPTS[kind].hint;
  $('kitDeclaration').value=declaration(f);
  const w=warnings(f);
  $('kitWarnings').innerHTML='';
  if(w.length){const ul=document.createElement('ul');for(const t of w){const li=document.createElement('li');li.textContent=t;ul.append(li)}$('kitWarnings').append(ul)}
  const pl=$('kitProjectLink');if(f.token){pl.hidden=false;pl.href='/project/'+f.token}else pl.hidden=true;
  try{localStorage.setItem('syncnet_kit_state',JSON.stringify(Object.fromEntries(FIELDS.map(id=>[id,$(id).value]))))}catch{}
}
function setKind(k,focus=false){
  kind=PROMPTS[k]?k:'site';
  document.querySelectorAll('.kit-tab').forEach(b=>{const on=b.dataset.kind===kind;b.classList.toggle('active',on);b.setAttribute('aria-selected',on?'true':'false');b.tabIndex=on?0:-1;if(on&&focus)b.focus()});
  $('kitPromptPanel').setAttribute('aria-labelledby','kt-'+kind);
  $('kitCopyStatus').textContent='';
  render();
}
async function copy(text,statusEl){
  try{if(!navigator.clipboard)throw Error('no clipboard');await Promise.race([navigator.clipboard.writeText(text),new Promise((_,rej)=>setTimeout(()=>rej(Error('clipboard timeout')),1500))]);statusEl.className='asset-status pass';statusEl.textContent='Copied ✓ Paste it into your AI.';toast('Copied')}
  catch{const t=$('kitPrompt');t.focus();t.select();statusEl.className='asset-status';statusEl.textContent='Select all (Ctrl/Cmd+A) and copy manually.'}
}
async function rpc(method,params){const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(!r.ok)throw Error('RPC unavailable');const j=await r.json();if(j.error)throw Error(j.error.message||'RPC error');return j.result}
function decodeStr(hex){try{const raw=String(hex||'').slice(2);if(!raw)return'';const off=parseInt(raw.slice(0,64),16)*2,len=parseInt(raw.slice(off,off+64),16),data=raw.slice(off+64,off+64+len*2);return new TextDecoder().decode(new Uint8Array((data.match(/.{2}/g)||[]).map(x=>parseInt(x,16))))}catch{return''}}
async function load(){
  const a=$('kitToken').value.trim();
  if(!valid(a)){status('Paste a valid 0x token contract.','fail');return}
  const btn=$('kitLoad');btn.disabled=true;status('Reading PAR…');
  try{
    let d=null;try{const r=await fetch(`${API}/launches/${a}`,{cache:'no-store'});if(r.ok)d=await r.json()}catch{}
    let name=line(d?.name||''),symbol=line(d?.symbol||'').replace(/^\$/,''),desc=clean(d?.description||''),logo=line(d?.logo||'');
    if(!name||!symbol){const [n,s]=await Promise.all([rpc('eth_call',[{to:a,data:'0x06fdde03'},'latest']).catch(()=>''),rpc('eth_call',[{to:a,data:'0x95d89b41'},'latest']).catch(()=>'')]);name=name||line(decodeStr(n));symbol=symbol||line(decodeStr(s))}
    if(!name&&!symbol)throw Error('No token data found for this contract.');
    if(name&&name.length<=40)$('kitName').value=name;
    if(symbol&&symbol.length<=10)$('kitSymbol').value=symbol.toUpperCase();
    if(desc&&!$('kitDescription').value.trim())$('kitDescription').value=desc;
    if(logo&&!$('kitLogo').value.trim())$('kitLogo').value=logo;
    const ms=Array.isArray(d?.markets)&&d.markets.length?d.markets:[];
    if(ms.length&&!$('kitConnections').value.trim())$('kitConnections').value=ms.slice(0,5).map(m=>`${line(m.quoteSymbol||m.pairSymbol||'TOKEN').toUpperCase().slice(0,16)} | ${valid(m.pairToken)?m.pairToken:''} | `).join('\n');
    status(d?'Loaded from PAR ✓ Check every field — the prompts reuse them verbatim.':'Loaded name and ticker from chain ✓ (not a PAR launch in the index).','pass');
    render();
  }catch(e){status(String(e.message||e),'fail')}finally{btn.disabled=false}
}
function restore(){
  let used=false;
  try{const d=JSON.parse(localStorage.getItem('syncnet_kit_draft')||'null');if(d&&Date.now()-Number(d.at||0)<3600e3){
    const set=(id,v)=>{if(v)$(id).value=String(v)};
    set('kitName',d.name);set('kitSymbol',d.symbol);set('kitDescription',d.description);set('kitX',d.x);set('kitLogo',d.logo);
    if(Array.isArray(d.connections))$('kitConnections').value=d.connections.slice(0,5).map(c=>`${line(c.symbol)} | ${valid(c.address)?c.address:''} | ${line(c.intent||'')}`).join('\n');
    localStorage.removeItem('syncnet_kit_draft');used=true;
    const n=$('kitDraftNote');n.hidden=false;n.textContent='Filled from your SyncNet builder draft. Changes here do not change the builder.';
  }}catch{}
  if(!used){try{const s=JSON.parse(localStorage.getItem('syncnet_kit_state')||'null');if(s)for(const id of FIELDS)if(typeof s[id]==='string'&&$(id))$(id).value=s[id]}catch{}}
  const q=new URL(location.href).searchParams.get('token');if(valid(q)){$('kitToken').value=q;load()}
}
FIELDS.forEach(id=>$(id)?.addEventListener('input',render));
FIELDS.forEach(id=>$(id)?.addEventListener('change',render));
document.querySelectorAll('.kit-tab').forEach((b,i,all)=>{b.addEventListener('click',()=>setKind(b.dataset.kind));b.addEventListener('keydown',e=>{const tabs=[...all];let k=null;if(e.key==='ArrowRight')k=(i+1)%tabs.length;else if(e.key==='ArrowLeft')k=(i-1+tabs.length)%tabs.length;else if(e.key==='Home')k=0;else if(e.key==='End')k=tabs.length-1;if(k===null)return;e.preventDefault();setKind(tabs[k].dataset.kind,true)})});
$('kitCopy').addEventListener('click',()=>copy($('kitPrompt').value,$('kitCopyStatus')));
$('kitLoad').addEventListener('click',load);
$('kitToken').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();load()}});
$('kitDownloadDecl').addEventListener('click',()=>{const b=new Blob([$('kitDeclaration').value+'\n'],{type:'application/json'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='syncnet.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)});
restore();render();
})();
