(function(){'use strict';
/*
 * SyncNet · "EVM account required" notice (Builder, Marketplace, Economy).
 *
 * Phantom is a supported wallet. When the account currently selected in Phantom is Solana-only, Phantom refuses
 * SyncNet's eth_requestAccounts ("Unsupported account … this Solana account doesn't support Ethereum"). This file
 * recognises ONLY that case and explains it in SyncNet's own UI; every other wallet error keeps the page's existing
 * generic handling. It changes no wallet permission, chain or connection logic: the page decides when to ask it.
 *
 *   SyncNetEvmNotice.check(provider, info, accounts)   -> throws a tagged error when Phantom exposed no 0x account
 *   SyncNetEvmNotice.matches(provider, info, error)    -> true only for a confident "no EVM account" signal
 *   SyncNetEvmNotice.show({onRetry, returnFocus})      -> in-app notice with TRY AGAIN / DISMISS
 *   SyncNetEvmNotice.hide()                            -> removes it (called after a successful connection)
 */
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
// Only explicit "this account cannot do Ethereum/EVM" wording counts. Bare codes (4001 user rejected, 4100
// unauthorised) are ambiguous and never match on their own.
const UNSUPPORTED=[
 /unsupported account/i,
 /(does\s*n[o'’]?t|does not|cannot|can[’']?t|not)\s+support(ed)?\s+(for\s+)?(ethereum|evm)/i,
 /solana[-\s]only/i,
 /this solana account/i,
 /no (ethereum|evm)[-\s](compatible\s+)?(account|address)/i,
 /not an? (ethereum|evm)[-\s]compatible account/i,
];
const NO_EVM='SYNCNET_NO_EVM_ACCOUNT';

function isPhantom(provider,info){
 return Boolean(provider&&provider.isPhantom===true)||/(^|\.)phantom(\.|$)/i.test(String((info&&info.rdns)||''))||/^phantom\b/i.test(String((info&&info.name)||''));
}
function textOf(err){
 if(!err)return '';
 const parts=[err.message,err.reason,err.data&&err.data.message,err.error&&err.error.message,typeof err==='string'?err:''];
 return parts.filter(v=>typeof v==='string').join(' · ').slice(0,600);
}
/** After a successful eth_requestAccounts: Phantom answering without any 0x address means no EVM account is selected. */
function check(provider,info,accounts){
 if(!isPhantom(provider,info))return;
 const list=Array.isArray(accounts)?accounts:[];
 if(!list.some(a=>ADDRESS.test(String(a||''))))throw Object.assign(new Error('The selected Phantom account exposed no Ethereum address.'),{syncnetCode:NO_EVM});
}
function matches(provider,info,err){
 if(!err||!isPhantom(provider,info))return false;
 if(err.syncnetCode===NO_EVM)return true;
 const t=textOf(err);
 return Boolean(t)&&UNSUPPORTED.some(re=>re.test(t));
}

let el=null,retryFn=null,returnTo=null;
function build(){
 if(el)return el;
 el=document.createElement('div');
 el.className='modal';el.id='evmAccountNotice';
 el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');
 el.setAttribute('aria-labelledby','evmAccountNoticeTitle');el.setAttribute('aria-describedby','evmAccountNoticeBody');
 el.style.zIndex='90'; // above any wallet chooser that may still be closing
 el.innerHTML='<div class="modal-card" style="text-align:left">'
  +'<div class="eyebrow" style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><svg style="color:var(--cyan);flex:none" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="6" width="20" height="14" rx="3"/><path d="M16 13h2"/><path d="M6 6V5a2 2 0 0 1 2-2h8"/></svg><span>Robinhood Chain · EVM</span></div>'
  +'<h3 id="evmAccountNoticeTitle">EVM ACCOUNT REQUIRED</h3>'
  +'<div id="evmAccountNoticeBody"><p>SyncNet runs on Robinhood Chain.</p><p>Your selected Phantom account is Solana-only. Switch to an Ethereum-compatible account and try again.</p></div>'
  +'<p class="field-help">In Phantom, switch accounts and choose one that has an Ethereum address. Robinhood Chain is EVM-compatible.</p>'
  +'<div class="actions"><button class="btn primary" type="button" id="evmAccountNoticeRetry">TRY AGAIN</button><button class="btn" type="button" id="evmAccountNoticeDismiss">DISMISS</button></div>'
  +'</div>';
 document.body.appendChild(el);
 el.querySelector('#evmAccountNoticeRetry').addEventListener('click',()=>{const fn=retryFn;hide(false);if(typeof fn==='function')fn()});
 el.querySelector('#evmAccountNoticeDismiss').addEventListener('click',()=>hide(true));
 el.addEventListener('click',e=>{if(e.target===el)hide(true)});
 el.addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();hide(true);return}
  if(e.key!=='Tab')return;
  const f=[...el.querySelectorAll('button')];const first=f[0],last=f[f.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
 });
 return el;
}
function show(opts){
 const o=opts||{};
 retryFn=o.onRetry||null;returnTo=o.returnFocus||document.activeElement;
 const n=build();n.classList.add('open');
 requestAnimationFrame(()=>n.querySelector('#evmAccountNoticeRetry').focus());
}
function hide(restoreFocus){
 if(!el||!el.classList.contains('open'))return;
 el.classList.remove('open');retryFn=null;
 const target=returnTo;returnTo=null;
 if(restoreFocus!==false&&target&&typeof target.focus==='function')target.focus();
}
window.SyncNetEvmNotice=Object.freeze({check,matches,show,hide:()=>hide(false),isPhantom,_patterns:UNSUPPORTED});
})();
