/* SyncNet persistence boundary. No backend endpoints, signatures or verification in this adapter. */
(function(){
'use strict';
const address=/^0x[a-fA-F0-9]{40}$/;
const SYNC='0x6368e007b9f0b941560ed1f3bceb20247f5eca37',USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const drafts=new Map();
function nonce(){const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')}
async function profileHash(text){if(crypto.subtle){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return '0x'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')}const {sha256,stringToHex}=await import('/vendor/viem.js');return sha256(stringToHex(text))}
const copy=v=>JSON.parse(JSON.stringify(v));
function httpUrl(value){try{const input=String(value||'').trim();if(!/^https?:\/\//i.test(input)||/[\u0000-\u0020]/.test(input))return '';const url=new URL(input);if(url.username||url.password)return '';return ['https:','http:'].includes(url.protocol)?url.href:''}catch{return ''}}
function website(value){const input=String(value||'').trim();return httpUrl(/^[a-z][a-z\d+.-]*:/i.test(input)?input:input?'https://'+input:'')}
function xLink(value){const input=String(value||'').trim();if(!input)return '';if(/^@?[A-Za-z0-9_]{1,15}$/.test(input))return 'https://x.com/'+input.replace(/^@/,'');const url=httpUrl(input);if(!url)return '';return ['x.com','www.x.com','twitter.com','www.twitter.com'].includes(new URL(url).hostname)?url:''}
function cleanProfile(profile){const editable={};for(const key of ['tagline','description','lore'])editable[key]=String(profile[key]||'').slice(0,20000);editable.links={x:xLink(profile.links?.x),website:website(profile.links?.website)};editable.assets={};for(const key of ['avatar','banner','launchCard']){const asset=profile.assets?.[key];editable.assets[key]={url:String(asset?.url||''),status:'preview-only',persisted:false}}return editable}
function pending(operation){return {status:'production-service-pending',operation,verified:false,persisted:false,message:'This operation requires the authenticated production service.'}}
async function saveDraftProfile({draftId,canonicalDraft,profile}){const id=draftId||nonce();const draft={id,schemaVersion:1,canonicalDraft:copy(canonicalDraft),profile:cleanProfile(profile),scope:'current-tab-memory',persisted:false,updatedAt:new Date().toISOString()};drafts.set(id,draft);return copy(draft)}
async function createLaunchIntent({draftId,creator}){
 if(!address.test(creator||''))throw Error('Connect a wallet to prepare an unsigned intent.');
 const draft=drafts.get(draftId);if(!draft)throw Error('Save a current draft first.');
 const c=draft.canonicalDraft,expected=c.mode==='network'?SYNC:c.mode==='usdg'?USDG:null;
 if(c.chainId!==4663||!expected||!address.test(c.externalAsset)||c.externalAsset.toLowerCase()===expected||c.secondQuote.toLowerCase()!==expected)throw Error('The two quote assets must match the selected mode.');
 if(!c.name||!c.ticker||![0,100,250,500,1000].includes(c.creatorTaxBps))throw Error('Complete the name, ticker and creator tax first.');
 const digest=await profileHash(JSON.stringify({canonicalDraft:c,profile:draft.profile}));
 return {schemaVersion:1,purpose:'SYNCNET LAUNCH INTENT',chainId:4663,creator:creator.toLowerCase(),name:c.name,ticker:c.ticker,mode:c.mode,externalAsset:c.externalAsset.toLowerCase(),secondQuote:expected,creatorTaxBps:c.creatorTaxBps,metadataHash:digest,metadataHashAlgorithm:'SHA-256 draft snapshot (not an EIP-712 signing digest)',timestamp:new Date().toISOString(),expiresAt:new Date(Date.now()+15*60*1000).toISOString(),nonce:nonce(),signed:false,verified:false,status:'unsigned-local-preview'};
}
async function loadProjectProfile({draftId}={}){return drafts.has(draftId)?copy(drafts.get(draftId)):pending('loadProjectProfile')}
// Frontend flags and a simulation result are never evidence of a real launch.
async function finalizeProjectProfile(){return pending('finalizeProjectProfile')}
async function updateProjectProfile(){return pending('updateProjectProfile')}
async function loadVerifiedRegistry(){
 try{
  const r=await fetch("/syncnet-projects.json",{cache:"no-store"});
  if(!r.ok)throw Error();
  const d=await r.json();
  const projects=Array.isArray(d?.projects)?d.projects.filter(x=>address.test(String(x?.token||""))):[];
  return {status:"public-profile-registry",projects};
 }catch{return {status:"registry-unavailable",projects:[]}}
}
function productionReadiness(){return {enabled:false,blocking:['Network wallet execution is disabled in this public beta; this service does not admit registry entries.','Authenticated asset/profile persistence is pending.','Intent signature and receipt verification are pending.','Transaction-capable actions remain intentionally disabled while public-beta controls and service details are finalized.','Stable Sync needs atomic or safely refundable fee execution.']}}
window.SyncNetServices=Object.freeze({saveDraftProfile,createLaunchIntent,finalizeProjectProfile,loadProjectProfile,updateProjectProfile,loadVerifiedRegistry,productionReadiness,httpUrl,website,xLink});
})();
