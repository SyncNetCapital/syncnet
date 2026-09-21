// SyncNet v1.1.7 Network launch runtime. Transaction submission is disabled; launch-controller.js handles simulation and legacy receipt recovery.
(function(){

const SYNC="0x6368e007b9f0b941560ed1f3bceb20247f5eca37";
const USDG="0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const API_BASE="https://api.par.family";
const SYNCNET_REGISTRY_URL="/syncnet-projects.json";
const RPC_URL="https://rpc.mainnet.chain.robinhood.com/";
const RH_CHAIN_HEX="0x1237";
const MULTI_FACTORY="0x3ea29975a79900179F3e1aEF93347Ba4210c29C1";
const QUOTE_PRICER="0x9EfC6EFA4c5F31e2BEC6CC174Ba7bB8f0b57d563";
const HOLDER_VAULT="0x4B79B8298cd890A82dC9De1dE5dBb745Cf04353C";
const ZERO32="0x"+"00".repeat(32);
const INITIAL_SYNC_SUPPLY_RAW=1_000_000_000n*10n**18n;
let bannerData="", launchCardData="";
let creatorTax=1, syncUsd=null, externalSymbol="ASSET", externalEligible=null, syncEligible=null, usdgEligible=null, holderCount=null, connectedAddress=null, selectedProvider=null, viemModule=null, identityData="", mode="network";
const SYNCABLE_ASSET_CHAIN_ID=4663;
let syncableAsset={address:"",chainId:SYNCABLE_ASSET_CHAIN_ID,symbol:"ASSET",name:"",decimals:null,contractVerified:false,quoteEligible:null,policyStatus:"not-evaluated"};
function resetSyncableAsset(address=""){syncableAsset={address,chainId:SYNCABLE_ASSET_CHAIN_ID,symbol:"ASSET",name:"",decimals:null,contractVerified:false,quoteEligible:null,policyStatus:"not-evaluated"};externalSymbol="ASSET";externalEligible=null}

const $=id=>document.getElementById(id);
function formatPrice(n){if(!Number.isFinite(n)||n<=0)return"—";if(n>=1)return"$"+n.toLocaleString("en-US",{maximumFractionDigits:4});if(n>=.01)return"$"+n.toFixed(5).replace(/0+$/,'').replace(/\.$/,'');if(n>=.0001)return"$"+n.toFixed(7).replace(/0+$/,'').replace(/\.$/,'');return"$"+n.toPrecision(5)}
function formatTokenAmount(n,max=2){if(!Number.isFinite(n))return"—";return n.toLocaleString("en-US",{maximumFractionDigits:max})}
function formatRaw(raw,decimals,maxFraction=3){try{const n=BigInt(raw||0),base=10n**BigInt(decimals),whole=n/base,rem=n%base;let frac=rem.toString().padStart(decimals,"0").slice(0,maxFraction).replace(/0+$/,"");return whole.toLocaleString("en-US")+(frac?"."+frac:"")}catch{return"—"}}
async function getViem(){if(!viemModule)viemModule=await import("/vendor/viem.js");return viemModule}
function status(el,text,cls=""){el.textContent=text;el.className="status"+(cls?" "+cls:"")}
async function loadSyncData(){
  try{const r=await fetch(`${API_BASE}/launches/${SYNC}`,{cache:"no-store"});if(!r.ok)throw 0;const d=await r.json();const markets=Array.isArray(d.markets)?d.markets:[];syncUsd=null;const usd=markets.find(m=>String(m.quoteSymbol||"").toUpperCase()==="USDG")||(String(d.quoteSymbol||"").toUpperCase()==="USDG"?d:null);if(usd&&!usd.lastPriceEthStale){syncUsd=Number.parseFloat(String(usd.lastPriceQuoteX18))/10**Number(usd.quoteDecimals??18);if(!Number.isFinite(syncUsd)||syncUsd<=0)throw new Error("Price unavailable");$("syncPrice").textContent=formatPrice(syncUsd);$("statPrice").textContent=formatPrice(syncUsd)}else throw new Error("Price unavailable");renderSyncFee()}catch{syncUsd=null;renderSyncFee();$("syncPrice").textContent="unavailable";$("statPrice").textContent="—"}
  try{const r=await fetch(`${API_BASE}/distributions?token=${SYNC}`,{cache:"no-store"});if(r.ok){const d=await r.json();const t=Array.isArray(d.totals)?d.totals:[];const net=t.find(x=>String(x.symbol||"").toUpperCase()==="NET"),usdg=t.find(x=>String(x.symbol||"").toUpperCase()==="USDG");$("netDistributed").textContent=net?formatRaw(net.amount??net.total??net.rawAmount,Number(net.decimals??18),2)+" NET":"—";$("usdgDistributed").textContent=usdg?formatRaw(usdg.amount??usdg.total??usdg.rawAmount,Number(usdg.decimals??18),2)+" USDG":"—"}}
  catch{}
}
const PRICER_ABI=[{type:"function",name:"isPriceable",stateMutability:"view",inputs:[{name:"quoteToken",type:"address"}],outputs:[{type:"bool"}]}];
let quoteStatus="checking", quoteRequest=0, assetRequest=0, checkRevision=0, reviewRequest=0;
async function publicClient(){const {createPublicClient,http,defineChain}=await getViem();const chain=defineChain({id:4663,name:"Robinhood Chain",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:{default:{http:[RPC_URL]}}});const c=createPublicClient({chain,transport:http(RPC_URL,{timeout:15000,retryCount:1})});if(await c.getChainId()!==4663)throw new Error("Unexpected RPC network");return c}
async function refreshQuotes(){
 const request=++quoteRequest;
 try{
  const c=await publicClient();
  await Promise.allSettled([[SYNC,"sync"],[USDG,"usdg"]].map(async([address,key])=>{
   let result=null;try{result=await c.readContract({address:QUOTE_PRICER,abi:PRICER_ABI,functionName:"isPriceable",args:[address]})}catch{}
   if(request!==quoteRequest)return;
   if(key==="sync"){const previous=syncEligible;syncEligible=result;quoteStatus=result===true?"ready":result===false?"ineligible":"error";if(previous!==result&&mode==="network")resetChecks();renderNetworkAvailability()}
   else{if(usdgEligible!==result&&mode==="usdg")resetChecks();usdgEligible=result;updateReview()}
  }));
 }catch{if(request!==quoteRequest)return;syncEligible=null;usdgEligible=null;quoteStatus="error";resetChecks();renderNetworkAvailability()}
 return syncEligible;
}
async function loadChainState(){
 // A supply/fee failure must never override a successful QuotePricer result.
 const quotes=refreshQuotes();
 try{const c=await publicClient();await Promise.allSettled([
  (async()=>{try{const raw=await c.readContract({address:SYNC,abi:[{type:"function",name:"totalSupply",stateMutability:"view",inputs:[],outputs:[{type:"uint256"}]}],functionName:"totalSupply"});$("remainingSupply").textContent=formatRaw(raw,18,2)+" SYNC";$("syncBurned").textContent=formatRaw(INITIAL_SYNC_SUPPLY_RAW>raw?INITIAL_SYNC_SUPPLY_RAW-raw:0n,18,2)+" SYNC"}catch{$("remainingSupply").textContent="unavailable";$("syncBurned").textContent="unavailable"}})(),
  (async()=>{try{const fee=await c.readContract({address:MULTI_FACTORY,abi:[{type:"function",name:"launchFee",stateMutability:"view",inputs:[],outputs:[{type:"uint256"}]}],functionName:"launchFee"});$("parLaunchFee").textContent=fee===0n?"FREE":formatRaw(fee,18,8)+" ETH"}catch{$("parLaunchFee").textContent="unavailable"}})()
 ])}catch{}await quotes;
}
function renderNetworkAvailability(){
 const eligible=syncEligible===true;
 $("retryNetwork").hidden=quoteStatus!=="error";
 const label=eligible?"READY ✓":quoteStatus==="checking"?"CHECKING":syncEligible===false?"NOT YET SYNCABLE":"STATUS UNAVAILABLE";
 $("chainChip").textContent="SYNC quote · "+label;$("chainChip").classList.toggle("pass",eligible);
 $("networkModeState").textContent=label;
 const button=$("networkModeBtn");button.disabled=!eligible;button.setAttribute("aria-disabled",String(!eligible));button.setAttribute("aria-pressed",String(mode==="network"));
 button.querySelector("span").textContent="Asset + SYNC · FREE · SIMULATION · "+label;
 const note=eligible?"SYNC is ready for Network Sync simulation. Transaction execution is disabled in this public beta.":syncEligible===false?"Live PAR quote eligibility is not currently satisfied.":quoteStatus==="checking"?"Checking live availability…":"Unable to verify PAR quote eligibility. Try again.";
 button.title=note;$("networkGateText").textContent=note;$("networkLiveStatus").textContent=label+" · "+note;
 // Preserve the selected mode. Never silently switch the user's economics.
 updateReview();refreshProductPreview();
}
$("retryNetwork").onclick=async()=>{const b=$("retryNetwork");b.disabled=true;try{await refreshQuotes()}finally{b.disabled=false}};
function renderSyncFee(){
  if(mode==="network"){
    $("syncingFee").textContent="FREE";
    $("syncingFeeNote").textContent="Network Sync uses SYNC as the second market, so SyncNet's platform fee is zero.";
    $("reviewBurn").textContent="FREE";
    return;
  }
  $("reviewBurn").textContent="≈ $20 IN SYNC";
  if(syncUsd&&syncUsd>0){
    const qty=20/syncUsd;
    $("syncingFee").textContent=`~${formatTokenAmount(qty,0)} SYNC ≈ $20`;
    $("syncingFeeNote").textContent=`Calculated from the live SYNC / USDG price (${formatPrice(syncUsd)}) for preview. Production must recompute the required SYNC amount on-chain at execution time; the browser value is never authoritative. Economic design: 100% burn, 0% treasury allocation. Burn execution is disabled in this release candidate.`;
  }else{
    $("syncingFee").textContent="STATUS UNAVAILABLE";$("syncingFeeNote").textContent="Unable to calculate the $20 SYNC fee from the live price. No fee is collected in test mode.";
  }
}
function identityReady(){return !!$("tokenName").value.trim()&&$("tokenName").value.trim().length<=40&&/^[A-Z0-9]{1,10}$/.test($("ticker").value.trim().toUpperCase())}
function updateReview(){
  updateIdentityStatus();$("reviewHomeState").textContent=identityReady()?"PREVIEW READY ✓":"not ready";$("reviewKitState").textContent=identityReady()?"READY ✓ · DRAFT":"not ready";
  $("secondQuoteLabel").textContent=(mode==="network"?"SYNC":"USDG")+" quote";$("burnExecution").textContent=mode==="network"?"N/A · FREE":"NOT WIRED / TEST MODE";$("homeModeSummary").textContent=(mode==="network"?"NETWORK SYNC":"STABLE SYNC")+" · Synced through SyncNet.";
  const name=$("tokenName").value.trim()||"TOKEN",sym=($("ticker").value.trim()||"TOKEN").toUpperCase();
  $("reviewName").textContent=name;
  $("reviewSymbol").textContent="$"+sym;
  $("reviewMode").textContent=mode==="usdg"?"STABLE SYNC":"NETWORK SYNC";
  $("reviewSyncedWith").textContent=(externalSymbol||"ASSET").toUpperCase();$("reviewIdentityState").textContent=identityReady()?"READY ✓":"not ready";$("reviewMarket1").textContent=sym+" / "+(externalSymbol||"ASSET").toUpperCase();
  $("reviewMarket2").textContent=sym+" / "+(mode==="usdg"?"USDG":"SYNC");
  $("reviewTax").textContent=creatorTax+"%";
  $("reviewQuote").textContent=externalEligible===true?`${externalSymbol} ✓ · ${mode==="usdg"?(usdgEligible===true?"USDG ✓":"USDG NOT READY"):(syncEligible===true?"SYNC ✓":"SYNC NOT READY")}`:"not checked";
  renderSyncFee();
}
["tokenName","ticker","description","xField","websiteField"].forEach(id=>$(id).addEventListener("input",updateReview));
$("usdgModeBtn").onclick=()=>{assetRequest++;mode="usdg";$("usdgModeBtn").classList.add("active");$("networkModeBtn").classList.remove("active");resetChecks();updateReview();refreshProductPreview()};
$("networkModeBtn").onclick=()=>{if(syncEligible!==true)return;assetRequest++;mode="network";$("networkModeBtn").classList.add("active");$("usdgModeBtn").classList.remove("active");resetChecks();updateReview();refreshProductPreview()};
document.querySelectorAll(".fee-choice").forEach(b=>b.onclick=()=>{document.querySelectorAll(".fee-choice").forEach(x=>x.classList.remove("active"));b.classList.add("active");creatorTax=Number(b.dataset.tax);resetChecks();$("creatorTaxOut").textContent=creatorTax.toFixed(1)+"%";$("totalFeeOut").textContent=(1+creatorTax).toFixed(1)+"%";updateReview();refreshProductPreview()});
function xUrl(v){return window.SyncNetServices.xLink(v)}
function websiteUrl(v){return window.SyncNetServices.website(v)}
async function checkExternal(){
  const request=++assetRequest,selectedMode=mode;const current=()=>request===assetRequest&&selectedMode===mode&&$("externalToken").value.trim()===a;
  const a=$("externalToken").value.trim();
  resetSyncableAsset(a);
  if(!/^0x[a-fA-F0-9]{40}$/.test(a)){
    $("assetStatus").className="asset-status fail";
    $("assetStatus").textContent="That is not a valid EVM contract address.";
    updateReview();return false;
  }
  const second=(mode==="usdg"?USDG:SYNC);
  if(a.toLowerCase()===second.toLowerCase()){
    $("assetStatus").className="asset-status fail";
    $("assetStatus").textContent=`The syncable asset cannot be the same token as the second connection (${mode==="usdg"?"USDG":"SYNC"}). PAR multi-market launches do not allow duplicate quote assets.`;
    updateReview();return false;
  }
  $("assetStatus").className="asset-status";
  $("assetStatus").textContent="Checking contract, chain and live PAR compatibility…";
  try{
    const {createPublicClient,http,defineChain}=await getViem();
    const chain=defineChain({id:SYNCABLE_ASSET_CHAIN_ID,name:"Robinhood Chain",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:{default:{http:[RPC_URL]}}});
    const c=createPublicClient({chain,transport:http(RPC_URL,{timeout:15000,retryCount:1})});
    if(await c.getChainId()!==4663)throw new Error("Unexpected RPC network");
    const code=await c.getBytecode({address:a});
    if(!code||code==="0x")throw new Error("No contract exists at that address on Robinhood Chain.");
    const pricerAbi=[{type:"function",name:"isPriceable",stateMutability:"view",inputs:[{name:"quoteToken",type:"address"}],outputs:[{name:"",type:"bool"}]}];
    const erc=[
      {type:"function",name:"symbol",stateMutability:"view",inputs:[],outputs:[{type:"string"}]},
      {type:"function",name:"name",stateMutability:"view",inputs:[],outputs:[{type:"string"}]},
      {type:"function",name:"decimals",stateMutability:"view",inputs:[],outputs:[{type:"uint8"}]}
    ];
    let symbol="ASSET",name="",decimals=null;
    symbol=await c.readContract({address:a,abi:erc,functionName:"symbol"});
    name=await c.readContract({address:a,abi:erc,functionName:"name"});
    try{decimals=Number(await c.readContract({address:a,abi:erc,functionName:"decimals"}))}catch{}
    if(decimals===null||!Number.isInteger(decimals)||decimals<0||decimals>255)throw new Error("This contract does not expose standard ERC-20 decimals and cannot be treated as a syncable asset.");
    const quoteEligible=await c.readContract({address:QUOTE_PRICER,abi:pricerAbi,functionName:"isPriceable",args:[a]});
    if(!current())return false;
    syncableAsset={address:a,chainId:SYNCABLE_ASSET_CHAIN_ID,symbol:String(symbol||"ASSET"),name:String(name||""),decimals,contractVerified:true,quoteEligible:Boolean(quoteEligible),policyStatus:"test-mode"};
    externalSymbol=syncableAsset.symbol;
    externalEligible=syncableAsset.quoteEligible;
    $("assetStatus").className="asset-status "+(externalEligible?"pass":"fail");
    $("assetStatus").textContent=externalEligible
      ?`${externalSymbol} · READY ✓ — contract verified on Robinhood Chain and currently accepted by PAR’s quote pricer.`
      :`${externalSymbol} · NOT YET SYNCABLE — the contract exists, but PAR’s quote pricer does not currently accept it.`;
    updateReview();refreshProductPreview();return externalEligible;
  }catch(e){
    if(!current())return false;
    resetSyncableAsset(a);
    $("assetStatus").className="asset-status fail";
    const msg=String(e?.shortMessage||e?.message||e||"");
    $("assetStatus").textContent=msg.includes("No contract exists")||msg.includes("standard ERC-20")?msg:"STATUS UNAVAILABLE · Could not verify this asset. Try again.";
    updateReview();return false;
  }
}
$("checkAssetBtn").onclick=checkExternal;
$("externalToken").addEventListener("input",()=>{assetRequest++;resetSyncableAsset($("externalToken").value.trim());$("assetStatus").className="asset-status";$("assetStatus").textContent="Address changed. Check whether this asset is syncable before continuing.";resetChecks();updateReview();refreshProductPreview()});
// Identity UI — creator-provided only in the public build.
let currentStage="combine",identityTagline="",identityLore="";
const stageOrder=["combine","identity","home","social","economics","review"];
const identityFields=["tokenName","ticker","identityTagline","description","identityLore"];
const manualAssetRevision={logoFile:0,bannerFile:0,launchCardFile:0};
function identityMessage(text){const el=$("manualIdentityStatus");if(el)el.textContent=text}
function updateIdentityStatus(){
 const persistence=$("identityPersistence");
 if(persistence){persistence.textContent="LOCAL PREVIEW · ON-CHAIN METADATA AT LAUNCH";persistence.className="status wait"}
 if($("reviewIdentitySource"))$("reviewIdentitySource").textContent="CREATOR PROVIDED";
 if($("identityAssetNote"))$("identityAssetNote").textContent="LOCAL PREVIEWS ONLY. Avatar, banner and launch card are not uploaded on-chain automatically. Review requires a persistent HTTPS/IPFS logo URL, or an explicit no-logo choice, before launch.";
 if($("avatarActionLabel"))$("avatarActionLabel").textContent=identityData?"Change avatar":"Add avatar";
}
function renderIdentity(){const img=identityData?`<img src="${escapeAttr(identityData)}" alt="Project avatar"/>`:"Add your artwork";$("identityAvatar").innerHTML=img;$("reviewLogo").innerHTML=identityData?`<img src="${escapeAttr(identityData)}" alt="Project avatar"/>`:"—";refreshProductPreview();updateIdentityStatus()}
function manualAsset(id,file){
 if(!file)return;
 if(!/^image\/(png|jpeg|webp)$/.test(file.type)){identityMessage("Choose a PNG, JPEG or WebP image.");return}
 if(file.size>4*1024*1024){identityMessage("Use an image under 4 MB.");return}
 const revision=++manualAssetRevision[id],r=new FileReader();
 r.onload=()=>{if(revision!==manualAssetRevision[id])return;if(id==="logoFile")identityData=r.result;else if(id==="bannerFile")bannerData=r.result;else launchCardData=r.result;resetChecks();invalidatePreparedProfile();renderIdentity();updateReview();identityMessage("Image added as a local preview. Add a persistent HTTPS/IPFS logo URL in Review before launch.")};
 r.readAsDataURL(file);
}
["avatarActionLabel","bannerActionLabel","launchCardActionLabel"].forEach(id=>$(id)?.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$($(id).getAttribute("for"))?.click()}}));
$("logoFile").onchange=e=>manualAsset("logoFile",e.target.files?.[0]);
["bannerFile","launchCardFile"].forEach(id=>$(id).onchange=e=>manualAsset(id,e.target.files?.[0]));
identityFields.forEach(id=>$(id)?.addEventListener("input",updateIdentityStatus));
async function gotoStage(name){if(!stageOrder.includes(name))return;
 const navigation=++reviewRequest;
 if(name==="review"){
  resetChecks();$("reviewGate").textContent="Checking current quote eligibility…";
  const selectedMode=mode;const [external]=await Promise.all([checkExternal(),refreshQuotes()]);
  if(navigation!==reviewRequest||mode!==selectedMode)return;
  if(!external||(mode==="network"?syncEligible:usdgEligible)!==true){$("reviewGate").textContent="Review paused. Quote status must be READY. Return to Combine to retry.";return}
  $("reviewGate").textContent="Both quotes are eligible ✓";
 }
 currentStage=name;document.querySelectorAll(".flow-panel").forEach(p=>p.classList.toggle("active",p.dataset.panel===name));document.querySelectorAll(".flow-step").forEach((b,i)=>{const at=stageOrder.indexOf(name),bi=stageOrder.indexOf(b.dataset.stage);b.classList.toggle("active",bi===at);b.classList.toggle("done",bi<at)});document.querySelector(`[data-panel="${name}"]`)?.scrollIntoView({behavior:"smooth",block:"start"});refreshProductPreview()}
