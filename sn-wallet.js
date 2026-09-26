/*
 * SyncNet wallet (shared by Explore, Project Page, My Projects, the Project Home editor and the top bar).
 * Same discovery model as the Builder and the Marketplace: EIP-6963 announcements first, the legacy
 * window.ethereum(.providers) list as a fallback, deduplicated; with several wallets the user picks one explicitly.
 *
 * Nothing here runs without a user action, except one SILENT eth_accounts on the wallet this browser connected
 * before (remembered by its public rdns identifier only). No accounts, no sign-in, no keys, no seed phrases.
 * Signing is always an explicit call from a page flow (EIP-712 typed data, or personal_sign for upload sessions).
 */
(function () {
  'use strict';
  const KEY = 'syncnet_wallet_rdns';
  const CHAIN_HEX = '0x1237';
  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const providers = [];
  const seen = new Set();
  const listeners = new Set();
  let provider = null, account = '', chainId = '', info = null;

  const label = (p, i) => (i && i.name) || (p && p.isBraveWallet ? 'Brave Wallet' : p && p.isPhantom ? 'Phantom' : p && p.isRabby ? 'Rabby' : p && p.isMetaMask ? 'MetaMask' : 'EVM wallet');
  function add(p, i) {
    if (!p || typeof p.request !== 'function' || seen.has(p)) return;
    if (i && i.rdns && providers.some((x) => x.rdns === i.rdns)) return;
    seen.add(p); providers.push({ provider: p, name: label(p, i), rdns: (i && i.rdns) || '' });
  }
  function legacy() {
    if (providers.length) return;
    const e = window.ethereum;
    (e && Array.isArray(e.providers) && e.providers.length ? e.providers : [e]).filter(Boolean).forEach((p) => add(p));
  }
  window.addEventListener('eip6963:announceProvider', (e) => add(e.detail && e.detail.provider, e.detail && e.detail.info));
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  const emit = () => listeners.forEach((f) => { try { f(state()); } catch (err) { /* listener errors never break the wallet */ } });
  const state = () => ({ connected: Boolean(provider && account), account, chainId, name: info ? info.name : '' });
  const remember = (rdns) => { try { if (rdns) localStorage.setItem(KEY, rdns); else localStorage.removeItem(KEY); } catch { /* storage may be blocked */ } };
  const remembered = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };

  const bound = new WeakSet();
  function bind(p) {
    if (typeof p.on !== 'function' || bound.has(p)) return;
    bound.add(p);
    p.on('accountsChanged', (a) => { if (p !== provider) return; account = lc(a && a[0]); if (!account) remember(''); emit(); });
    p.on('chainChanged', (c) => { if (p !== provider) return; chainId = lc(c); emit(); });
    p.on('disconnect', () => { if (p !== provider) return; account = ''; emit(); });
  }
  async function use(entry, prompt) {
    const p = entry.provider;
    const accounts = await p.request({ method: prompt ? 'eth_requestAccounts' : 'eth_accounts' });
    const a = lc(accounts && accounts[0]);
    if (!a) return false;
    provider = p; info = entry; account = a;
    try { chainId = lc(await p.request({ method: 'eth_chainId' })); } catch { chainId = ''; }
    bind(p); remember(entry.rdns || entry.name); emit();
    return true;
  }

  // ---- chooser (only when several wallets exist)
  function choose() {
    return new Promise((resolve) => {
      let dlg = document.getElementById('snWalletDialog');
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'snWalletDialog'; dlg.className = 'sn-dialog'; dlg.setAttribute('aria-labelledby', 'snWalletTitle');
        dlg.innerHTML = '<div class="sn-dialog-body"><h2 id="snWalletTitle">Choose a wallet</h2><div id="snWalletList"></div><p class="sn-small sn-muted" style="margin:14px 0 0">Connecting shares your address only. Nothing is signed or sent.</p><button type="button" class="sn-textbtn" data-close>Cancel</button></div>';
        document.body.appendChild(dlg);
      }
      const list = dlg.querySelector('#snWalletList');
      list.innerHTML = '';
      providers.forEach((entry) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sn-choice'; b.textContent = entry.name;
        b.addEventListener('click', () => { dlg.close(); resolve(entry); }, { once: true });
        list.appendChild(b);
      });
      dlg.querySelector('[data-close]').onclick = () => { dlg.close(); resolve(null); };
      dlg.oncancel = () => resolve(null);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      const first = list.querySelector('button'); if (first) first.focus();
    });
  }

  async function connect() {
    legacy();
    if (!providers.length) throw Object.assign(new Error('No EVM wallet was found in this browser. Install one, or open this page inside your wallet app.'), { code: 'NO_WALLET' });
    const entry = providers.length === 1 ? providers[0] : await choose();
    if (!entry) return state();
    await use(entry, true);
    return state();
  }
  function disconnect() { provider = null; account = ''; info = null; remember(''); emit(); }

  async function ensureChain() {
    if (!provider) throw new Error('Connect a wallet first.');
    if (chainId === CHAIN_HEX) return;
    try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] }); }
    catch (e) {
      if (e && e.code === 4902) await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CHAIN_HEX, chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com/'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] }] });
      else throw e;
    }
    chainId = lc(await provider.request({ method: 'eth_chainId' }));
    if (chainId !== CHAIN_HEX) throw new Error('Switch your wallet to Robinhood Chain (4663).');
  }
  /** EIP-712 typed data signature (free: never a transaction). */
  async function signTyped(typed) {
    if (!provider || !account) throw new Error('Connect a wallet first.');
    return provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typed)] });
  }
  async function personalSign(message) {
    if (!provider || !account) throw new Error('Connect a wallet first.');
    const hex = '0x' + Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join('');
    return provider.request({ method: 'personal_sign', params: [hex, account] });
  }
  /** One wallet transaction the user reviews in their wallet. Always on chain 4663. */
  async function sendTransaction(tx) {
    await ensureChain();
    return provider.request({ method: 'eth_sendTransaction', params: [{ from: account, chainId: CHAIN_HEX, ...tx }] });
  }
  function onChange(f) { listeners.add(f); f(state()); return () => listeners.delete(f); }

  // Silent restore of the wallet this browser used before (eth_accounts: no prompt).
  setTimeout(() => {
    const want = remembered();
    if (!want) return;
    legacy();
    const entry = providers.find((x) => x.rdns === want || x.name === want);
    if (entry) use(entry, false).catch(() => {});
  }, 500);

  window.SyncNetWallet = Object.freeze({ connect, disconnect, ensureChain, signTyped, personalSign, sendTransaction, onChange, state, CHAIN_HEX });
})();
