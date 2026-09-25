(function(){
'use strict';
const toggle=document.querySelector('.nav-toggle'),links=document.querySelector('.nav-links');
toggle?.addEventListener('click',()=>{const open=links?.classList.toggle('open');toggle.setAttribute('aria-expanded',String(Boolean(open)));});
document.addEventListener('click',e=>{if(!e.target.closest('.site-nav')&&links?.classList.contains('open')){links.classList.remove('open');toggle?.setAttribute('aria-expanded','false')}});
['searchStatus','assetStatus','simStatus','liveStatus','logoStatus','syncStatus'].forEach(id=>{const el=document.getElementById(id);if(el){el.setAttribute('role','status');el.setAttribute('aria-live','polite')}});const toast=document.getElementById('toast');if(toast){toast.setAttribute('role','status');toast.setAttribute('aria-live','polite')}
const hero=document.querySelector('.hero-sync-mark');if(hero&&'IntersectionObserver'in window){new IntersectionObserver(([e])=>hero.classList.toggle('is-offscreen',!e.isIntersecting),{threshold:.05}).observe(hero)}
document.querySelectorAll('[data-copy]').forEach(btn=>btn.addEventListener('click',async()=>{const text=btn.getAttribute('data-copy')||'';try{await navigator.clipboard.writeText(text);const old=btn.textContent;btn.textContent='Copied ✓';setTimeout(()=>btn.textContent=old,1300)}catch{}}));
})();