document.querySelectorAll(".flow-step").forEach(b=>b.onclick=()=>gotoStage(b.dataset.stage));document.querySelectorAll("[data-back]").forEach(b=>b.onclick=()=>gotoStage(b.dataset.back));document.querySelectorAll("[data-next]").forEach(b=>b.onclick=()=>gotoStage(b.dataset.next));
$("toIdentityBtn").onclick=async()=>{const a=$("externalToken").value.trim();if(!/^0x[a-fA-F0-9]{40}$/.test(a)){$("assetStatus").className="asset-status fail";$("assetStatus").textContent="Add a valid syncable-asset contract first.";return}const ok=await checkExternal();if(mode==="network"&&syncEligible!==true){$("assetStatus").textContent="Network Sync status is not READY. Retry its live check first.";return}if(!ok)return;gotoStage("identity")};
$("toHomeBtn").onclick=()=>{const name=$("tokenName").value.trim(),sym=$("ticker").value.trim();if(!identityReady()){alert("Add a name (up to 40 characters) and an alphanumeric ticker (up to 10 characters) first.");return}gotoStage("home")};
function refreshProductPreview(){updateIdentityStatus();if($("bannerActionLabel"))$("bannerActionLabel").textContent=bannerData?"Change banner":"Add banner";if($("launchCardActionLabel"))$("launchCardActionLabel").textContent=launchCardData?"Change launch card":"Add launch card";const name=$("tokenName")?.value.trim()||"PROJECT",sym=($("ticker")?.value.trim()||"TOKEN").toUpperCase(),tag=$("identityTagline")?.value.trim()||"Your tagline appears here.",lore=$("identityLore")?.value.trim()||$("description")?.value.trim()||"Your project lore or description appears here.",second=mode==="network"?"SYNC":"USDG",ext=(externalSymbol||"ASSET").toUpperCase(),img=identityData?`<img src="${escapeAttr(identityData)}" alt="identity"/>`:"";identityTagline=tag==="Your tagline appears here."?"":tag;identityLore=lore.startsWith("Your project")?"":lore;if($("combineExternalNode"))$("combineExternalNode").textContent=ext;if($("combineSecondNode"))$("combineSecondNode").textContent=second;if($("combineModeLabel"))$("combineModeLabel").textContent=mode==="network"?"NETWORK SYNC · FREE":"STABLE SYNC · ≈ $20 IN SYNC";if($("homeAvatar"))$("homeAvatar").innerHTML=img;if($("homeBannerArt"))$("homeBannerArt").innerHTML=bannerData?`<img src="${escapeAttr(bannerData)}" alt="Project banner"/>`:img;if($("homeName"))$("homeName").textContent=name;if($("homeTicker"))$("homeTicker").textContent="$"+sym;if($("homeTagline"))$("homeTagline").textContent=tag;if($("homeLore"))$("homeLore").textContent=lore;if($("homeMarket1"))$("homeMarket1").textContent=`${sym} / ${ext}`;if($("homeMarket2"))$("homeMarket2").textContent=`${sym} / ${second}`;const x=xUrl($("xField").value),web=websiteUrl($("websiteField").value);$("homeXGroup").hidden=!x;$("homeWebsiteGroup").hidden=!web;$("homeX").textContent=$("xField").value.trim();$("homeWebsite").textContent=$("websiteField").value.trim();if(x)$("homeX").href=x;else $("homeX").removeAttribute("href");if(web)$("homeWebsite").href=web;else $("homeWebsite").removeAttribute("href");$("homeConnectionExternal").textContent=ext;$("homeConnectionToken").textContent=sym;$("homeConnectionSecond").textContent=second;$("successProjectName").textContent=name;$("successProjectTicker").textContent="$"+sym;$("successConnection").textContent=ext+" ← "+sym+" → "+second;if($("econTaxSummary"))$("econTaxSummary").textContent=creatorTax.toFixed(1)+"%";if($("econTotalSummary"))$("econTotalSummary").textContent=(1+creatorTax).toFixed(1)+"%";if($("econPlatformFee"))$("econPlatformFee").textContent=mode==="network"?"FREE":"≈ $20 IN SYNC";updateSocialCopy()}
["socialBio","launchPost","pinnedPost","starterPosts"].forEach(id=>$(id).addEventListener("input",()=>{$(id).dataset.edited="true"}));
function updateSocialCopy(){if(!$("socialBio"))return;const name=$("tokenName")?.value.trim()||"PROJECT",sym=($("ticker")?.value.trim()||"TOKEN").toUpperCase(),tag=$("identityTagline")?.value.trim()||identityTagline||"Two markets. One identity.",ext=(externalSymbol||"ASSET").toUpperCase(),second=mode==="network"?"SYNC":"USDG";if(!$("socialBio").dataset.edited)$("socialBio").textContent=`${tag} · ${ext} ↔ ${sym} ↔ ${second}. Synced via SyncNet.`;if(!$("launchPost").dataset.edited)$("launchPost").textContent=`${name} ($${sym}) is taking shape.\n\n${ext} ↔ ${sym} ↔ ${second}\n\nDon’t just launch a token. Sync it.`;if(!$("pinnedPost").dataset.edited)$("pinnedPost").textContent=`${name} connects ${ext} and ${second} through two markets under one token.\n\nContract: [added after launch]\nHome: syncnet.capital/token/[contract]`;if(!$("starterPosts").dataset.edited)$("starterPosts").textContent=`1. Two markets. One $${sym}.\n\n2. ${tag}\n\n3. The connection is the product: ${ext} ↔ ${sym} ↔ ${second}.`}
["tokenName","ticker","description","identityTagline","identityLore","xField","websiteField"].forEach(id=>$(id)?.addEventListener("input",()=>{resetChecks();updateReview();refreshProductPreview()}));
$("advancedToggle").onclick=()=>{$("advancedPanel").classList.toggle("open");$("advancedToggle").textContent=$("advancedPanel").classList.contains("open")?"Hide creator tax options":"Change creator tax"};
document.querySelectorAll("[data-copy]").forEach(b=>b.onclick=async()=>{const t=$(b.dataset.copy)?.textContent||"";try{await navigator.clipboard.writeText(t);const o=b.textContent;b.textContent="Copied";setTimeout(()=>b.textContent=o,1000)}catch{}});
async function loadJsZip(){if(window.JSZip)return window.JSZip;await new Promise((res,rej)=>{const s=document.createElement("script");s.src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";s.integrity="sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg==";s.crossOrigin="anonymous";s.referrerPolicy="no-referrer";s.onload=res;s.onerror=rej;document.head.appendChild(s)});return window.JSZip}
async function imageToCanvasBlob(w,h,kind){const c=document.createElement("canvas");c.width=w;c.height=h;const ctx=c.getContext("2d");const override=kind==="avatar"?identityData:kind==="banner"?bannerData:kind==="card"?launchCardData:"";if(override){await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{ctx.drawImage(image,0,0,w,h);resolve()};image.onerror=reject;image.src=override});return await new Promise(resolve=>c.toBlob(resolve,"image/png"))}ctx.fillStyle="#020303";ctx.fillRect(0,0,w,h);ctx.strokeStyle="#132023";ctx.lineWidth=1;for(let x=0;x<w;x+=64){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}for(let y=0;y<h;y+=64){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}const name=$("tokenName").value.trim()||"PROJECT",sym=($("ticker").value.trim()||"TOKEN").toUpperCase(),tag=$("identityTagline").value.trim()||identityTagline||"SYNCED VIA SYNCNET";if(identityData){await new Promise(resolve=>{const im=new Image();im.onload=()=>{const size=kind==="avatar"?Math.min(w,h)*.72:Math.min(h*.72,w*.28);const x=kind==="avatar"?(w-size)/2:w-size-70,y=kind==="avatar"?(h-size)/2:(h-size)/2;ctx.drawImage(im,x,y,size,size);resolve()};im.onerror=resolve;im.src=identityData})}ctx.fillStyle="#f2eee5";ctx.font=`${Math.round(h*(kind==="avatar"?.07:.09))}px Arial`;ctx.textAlign=kind==="avatar"?"center":"left";const tx=kind==="avatar"?w/2:70,ty=kind==="avatar"?h*.90:h*.42;ctx.fillText(kind==="avatar"?`$${sym}`:name,tx,ty);if(kind!=="avatar"){ctx.fillStyle="#79e6ec";ctx.font=`${Math.round(h*.035)}px monospace`;ctx.fillText(`$${sym} · SYNCNET`,70,ty+50);ctx.fillStyle="#8a9293";ctx.font=`${Math.round(h*.032)}px Arial`;ctx.fillText(tag.slice(0,70),70,ty+102)}return await new Promise(res=>c.toBlob(res,"image/png"))}
$("downloadSocialKit").onclick=async()=>{const b=$("downloadSocialKit"),old=b.textContent;b.disabled=true;b.textContent="Building kit…";try{const JSZip=await loadJsZip(),zip=new JSZip();zip.file("avatar.png",await imageToCanvasBlob(1024,1024,"avatar"));zip.file("banner.png",await imageToCanvasBlob(1500,500,"banner"));zip.file("launch-card.png",await imageToCanvasBlob(1200,675,"card"));zip.file("bio.txt",$("socialBio").textContent);zip.file("launch-post.txt",$("launchPost").textContent);zip.file("pinned-post.txt",$("pinnedPost").textContent);zip.file("starter-posts.txt",$("starterPosts").textContent);const blob=await zip.generateAsync({type:"blob"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(( $("ticker").value.trim()||"project")+"-social-kit.zip").toLowerCase();a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500)}catch(e){alert("Could not build the ZIP in this browser. The Social Kit copy remains available on screen.")}finally{b.disabled=false;b.textContent=old}};
// Wallet discovery — only explicitly supported Robinhood Chain EVM wallets.
// For EIP-6963 announcements, identity comes from the announced wallet metadata.
// Never infer MetaMask from compatibility flags when a wallet already identified itself.
const providers=[],providerBrands=new Set(),announcedProviderObjects=new WeakSet();
function brandFromEip6963Info(info){
  const rdns=String(info?.rdns||"").toLowerCase().trim();
  const name=String(info?.name||"").toLowerCase().trim();
  // Phantom exposes an EVM provider and may expose MetaMask-compatibility flags.
  // It is intentionally unsupported here, so reject it before any other test.
  if(rdns.includes("phantom")||name.includes("phantom"))return null;
  if(rdns==="io.metamask"||rdns.endsWith(".metamask")||name==="metamask")return "metamask";
  if(rdns.includes("rabby")||name==="rabby"||name.includes("rabby wallet"))return "rabby";
  if(rdns.includes("robinhood")||name.includes("robinhood"))return "robinhood";
  return null;
}
function brandFromLegacyProvider(p){
  if(!p)return null;
  // Explicit exclusions must come first because some wallets emulate MetaMask.
  if(p.isPhantom||p.phantom||p._isPhantom)return null;
  if(p.isRabby)return "rabby";
  if(p.isRobinhood||p.isRobinhoodWallet)return "robinhood";
  if(p.isMetaMask)return "unknown";
  return null;
}
function canonicalWalletName(brand){
  if(brand==="metamask")return "MetaMask";
  if(brand==="rabby")return "Rabby";
  if(brand==="robinhood")return "Robinhood Wallet";
  return "EVM Wallet · unverified identity";
}
function addEip6963Provider(detail){
 if(!detail?.provider)return;
 announcedProviderObjects.add(detail.provider);
 const brand=brandFromEip6963Info(detail.info),existing=providers.findIndex(d=>d.provider===detail.provider);
 if(!brand){if(existing>=0){providerBrands.delete(providers[existing].brand);providers.splice(existing,1)}return}
 const entry={provider:detail.provider,info:{...(detail.info||{}),name:String(detail.info?.name||canonicalWalletName(brand)).slice(0,60)},brand};
 if(existing>=0){providerBrands.delete(providers[existing].brand);if(providers.some((d,i)=>i!==existing&&d.brand===brand)){providers.splice(existing,1);providerBrands.add(brand);return}providers[existing]=entry;providerBrands.add(brand);return}
 if(providerBrands.has(brand))return;
 providerBrands.add(brand);providers.push(entry);
}
function addLegacyProvider(p){
  if(!p||announcedProviderObjects.has(p))return;
  const brand=brandFromLegacyProvider(p);
  if(!brand||providerBrands.has(brand))return;
  providerBrands.add(brand);
  providers.push({provider:p,info:{name:canonicalWalletName(brand)},brand});
}
window.addEventListener("eip6963:announceProvider",e=>addEip6963Provider(e.detail));
window.dispatchEvent(new Event("eip6963:requestProvider"));
setTimeout(()=>{
  // Legacy fallback is used only for providers that do not announce via EIP-6963.
  // Phantom and other MetaMask-compatible providers are explicitly excluded above.
  const legacy=window.ethereum?.providers?.length?window.ethereum.providers:[window.ethereum].filter(Boolean);
  legacy.forEach(addLegacyProvider);
},450);
let walletChainId=null, walletBusy=false, connectionGeneration=0;
const boundWallets=new WeakSet();
function walletName(){return providers.find(d=>d.provider===selectedProvider)?.info?.name||"EVM Wallet · unverified identity"}
function closeWalletMenu(){$("walletActions").hidden=true;$("walletPill").setAttribute("aria-expanded","false")}
function renderWallet(){
 const connected=Boolean(connectedAddress),correct=walletChainId===4663;
 $("walletProviderName").textContent=walletBusy?"Connecting…":connected?walletName():"Not connected";
 $("walletAddress").textContent=connected?connectedAddress.slice(0,6)+"…"+connectedAddress.slice(-4):"Connect wallet";
 $("walletAddress").title=connectedAddress||"";$("walletPill").classList.toggle("connected",connected);
 $("walletConnection").textContent=connected?"CONNECTED ✓":"DISCONNECTED";
 const network=!connected?"No network connected":correct?"Robinhood Chain · 4663 ✓":walletChainId===null?"NETWORK STATUS UNAVAILABLE":"WRONG NETWORK · Chain "+walletChainId;
 $("walletNetwork").textContent=network;$("walletNetwork").classList.toggle("wrong",connected&&!correct);$("switchNetwork").hidden=!connected||correct;
 $("reviewWalletName").textContent=connected?walletName():"Not connected";$("reviewWalletAddress").textContent=connectedAddress||"—";$("reviewWalletNetwork").textContent=network;
 status($("checkWalletConnected"),connected?"connected ✓":"not connected",connected?"pass":"");
 $("connectWallet").textContent=connected?"Change wallet":"Connect";$("walletPill").disabled=walletBusy;
}
function invalidateWalletChecks(){$("assetStatus").className="asset-status";$("assetStatus").textContent="Wallet state changed. Check this asset again before continuing.";assetRequest++;quoteRequest++;resetSyncableAsset($("externalToken").value.trim());syncEligible=null;usdgEligible=null;quoteStatus="checking";resetChecks();invalidatePreparedProfile();renderNetworkAvailability();refreshQuotes()}
function setDisconnectedWallet(message="Wallet disconnected from SyncNet. Reconnect to run a safe check."){
 connectionGeneration++;connectedAddress=null;selectedProvider=null;walletChainId=null;walletBusy=false;closeWalletMenu();invalidateWalletChecks();renderWallet();$("walletCopy").className="asset-status";$("walletCopy").textContent=message;
}
function bindProviderEvents(p){
 if(!p||boundWallets.has(p)||typeof p.on!=="function")return;boundWallets.add(p);
 p.on("accountsChanged",async accounts=>{if(p!==selectedProvider)return;const next=accounts?.[0];if(!/^0x[a-fA-F0-9]{40}$/.test(next||"")){setDisconnectedWallet();return}connectionGeneration++;walletBusy=false;connectedAddress=next;invalidateWalletChecks();renderWallet();$("walletCopy").textContent="Account changed. Run Safe Check again.";const generation=connectionGeneration;try{const chain=Number(await p.request({method:"eth_chainId"}));if(p===selectedProvider&&generation===connectionGeneration){walletChainId=chain;renderWallet()}}catch{if(p===selectedProvider&&generation===connectionGeneration){walletChainId=null;renderWallet()}}});
 p.on("chainChanged",id=>{if(p!==selectedProvider)return;walletChainId=Number(id);if(!Number.isSafeInteger(walletChainId))walletChainId=null;invalidateWalletChecks();renderWallet();$("walletCopy").textContent=walletChainId===4663?"Robinhood Chain selected. Run Safe Check again.":"Wrong network. Switch to Robinhood Chain before Safe Check."});
 p.on("disconnect",()=>{if(p===selectedProvider)setDisconnectedWallet()});
}
function openWallet(){
 closeWalletMenu();const list=$("providerList");list.replaceChildren();
 providers.forEach(d=>{const b=document.createElement("button");b.className="provider";b.type="button";const label=document.createElement("span");label.textContent=d.info.name;b.appendChild(label);b.onclick=()=>{connectionGeneration++;selectedProvider=d.provider;connectedAddress=null;walletChainId=null;bindProviderEvents(selectedProvider);invalidateWalletChecks();renderWallet();$("walletModal").classList.remove("open");connectSelected()};list.appendChild(b)});
 if(!providers.length){const note=document.createElement("div");note.className="asset-status";note.textContent="No supported injected wallet detected. Open this site in a browser with MetaMask, Rabby or Robinhood Wallet.";list.appendChild(note)}
 $("walletModal").classList.add("open");$("closeWallet").focus();
}
async function ensureChain(p){const cur=await p.request({method:"eth_chainId"});if(Number(cur)===4663)return;try{await p.request({method:"wallet_switchEthereumChain",params:[{chainId:RH_CHAIN_HEX}]})}catch(e){if(e.code===4902)await p.request({method:"wallet_addEthereumChain",params:[{chainId:RH_CHAIN_HEX,chainName:"Robinhood Chain",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:[RPC_URL],blockExplorerUrls:["https://robinhoodchain.blockscout.com/"]}]});else throw e}}
async function connectSelected(){
 const p=selectedProvider,request=++connectionGeneration;walletBusy=true;renderWallet();
 try{const accounts=await p.request({method:"eth_requestAccounts"});if(p!==selectedProvider||request!==connectionGeneration)return;const address=accounts?.[0];if(!/^0x[a-fA-F0-9]{40}$/.test(address||""))throw Error("No account was connected.");connectedAddress=address;walletChainId=Number(await p.request({method:"eth_chainId"}));if(p!==selectedProvider||request!==connectionGeneration)return;invalidateWalletChecks();$("walletCopy").textContent="Wallet connected. Launch permission is not checked until you run Safe Check.";
 }catch(e){if(p!==selectedProvider||request!==connectionGeneration)return;connectedAddress=null;walletChainId=null;$("walletCopy").textContent="Connection did not complete. Try again.";resetChecks()}
 finally{if(p===selectedProvider&&request===connectionGeneration){walletBusy=false;renderWallet()}}
}
$("walletPill").onclick=()=>{if(!connectedAddress){openWallet();return}const open=$("walletActions").hidden;$("walletActions").hidden=!open;$("walletPill").setAttribute("aria-expanded",String(open))};
$("connectWallet").onclick=openWallet;$("changeWallet").onclick=openWallet;$("disconnectWallet").onclick=()=>setDisconnectedWallet();
$("copyWalletAddress").onclick=async()=>{if(!connectedAddress)return;try{await navigator.clipboard.writeText(connectedAddress);$("copyWalletAddress").textContent="Copied ✓";setTimeout(()=>$("copyWalletAddress").textContent="Copy address",1500)}catch{$("walletCopy").textContent="Could not copy. Your full address is shown in Review."}};
$("switchNetwork").onclick=async()=>{const p=selectedProvider;if(!p)return;const b=$("switchNetwork");b.disabled=true;try{await ensureChain(p);if(p!==selectedProvider)return;walletChainId=Number(await p.request({method:"eth_chainId"}));invalidateWalletChecks();renderWallet()}catch{$("walletCopy").textContent="Network switch was not completed. Try again."}finally{b.disabled=false}};
$("closeWallet").onclick=()=>{$("walletModal").classList.remove("open");$("walletPill").focus()};
$("walletModal").onclick=e=>{if(e.target===$("walletModal"))$("closeWallet").onclick()};
document.addEventListener("click",e=>{if(!e.target.closest(".wallet-strip"))closeWalletMenu()});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeWalletMenu();if($("walletModal").classList.contains("open"))$("closeWallet").onclick()}if(e.key==="Tab"&&$("walletModal").classList.contains("open")){const focusable=[...$("walletModal").querySelectorAll("button")];const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});
function resetChecks(){checkRevision++;window.dispatchEvent(new Event("syncnet:draft-change"));$("reviewGate").textContent="";status($("checkLaunch"),"not checked");status($("checkExternal"),"not checked");status($("checkSecond"),"not checked");status($("checkSimulation"),"not checked");$("checkDetail").textContent="Run the safe check or the full Network Sync launch simulation. This public beta will not request or broadcast a transaction. Stable Sync remains preview only."}
let profileDraftId=null, preparedIntent=null, profileGeneration=0;
function invalidatePreparedProfile(){profileGeneration++;preparedIntent=null;if($("launchIntentPreview")){$("launchIntentPreview").hidden=true;$("launchIntentPreview").textContent=""}if($("profileServiceStatus"))$("profileServiceStatus").textContent="Draft changed. Save or prepare again. Production persistence is pending."}
function profileSnapshot(){return {draftId:profileDraftId,canonicalDraft:{chainId:4663,name:$("tokenName").value.trim(),ticker:$("ticker").value.trim().toUpperCase(),mode,externalAsset:$("externalToken").value.trim(),secondQuote:mode==="network"?SYNC:USDG,creatorTaxBps:Math.round(creatorTax*100),onChainDescription:$("description").value.trim()},profile:{tagline:$("identityTagline").value.trim(),description:$("description").value.trim(),lore:$("identityLore").value.trim(),links:{x:$("xField").value,website:$("websiteField").value},assets:{avatar:{url:identityData},banner:{url:bannerData},launchCard:{url:launchCardData}}}}}
$("saveDraftProfile").onclick=async()=>{const generation=profileGeneration;const draft=await window.SyncNetServices.saveDraftProfile(profileSnapshot());if(generation!==profileGeneration)return;profileDraftId=draft.id;$("profileServiceStatus").textContent="Draft saved in this tab’s memory only. Reloading closes this session. Manual uploads are previews. Any AI asset persistence is shown separately in Review."};
$("prepareLaunchIntent").onclick=async()=>{const generation=profileGeneration;try{if(!connectedAddress||walletChainId!==4663)throw Error("Connect a wallet on Robinhood Chain first.");const account=connectedAddress;const draft=await window.SyncNetServices.saveDraftProfile(profileSnapshot());if(generation!==profileGeneration)return;profileDraftId=draft.id;const intent=await window.SyncNetServices.createLaunchIntent({draftId:profileDraftId,creator:account});if(generation!==profileGeneration||account!==connectedAddress)return;preparedIntent=intent;$("launchIntentPreview").textContent=JSON.stringify(intent,null,2);$("launchIntentPreview").hidden=false;$("profileServiceStatus").textContent="Unsigned local intent prepared. No signature requested. No launch or registry verification performed."}catch(e){$("profileServiceStatus").textContent=e.message}};
$("successSocialKit").onclick=()=>$("downloadSocialKit").onclick();$("successAddX").onclick=async()=>{await gotoStage("social");$("xField").focus()};$("successAddWebsite").onclick=async()=>{await gotoStage("social");$("websiteField").focus()};
["tokenName","ticker","description","identityTagline","identityLore","xField","websiteField","externalToken","logoFile","bannerFile","launchCardFile"].forEach(id=>$(id).addEventListener("input",invalidatePreparedProfile));
document.querySelectorAll(".fee-choice,.mode-tab").forEach(button=>button.addEventListener("click",invalidatePreparedProfile));
renderWallet();
function randomBytes32(){const b=new Uint8Array(32);crypto.getRandomValues(b);return"0x"+[...b].map(x=>x.toString(16).padStart(2,"0")).join("")}
$("safeCheck").onclick=async()=>{
 if(!connectedAddress){openWallet();return}
 resetChecks();const revision=checkRevision, selectedMode=mode, account=connectedAddress, provider=selectedProvider;
 const name=$("tokenName").value.trim(),symbol=$("ticker").value.trim().toUpperCase(),ext=$("externalToken").value.trim(),second=selectedMode==="network"?SYNC:USDG;
 const current=()=>revision===checkRevision&&account===connectedAddress&&provider===selectedProvider&&mode===selectedMode;
 const fresh=()=>{if(!current())throw new Error("Inputs or wallet changed. Run the safe check again.")};
 if(!name||!symbol||!/^0x[a-fA-F0-9]{40}$/.test(ext)||ext.toLowerCase()===second.toLowerCase()){$("checkDetail").textContent="Add a name, ticker and a valid external asset different from the second quote.";return}
 const btn=$("safeCheck");btn.disabled=true;btn.textContent="Checking…";
 ["checkLaunch","checkExternal","checkSecond"].forEach(id=>status($(id),"checking","wait"));status($("checkSimulation"),"waiting","wait");
 try{
  const actualChain=Number(await provider.request({method:"eth_chainId"}));fresh();walletChainId=actualChain;renderWallet();if(actualChain!==4663)throw new Error("Switch your wallet to Robinhood Chain and retry.");if($("xField").value.trim()&&!xUrl($("xField").value))throw new Error("Enter a valid X handle or x.com URL.");if($("websiteField").value.trim()&&!websiteUrl($("websiteField").value))throw new Error("Enter a valid HTTP or HTTPS website URL.");
  if(!await checkExternal())throw new Error("External asset is not ready. See the live asset status in Combine.");fresh();
  const c=await publicClient();fresh();
  const read=async(address,functionName,args=[],outputs=[{type:"bool"}])=>{const value=await c.readContract({address,abi:[{type:"function",name:functionName,stateMutability:"view",inputs:args.map(()=>({type:"address"})),outputs}],functionName,args});fresh();return value};
  const can=await read(MULTI_FACTORY,"canLaunch",[account]);status($("checkLaunch"),can?"pass ✓":"blocked",can?"pass":"fail");
  const extOk=await read(QUOTE_PRICER,"isPriceable",[ext]);externalEligible=extOk;status($("checkExternal"),extOk?"eligible ✓":"not yet syncable",extOk?"pass":"fail");
  const secondOk=await read(QUOTE_PRICER,"isPriceable",[second]);
  if(selectedMode==="network"){syncEligible=secondOk;quoteStatus=secondOk?"ready":"ineligible";renderNetworkAvailability()}else usdgEligible=secondOk;
  status($("checkSecond"),secondOk?"eligible ✓":"not yet syncable",secondOk?"pass":"fail");
  if(!can||!extOk||!secondOk)throw new Error("Live PAR requirements are not satisfied. No simulation was submitted.");
  const launchFee=await read(MULTI_FACTORY,"launchFee",[],[{type:"uint256"}]);$("parLaunchFee").textContent=launchFee===0n?"FREE":formatRaw(launchFee,18,8)+" ETH";
  const {encodeFunctionData}=await getViem();fresh();
  const launchAbi=[{type:"function",name:"launchToken",stateMutability:"payable",inputs:[{name:"params",type:"tuple",components:[{name:"name",type:"string"},{name:"symbol",type:"string"},{name:"logo",type:"string"},{name:"description",type:"string"},{name:"socials",type:"tuple",components:[{name:"twitter",type:"string"},{name:"telegram",type:"string"},{name:"discord",type:"string"},{name:"website",type:"string"},{name:"farcaster",type:"string"}]},{name:"creatorFeeRecipient",type:"address"},{name:"creatorTaxBps",type:"uint16"},{name:"expectedEconomics",type:"bytes32"},{name:"salt",type:"bytes32"}]},{name:"launchConfigId",type:"uint256"},{name:"pairTokens",type:"address[]"}],outputs:[{name:"token",type:"address"}]}];
  const params={name,symbol,logo:"",description:$("description").value.trim(),socials:{twitter:xUrl($("xField").value),telegram:"",discord:"",website:websiteUrl($("websiteField").value),farcaster:""},creatorFeeRecipient:HOLDER_VAULT,creatorTaxBps:Math.round(creatorTax*100),expectedEconomics:ZERO32,salt:randomBytes32()};
  const data=encodeFunctionData({abi:launchAbi,functionName:"launchToken",args:[params,0n,[ext,second]]});fresh();
  status($("checkSimulation"),"simulating","wait");
  const result=await c.call({account,to:MULTI_FACTORY,data,value:launchFee});fresh();
  if(!result.data||!/^0x[0-9a-fA-F]{64}$/.test(result.data))throw new Error("PAR returned no valid launch result.");
  status($("checkSimulation"),"pass ✓","pass");$("walletCopy").textContent="Wallet connected. Eligibility and simulation results are shown below. No signature or transaction will be requested.";
  $("checkDetail").textContent=selectedMode==="network"?"PASS · Network Sync is technically ready in this eth_call simulation. Platform fee design: FREE. No token was created and transaction execution is disabled in this public beta.":"PASS · Stable Sync passed the full PAR eth_call simulation. Economic design: $20 in SYNC, 100% burn. SyncNet burn execution is NOT WIRED / TEST MODE. No token was created and no fee was collected.";
 }catch(e){if(current()){
  ["checkLaunch","checkExternal","checkSecond"].forEach(id=>{if($(id).textContent==="checking")status($(id),"STATUS UNAVAILABLE")});
  status($("checkSimulation"),"not passed","fail");$("checkDetail").textContent=String(e?.shortMessage||e?.message||e).slice(0,480)+" No transaction was sent.";
 }}finally{btn.disabled=false;btn.textContent="Run safe check";updateReview()}
};
window.SyncNetDraft=Object.freeze({viem:getViem,client:publicClient,read:()=>({provider:selectedProvider,draft:{mode,account:connectedAddress,external:$("externalToken").value.trim(),name:$("tokenName").value.trim(),symbol:$("ticker").value.trim().toUpperCase(),description:$("description").value.trim(),tax:Math.round(creatorTax*100),twitter:xUrl($("xField").value),website:websiteUrl($("websiteField").value),invalidLinks:!!($("xField").value.trim()&&!xUrl($("xField").value)||$("websiteField").value.trim()&&!websiteUrl($("websiteField").value)),logo:$("publicLogo").value.trim(),hasLocalArtwork:!!identityData,artwork:identityData,withoutLogo:$("launchWithoutLogo").checked}})});
// SyncNet verified project registry.
// Production backend writes this registry only after verifying a signed launch intent
// against the PAR TokenLaunched receipt. The public UI never infers provenance merely
// because a token happens to use SYNC or USDG as a quote asset. SyncNet provenance is separate from asset class.
let syncnetRegistryCache=null;
function safeHttpUrl(v){return window.SyncNetServices.httpUrl(v)}
function safeImageUrl(v){if(!v)return"";v=String(v).trim();if(v.startsWith("/assets/")&&!v.includes("..")&&!/[?#\\]/.test(v))return v;if(v.startsWith("ipfs://"))return "https://ipfs.io/ipfs/"+v.slice(7);return safeHttpUrl(v)}
async function getSyncnetRegistry(force=false){if(syncnetRegistryCache&&!force)return syncnetRegistryCache;const result=await window.SyncNetServices.loadVerifiedRegistry();syncnetRegistryCache=result.projects;return syncnetRegistryCache}
function registryEntryFor(rows,address){const a=String(address||"").toLowerCase();return rows.find(x=>String(x.token).toLowerCase()===a)||null}
async function loadSyncedProjects(){const grid=$("syncedProjectsGrid");if(!grid)return;const rows=(await getSyncnetRegistry(true)).filter(x=>x?.verified===true);$("syncedProjectCount").textContent=rows.length.toLocaleString();if(!rows.length){grid.innerHTML='<div class="registry-empty"><strong>No verified SyncNet launches yet.</strong><span>Verified SyncNet launches will appear here after transaction execution is enabled and a PAR launch receipt is verified.</span></div>';return}const cards=await Promise.all(rows.slice().sort((a,b)=>Number(b.verifiedAt||0)-Number(a.verifiedAt||0)).slice(0,24).map(async r=>{try{const q=await fetch(`${API_BASE}/launches/${r.token}`,{cache:"no-store"});if(!q.ok)return null;const d=await q.json();const markets=Array.isArray(d.markets)&&d.markets.length?d.markets:[d];return {r,d,markets}}catch{return null}}));grid.innerHTML=cards.filter(Boolean).map(({r,d,markets})=>{const logo=safeImageUrl(d.logoUrl||d.logo);const token=escapeHtml(d.token||r.token),name=escapeHtml(d.name||"Token"),symbol=escapeHtml(d.symbol||""),mode=r.mode==="network"?"Network Sync":"Stable Sync";return `<article class="project-card"><div class="project-card-top"><div class="project-logo">${logo?`<img src="${escapeAttr(logo)}" alt="${symbol||"token"}"/>`:"SYNC"}</div><div><h3>${name}</h3><div class="project-symbol">$${symbol}</div></div></div><div class="registry-connection">${escapeHtml(markets[0]?.quoteSymbol||"ASSET")} ← ${symbol||"TOKEN"} → ${escapeHtml(markets[1]?.quoteSymbol||"QUOTE")}</div><div class="project-mode"><span>Mode</span><strong>${mode}</strong></div><div class="verified-badge">✓ Verified SyncNet launch</div><div class="project-markets">${markets.map(m=>`<span class="project-market">${symbol||"TOKEN"} / ${escapeHtml(m.quoteSymbol||"QUOTE")}</span>`).join("")}</div><div class="project-actions"><a class="btn primary" href="/token/${token}">View project</a><a class="btn" href="https://par.family/token/${token}" target="_blank" rel="noreferrer">PAR ↗</a></div></article>`}).join("")||'<div class="registry-empty"><strong>Registry is online.</strong><span>Verified entries could not currently be resolved through the PAR indexer. Retry shortly.</span></div>'}

// Token page route
async function renderTokenPage(address){
  if(!/^0x[a-fA-F0-9]{40}$/.test(address))return;
  const home=$("homeView"),tokenView=$("tokenView"),root=$("tokenPageContent");
  if(!home||!tokenView||!root)return;
  home.hidden=true;home.classList.add("hidden");tokenView.hidden=false;tokenView.classList.add("active");
  root.innerHTML='<div class="error-box" style="border-color:#222;color:#777">Loading SyncNet token page…</div>';
  try{
    const r=await fetch(`${API_BASE}/launches/${address}`,{cache:"no-store"});
    if(!r.ok)throw new Error("PAR has not indexed this token yet. Retry shortly or open the contract on the explorer.");
    const d=await r.json();
    let registry=[];try{registry=await getSyncnetRegistry()}catch{}
    const reg=registryEntryFor(registry,address),profile=reg?.profile||{};
    const markets=Array.isArray(d.markets)&&d.markets.length?d.markets:[d];
    const syncConnected=markets.some(m=>String(m.pairToken||m.quoteToken||"").toLowerCase()===SYNC.toLowerCase()||String(m.quoteSymbol||"").toUpperCase()==="SYNC");
    const logo=safeImageUrl(profile.image||d.logoUrl||d.logo);
    const priceEth=Number(d.lastPriceEth),twitter=safeHttpUrl(profile.twitter||d.socials?.twitter),website=safeHttpUrl(profile.website||d.socials?.website);
    const displayDescription=profile.lore||profile.description||d.description||"No description stored on-chain.";
    const verified=reg?.verified===true;
    const provenance=verified?`<div class="syncnet-provenance">✓ Verified SyncNet launch · ${reg.mode==="network"?"Network Sync":"Stable Sync"}</div>`:(syncConnected?'<div class="syncnet-provenance">SYNC-CONNECTED · LIVE ON PAR</div>':"");
    root.innerHTML=`<section class="token-hero"><a class="btn" href="/">← SyncNet</a><div class="token-grid">
      <div class="token-panel">
        <div class="token-avatar">${logo?`<img src="${escapeAttr(logo)}" alt="${escapeAttr(d.symbol||"token")}"/>`:"<span>NO LOGO</span>"}</div>
        <h1 class="token-name">${escapeHtml(d.name||"Token")}</h1><div class="token-symbol">$${escapeHtml(d.symbol||"")}</div>${provenance}
        <p class="field-help">Market connection does not imply endorsement, partnership or official affiliation. Third-party metadata is unverified unless explicitly marked otherwise.</p>
        <div class="markets">${markets.map(m=>`<span class="market-chip">${escapeHtml(d.symbol||"TOKEN")} / ${escapeHtml(m.quoteSymbol||"QUOTE")}</span>`).join("")}</div>
        <p class="token-desc">${escapeHtml(displayDescription)}</p>
        <div class="token-meta">
          <div class="review-row"><span>Contract</span><strong class="mono">${escapeHtml(d.token||address)}</strong></div>
          ${verified?`<div class="review-row"><span>SyncNet provenance</span><strong>VERIFIED</strong></div><div class="review-row"><span>Sync mode</span><strong>${reg.mode==="network"?"NETWORK SYNC":"STABLE SYNC"}</strong></div>`:""}
          <div class="review-row"><span>Fee mode</span><strong>${escapeHtml(String(d.feeMode||"creator").toUpperCase())}</strong></div>
          <div class="review-row"><span>Creator tax</span><strong>${Number(d.creatorTaxBps||0)/100}%</strong></div>
          <div class="review-row"><span>Markets</span><strong>${markets.length}</strong></div>
        </div>
        <div class="actions" style="justify-content:flex-start"><a class="btn primary" href="https://par.family/token/${encodeURIComponent(address)}" target="_blank" rel="noreferrer">Trade on PAR</a><a class="btn" href="https://robinhoodchain.blockscout.com/token/${encodeURIComponent(address)}" target="_blank" rel="noreferrer">Explorer</a>${twitter?`<a class="btn" href="${escapeAttr(twitter)}" target="_blank" rel="noreferrer">X · creator submitted</a>`:""}${website?`<a class="btn" href="${escapeAttr(website)}" target="_blank" rel="noreferrer">Website · creator submitted</a>`:""}</div>
      </div>
      <div class="token-panel"><div class="label">Live market</div>
        <div class="token-metrics">
          <div class="metric"><span>Price ETH</span><strong>${Number.isFinite(priceEth)?priceEth.toPrecision(5):"—"}</strong></div>
          <div class="metric"><span>Holders</span><strong id="tokenHolderCount">…</strong></div>
          <div class="metric"><span>Trades</span><strong>${Number(d.tradeCount||0).toLocaleString()}</strong></div>
          <div class="metric"><span>Volume ETH</span><strong>${Number(d.totalVolumeEth||0).toLocaleString(undefined,{maximumFractionDigits:3})}</strong></div>
        </div>
        <div class="chart-wrap" id="tokenChart"><div class="sn-chart-empty">Loading 5-minute chart…</div></div>
        <div class="micro">PAR indexer candles · 5 minute interval · ETH-normalized close for multi-market comparability.</div>
      </div>
    </div></section>`;
    loadChart(address);
    window.SyncNetNetwork?.setHolderCount(address,"tokenHolderCount",null);
  }catch(e){root.innerHTML=`<div class="error-box">${escapeHtml(e.message||"Could not load this token.")}</div>`}
}
function escapeHtml(v){return String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]))}function escapeAttr(v){return escapeHtml(v)}
async function loadChart(address){
  const el=$("tokenChart");if(!el)return;
  try{
    const r=await fetch(`${API_BASE}/candles?token=${address}&interval=5m&limit=240`,{cache:"no-store"});
    if(!r.ok)throw Error();
    const d=await r.json(),candles=(d.candles||[]).map(c=>({time:Number(c.time),close:Number(c.closeEth)})).filter(c=>Number.isFinite(c.time)&&Number.isFinite(c.close)&&c.close>0);
    if(candles.length<2)throw Error();
    const vals=candles.map(c=>c.close),min=Math.min(...vals),max=Math.max(...vals),span=Math.max(max-min,max*.000001),W=1000,H=330,pad=26;
    const pts=candles.map((c,i)=>{const x=pad+(W-pad*2)*(i/(candles.length-1)),y=pad+(H-pad*2)*(1-(c.close-min)/span);return `${x.toFixed(1)},${y.toFixed(1)}`}).join(" ");
    const last=candles[candles.length-1].close,first=candles[0].close,delta=(last/first-1)*100;
    el.innerHTML=`<svg class="sn-line-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="5 minute ETH-normalized token price chart">
      <line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" stroke="#171d1e" stroke-width="1"/>
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H-pad}" stroke="#171d1e" stroke-width="1"/>
      <polyline points="${pts}" fill="none" stroke="#79e6ec" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
    </svg><div class="micro" style="margin-top:8px">Range ${min.toPrecision(4)}–${max.toPrecision(4)} ETH · ${delta>=0?"+":""}${delta.toFixed(2)}% over displayed window</div>`;
  }catch{el.innerHTML='<div class="sn-chart-empty">Chart data is temporarily unavailable.</div>'}
}
// APP_START
const route=location.pathname?.match(/^\/token\/(0x[a-fA-F0-9]{40})\/?$/);if(route){renderTokenPage(route[1])}else{loadSyncData();loadChainState();loadSyncedProjects();setInterval(loadSyncData,30000);setInterval(loadChainState,60000);setInterval(loadSyncedProjects,60000);updateReview();renderIdentity();refreshProductPreview()}

})();
