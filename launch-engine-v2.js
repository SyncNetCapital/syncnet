(function(){
'use strict';
/*
 * SyncNet launch engine (V2.5 release candidate).
 * Builds, validates and simulates one PAR multi-market launch and returns an IMMUTABLE prepared launch (P).
 * Nothing here sends a transaction. The builder sends exactly P.request after its own checks.
 *
 * Depends on: /lib/syncnet-core.js (SyncNetCore), /lib/syncnet-chain.js (SyncNetChain), /vendor/viem.js (passed in).
 */
const Core=window.SyncNetCore, Chain=window.SyncNetChain;
const R=Chain.ROBINHOOD;
const CHAIN=R.chainId;
const FACTORY='0x3ea29975a79900179F3e1aEF93347Ba4210c29C1';
const PRICER='0x9EfC6EFA4c5F31e2BEC6CC174Ba7bB8f0b57d563';
const ROUTER='0x458D2a59c2F3dd32775a64eE72004561440d64Df';
const VAULT='0x4B79B8298cd890A82dC9De1dE5dBb745Cf04353C';      // PairPadHolderVault (fees to holders)
const BURN_VAULT='0x16c83D36539b6C92E6FC998D2a039fD7Ff31958E'; // PairPadBurnVault (buyback & burn)
const FLOOR_VAULT='0xA5e805856e513F01d6aC992aC45FE54E5e601829';// PairPadFloorVault (price floor)
const FEE_MODES=Object.freeze({holders:VAULT,burn:BURN_VAULT,floor:FLOOR_VAULT,creator:null});
function modeForRecipient(r){r=String(r||'').toLowerCase();if(!r)return'';return Chain.VAULT_MODES[r]||'creator'}
const ZERO='0x'+'00'.repeat(32);
const PROVENANCE_DOMAIN='SYNCNET/1';
const address=/^0x[a-fA-F0-9]{40}$/;
const equal=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const SUPPLY_FALLBACK=10n**27n;
const MAX_OPENING_BUY_WEI=10n*10n**18n; // sanity ceiling against typos
const SLIPPAGE_BPS=[50,100,200,500];
const TAX_OPTIONS=[0,100,250,500,1000];
const components=[{name:'name',type:'string'},{name:'symbol',type:'string'},{name:'logo',type:'string'},{name:'description',type:'string'},{name:'socials',type:'tuple',components:['twitter','telegram','discord','website','farcaster'].map(name=>({name,type:'string'}))},{name:'creatorFeeRecipient',type:'address'},{name:'creatorTaxBps',type:'uint16'},{name:'expectedEconomics',type:'bytes32'},{name:'salt',type:'bytes32'}];
const POOLKEY={name:'key',type:'tuple',components:[{name:'currency0',type:'address'},{name:'currency1',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'hooks',type:'address'}]};
const HOP=[POOLKEY,{name:'v3',type:'bool'}];
const ROUTER_ABI=[{type:'function',name:'launchAndBuyWithEth',stateMutability:'payable',inputs:[{name:'params',type:'tuple',components},{name:'launchConfigId',type:'uint256'},{name:'pairTokens',type:'address[]'},{name:'legs',type:'tuple[]',components:[{name:'market',type:'uint8'},{name:'hops',type:'tuple[]',components:HOP},{name:'amountIn',type:'uint256'}]},{name:'minTokensOut',type:'uint256'}],outputs:[{name:'token',type:'address'},{name:'tokensOut',type:'uint256'}]}];
const PRICER_ROUTE_ABI=[{type:'function',name:'route',stateMutability:'view',inputs:[{name:'quoteToken',type:'address'}],outputs:[{name:'hops',type:'tuple[]',components:HOP},{name:'qualifies',type:'bool'}]}];
const ABI=[{type:'function',name:'launchToken',stateMutability:'payable',inputs:[{name:'params',type:'tuple',components},{name:'launchConfigId',type:'uint256'},{name:'pairTokens',type:'address[]'}],outputs:[{name:'token',type:'address'}]}];
function read(client,to,name,args=[],types=[],output='uint256'){return client.readContract({address:to,abi:[{type:'function',name,stateMutability:'view',inputs:types.map(type=>({type})),outputs:[{type:output}]}],functionName:name,args});}
function rpcOf(client){return (method,params)=>client.request({method,params});}
function fail(message,extra){return Object.assign(Error(message),extra||{})}

// ---- Metadata policy: PAR limits are UTF-8 BYTES (PairPadLaunchDeployer), text must be NFC and free of invisible/bidi tricks.
function field(fieldName,value,label,opts){const r=Core.validateMetadataField(fieldName,String(value??''),opts);if(!r.ok)throw fail(r.errors.map(e=>e.message).join(' '),{field:label||fieldName,code:'METADATA'});return r.value}
function safeUrl(value,label){value=Core.normalizeText(String(value||''));if(!value)return '';let u;try{u=new URL(value)}catch{throw fail(label+' must be a full https:// URL.',{field:label,code:'URL'})}if(u.protocol!=='https:')throw fail(label+' must use https:// — the link is permanent on-chain.',{field:label,code:'URL'});if(u.username||u.password)throw fail(label+' must not contain a username or password.',{field:label,code:'URL'});const href=u.href;return field('social',href,label)}
function safeLogo(value){value=Core.normalizeText(String(value||''));if(!value)return '';if(/^ipfs:\/\/[a-zA-Z0-9]+(?:\/[a-zA-Z0-9._~/-]+)?$/.test(value))return field('logo',value,'Logo URI');let u;try{u=new URL(value)}catch{throw fail('Use an ipfs:// or https:// logo URI.',{field:'Logo URI',code:'URL'})}if(u.protocol!=='https:'||u.username||u.password)throw fail('Use a public ipfs:// or https:// logo URI.',{field:'Logo URI',code:'URL'});return field('logo',u.href,'Logo URI')}

function normalize(draft){
 if(!address.test(draft.account||''))throw Error('Connect a wallet first.');
 const name=field('name',draft.name,'Project name');
 const symbol=Core.normalizeText(String(draft.symbol||'')).toUpperCase();
 if(!/^[A-Z0-9]{1,10}$/.test(symbol))throw fail('Ticker must be 1–10 letters or numbers.',{field:'Ticker',code:'METADATA'});
 field('symbol',symbol,'Ticker');
 const description=field('description',draft.description,'Description',{multiline:true});
 if(!TAX_OPTIONS.includes(Number(draft.tax)))throw Error('Invalid creator tax.');
 const raw=Array.isArray(draft.quotes)?draft.quotes:[];
 if(raw.length<1||raw.length>5)throw Error('Choose between 1 and 5 assets to connect to.');
 const seen=new Set(),quotes=[];
 for(const q of raw){const a=String(q.address||'').trim();if(!address.test(a)||/^0x0{40}$/i.test(a))throw Error('One selected asset has an invalid contract address.');const k=a.toLowerCase();if(seen.has(k))throw Error('Each synced asset can only be selected once.');seen.add(k);if(equal(k,R.weth))throw Error('WETH cannot be a PAR market asset (PAR uses native ETH for that).');quotes.push({address:a,symbol:Core.sanitizeForDisplay(String(q.symbol||'TOKEN'),{maxLength:16}).toUpperCase()||'TOKEN',intent:Core.sanitizeForDisplay(String(q.intent||''),{maxLength:160})});}
 const feeMode=String(draft.feeMode||'');
 if(!Object.prototype.hasOwnProperty.call(FEE_MODES,feeMode))throw Error('Choose where the creator share of fees goes.');
 let feeRecipient=FEE_MODES[feeMode];
 if(feeMode==='creator'){
  feeRecipient=String(draft.feeRecipient||draft.account||'').trim();
  const chk=Chain.recipientStaticCheck(feeRecipient,{quotes:quotes.map(q=>q.address),extraBlocked:draft.blockedRecipients||{}});
  if(!chk.ok)throw fail(chk.error,{field:'Fee recipient',code:'RECIPIENT'});
  if(equal(feeRecipient,FACTORY)||equal(feeRecipient,PRICER)||equal(feeRecipient,ROUTER))throw fail('The fee recipient cannot be a PAR system contract.',{field:'Fee recipient',code:'RECIPIENT'});
 }
 let openingBuyWei=0n;
 try{openingBuyWei=BigInt(String(draft.openingBuyWei??'0')||'0')}catch{throw Error('Opening buy amount is not valid.')}
 if(openingBuyWei<0n)throw Error('Opening buy amount is not valid.');
 if(openingBuyWei>MAX_OPENING_BUY_WEI)throw Error('Opening buy is limited to 10 ETH in this build.');
 const slippageBps=Number(draft.slippageBps||100);
 if(!SLIPPAGE_BPS.includes(slippageBps))throw Error('Invalid price-protection setting.');
 return {...draft,name,symbol,description,tax:Number(draft.tax),quotes,feeMode,feeRecipient,openingBuyWei,slippageBps,logo:safeLogo(draft.logo),twitter:safeUrl(draft.twitter,'X link'),website:safeUrl(draft.website,'Website'),contractRecipientAck:draft.contractRecipientAck===true};
}
async function walletState(provider,account,chain=CHAIN){const live=Number(await provider.request({method:'eth_chainId'}));if(live!==chain)throw Error(chain===CHAIN?'Your wallet is on chain '+live+'. Switch it to Robinhood Chain (4663) with the SWITCH NETWORK button, then simulate again.':'Switch your wallet to the rehearsal network (chain '+chain+').');const accounts=await provider.request({method:'eth_accounts'});if(!accounts?.[0]||!equal(accounts[0],account))throw Error('Wallet account changed. Reconnect and run the simulation again.');}
/**
 * Independent cross-check: calldata built with viem (vendor/viem.js) is decoded again with SyncNet's own ABI decoder
 * (lib/syncnet-core.js). Two independent implementations must agree on every field before anything is simulated or sent.
 */
function crossCheck(data,{params,pairTokens,legs,minTokensOut}){
 let d;try{d=Core.decodeLaunchCalldata(data)}catch{throw fail('Internal calldata cross-check failed (decode). Nothing was sent.',{code:'CROSSCHECK'})}
 const p=d.params,x=params,lc=v=>String(v).toLowerCase();
 const same=p.name===x.name&&p.symbol===x.symbol&&p.logo===x.logo&&p.description===x.description&&p.socials.twitter===x.socials.twitter&&p.socials.website===x.socials.website&&p.socials.telegram===''&&p.socials.discord===''&&p.socials.farcaster===''&&equal(p.creatorFeeRecipient,x.creatorFeeRecipient)&&Number(p.creatorTaxBps)===Number(x.creatorTaxBps)&&lc(p.expectedEconomics)===lc(x.expectedEconomics)&&lc(p.salt)===lc(x.salt)&&d.launchConfigId===0n&&d.pairTokens.length===pairTokens.length&&d.pairTokens.every((a,i)=>equal(a,pairTokens[i]));
 const legsOk=legs?(d.fn==='launchAndBuyWithEth'&&d.legs.length===legs.length&&d.legs.every((l,i)=>Number(l.market)===Number(legs[i].market)&&BigInt(l.amountIn)===BigInt(legs[i].amountIn)&&l.hops.length===legs[i].hops.length)&&BigInt(d.minTokensOut)===BigInt(minTokensOut)):d.fn==='launchToken';
 if(!same||!legsOk)throw fail('Internal calldata cross-check failed: two independent encoders disagree. Nothing was sent.',{code:'CROSSCHECK'});
}
function deepFreeze(o){if(o&&typeof o==='object'&&!Object.isFrozen(o)){Object.freeze(o);for(const k of Object.keys(o))deepFreeze(o[k])}return o}

/**
 * prepare() → P, an immutable prepared launch:
 * { id, chainId, account, draft, params, pairTokens, predicted, request:{account,to,data,value}, gas, economics, parState, parChecks,
 *   openingBuy, provenanceRecord, provenanceJson, recordHash, salt, recipient:{kind}, nonceAtPrepare, createdAt }
 */
async function prepare({client,provider,draft,viem,chainId}){
 const CHAIN_ID=Number(chainId||CHAIN);
 draft=normalize(draft);await walletState(provider,draft.account,CHAIN_ID);
 if(await client.getChainId()!==CHAIN_ID)throw Error('RPC returned an unexpected chain.');
 const rpc=rpcOf(client);
 // 1) Live PAR preflight: every assumption about PAR is re-read from the chain now.
 const parState=await Chain.readParState(rpc,{account:draft.account,quotes:draft.quotes.map(q=>q.address),feeMode:draft.feeMode});
 const parChecks=Chain.parChecks(parState,{chainId:CHAIN_ID,openingBuy:draft.openingBuyWei>0n,feeMode:draft.feeMode,account:draft.account,tax:draft.tax});
 const blocking=parChecks.filter(c=>c.severity==='block');
 if(blocking.length)throw fail('PAR live preflight failed: '+blocking.map(c=>c.label+' (expected '+c.expected+', got '+c.actual+')').join('; ')+'. Nothing was sent.',{parChecks,parState,code:'PREFLIGHT'});
 const fee=BigInt(parState.launchFee),base=BigInt(parState.baseFeeBps),protocolShare=BigInt(parState.protocolFeeShareBps),max=BigInt(parState.maxCreatorTaxBps);
 if(BigInt(draft.tax)>max)throw Error('Creator tax exceeds the current PAR limit.');
 const supply=parState.launchConfig&&parState.launchConfig.supply?BigInt(parState.launchConfig.supply):SUPPLY_FALLBACK;
 // 2) Markets: each quote must be priceable by PAR's pricer right now.
 const quoteChecks=await Promise.all(draft.quotes.map(async q=>({q,ok:await read(client,PRICER,'isPriceable',[q.address],['address'],'bool')})));
 const failed=quoteChecks.filter(x=>!x.ok);if(failed.length)throw Error('Not currently eligible to sync via PAR: '+failed.map(x=>x.q.symbol).join(', ')+'.');
 for(const to of [FACTORY,...(draft.feeMode==='creator'?[]:[draft.feeRecipient]),...draft.quotes.map(q=>q.address)]){const code=await client.getBytecode({address:to});if(!code||code==='0x')throw Error('A required contract is missing on this chain.');}
 // 3) Creator-fee recipient: contracts need an explicit acknowledgement; launched PAR tokens are refused.
 let recipient={kind:'vault',mode:draft.feeMode};
 if(draft.feeMode==='creator'){
  recipient=await Chain.classifyRecipient(rpc,draft.feeRecipient);
  if(recipient.kind==='par-launch-token')throw fail('The fee recipient is a PAR-launched token contract. Fees credited to it could never be claimed.',{code:'RECIPIENT'});
  if(recipient.kind==='contract'&&!draft.contractRecipientAck)throw fail('The fee recipient is a contract, not a wallet. Only a contract that can call PAR’s fee escrow and transferCreatorFeeRecipient can use or move this right (for example a Safe). Tick the contract-recipient confirmation in step 03 if that is intended.',{code:'CONTRACT_RECIPIENT'});
  recipient={kind:recipient.kind};
 }
 // 4) Economics. PAR's expectedEconomics digest covers per-market phantom reserves, supply, tick spacing, base fee and protocol share.
 //    For markets PAR prices from live spot (non-curated quotes) that digest moves with every trade on the route, so committing to it
 //    would make the launch revert on ordinary price movement. SyncNet therefore commits the digest only when every market is curated
 //    (owner-set economics); otherwise it waives it (0x0), re-reads the owner-controlled parameters right before sending, and records
 //    the actual values after inclusion.
 const pairTokens=draft.quotes.map(q=>q.address);
 const curatedAll=parState.curated.length===pairTokens.length&&parState.curated.every(c=>c.curated);
 let digest=null,phantoms=null;
 try{const h=await client.call({to:FACTORY,data:Chain.SEL.previewLaunchEconomics+Core.abiEncode(['uint256','address[]'],[0n,pairTokens]).slice(2)});digest=h&&h.data?Core.abiDecode(['bytes32'],h.data)[0]:null}catch{digest=null}
 try{const h=await client.call({to:FACTORY,data:Chain.SEL.previewQuoteEconomics+Core.abiEncode(['uint256','address[]'],[0n,pairTokens]).slice(2)});phantoms=h&&h.data?Core.abiDecode(['uint256[]'],h.data)[0].map(String):null}catch{phantoms=null}
 const commitment=curatedAll&&digest?{mode:'committed',digest,reason:'Every market uses PAR-curated economics, so the launch reverts if PAR changes them before inclusion.'}:{mode:'waived',digest:ZERO,previewDigest:digest,reason:'At least one market is priced from live spot ('+draft.quotes.filter((q,i)=>!(parState.curated[i]&&parState.curated[i].curated)).map(q=>q.symbol).join(', ')+'); committing would revert on normal price movement. SyncNet re-reads PAR’s fee parameters right before sending and records the actual values after launch.'};
 // 5) Intent record → recordHash → salt (unchanged schema: syncnet.intent.v1).
 const nonceBytes=new Uint8Array(16);crypto.getRandomValues(nonceBytes);const nonce='0x'+Array.from(nonceBytes,b=>b.toString(16).padStart(2,'0')).join('');
 const provenanceRecord={schema:'syncnet.intent.v1',chainId:CHAIN_ID,operator:draft.account.toLowerCase(),name:draft.name,symbol:draft.symbol,description:draft.description,logo:draft.logo,twitter:draft.twitter||'',website:draft.website||'',creatorTaxBps:draft.tax,feeMode:draft.feeMode,creatorFeeRecipient:draft.feeRecipient.toLowerCase(),openingBuy:draft.openingBuyWei>0n?{ethWei:draft.openingBuyWei.toString(),slippageBps:draft.slippageBps,router:ROUTER.toLowerCase()}:null,connections:draft.quotes.map(q=>({address:q.address.toLowerCase(),symbol:q.symbol,intent:q.intent||''})),nonce,createdAt:new Date().toISOString()};
 const provenanceJson=JSON.stringify(provenanceRecord);
 const recordHash=viem.keccak256(viem.stringToHex(provenanceJson));
 const salt=viem.keccak256(viem.encodeAbiParameters([{type:'string'},{type:'bytes32'}],[PROVENANCE_DOMAIN,recordHash]));
 if(recordHash!==Core.recordHashOf(provenanceJson)||salt!==Core.intentSalt(recordHash))throw Error('Internal hashing self-check failed. Nothing was sent.');
 const params={name:draft.name,symbol:draft.symbol,logo:draft.logo,description:draft.description,socials:{twitter:draft.twitter||'',telegram:'',discord:'',website:draft.website||'',farcaster:''},creatorFeeRecipient:draft.feeRecipient,creatorTaxBps:draft.tax,expectedEconomics:commitment.digest,salt};
 // 6) Exact simulation of the exact calldata.
 let request,predicted,openingBuy=null;
 if(draft.openingBuyWei===0n){
  const data=viem.encodeFunctionData({abi:ABI,functionName:'launchToken',args:[params,0n,pairTokens]});
  request={account:draft.account,to:FACTORY,data,value:fee};
  crossCheck(data,{params,pairTokens});
  const result=await client.call(request);predicted=viem.decodeFunctionResult({abi:ABI,functionName:'launchToken',data:result.data});
 }else{
  const forwarder=await read(client,FACTORY,'launchForwarder',[],[],'address');
  if(!equal(forwarder,ROUTER))throw Error('PAR’s launch router is not the one SyncNet expects ('+forwarder+'). Opening buy is disabled until SyncNet is updated — set it to 0 to launch without it.');
  const routes=await Promise.all(draft.quotes.map(q=>client.readContract({address:PRICER,abi:PRICER_ROUTE_ABI,functionName:'route',args:[q.address]})));
  const reachable=[],unreachable=[];
  for(let i=0;i<routes.length;i++){const r=routes[i];const hops=Array.isArray(r?.[0])?r[0]:[];const qualifies=Boolean(r?.[1]);
   if(!hops.length||!qualifies){unreachable.push(draft.quotes[i].symbol);continue}
   for(const h of hops){if(!h.v3&&!/^0x0{40}$/i.test(String(h.key.hooks))){const ok=await Chain.ethCall(rpc,PRICER,Chain.SEL.allowedV4Hooks+Core.abiEncode(['address'],[h.key.hooks]).slice(2)).then(x=>x&&x!=='0x'&&BigInt(x)===1n).catch(()=>false);if(!ok)throw Error('The PAR route for '+draft.quotes[i].symbol+' uses a Uniswap v4 hook that PAR’s pricer does not allow. Opening buy refused.')}}
   reachable.push({market:i,hops:[...hops].reverse().map(h=>({key:{currency0:h.key.currency0,currency1:h.key.currency1,fee:h.key.fee,tickSpacing:h.key.tickSpacing,hooks:h.key.hooks},v3:Boolean(h.v3)}))});}
  if(!reachable.length)throw Error('None of the selected markets can be reached from ETH, so an opening buy is not possible. Set it to 0.');
  const n=BigInt(reachable.length),each=draft.openingBuyWei/n,dust=draft.openingBuyWei-each*n;
  const legs=reachable.map((x,k)=>({market:x.market,hops:x.hops,amountIn:each+(k===0?dust:0n)}));
  if(legs.some(l=>l.amountIn===0n))throw Error('Opening buy is too small to split across the markets.');
  const value=fee+draft.openingBuyWei;
  const quoteData=viem.encodeFunctionData({abi:ROUTER_ABI,functionName:'launchAndBuyWithEth',args:[params,0n,pairTokens,legs,0n]});
  const q=await client.call({account:draft.account,to:ROUTER,data:quoteData,value});
  const [tokenQ,tokensOut]=viem.decodeFunctionResult({abi:ROUTER_ABI,functionName:'launchAndBuyWithEth',data:q.data});
  if(!(tokensOut>0n))throw Error('The opening buy simulation returned no tokens.');
  const minTokensOut=tokensOut*BigInt(10000-draft.slippageBps)/10000n;
  const data=viem.encodeFunctionData({abi:ROUTER_ABI,functionName:'launchAndBuyWithEth',args:[params,0n,pairTokens,legs,minTokensOut]});
  request={account:draft.account,to:ROUTER,data,value};
  crossCheck(data,{params,pairTokens,legs,minTokensOut});
  const confirm=await client.call(request);const [tokenC]=viem.decodeFunctionResult({abi:ROUTER_ABI,functionName:'launchAndBuyWithEth',data:confirm.data});
  if(!equal(tokenC,tokenQ))throw Error('Opening buy simulation was not stable. Nothing was sent — run it again.');
  predicted=tokenC;
  openingBuy={router:ROUTER,ethWei:draft.openingBuyWei,slippageBps:draft.slippageBps,expectedTokens:tokensOut,minTokens:minTokensOut,supplyBps:Number(tokensOut*10000n/supply),legs:legs.map(l=>({market:l.market,symbol:draft.quotes[l.market].symbol,ethWei:l.amountIn,hops:l.hops.length})),unreachable};
 }
 if(!address.test(predicted)||/^0x0{40}$/i.test(predicted))throw Error('Simulation returned an invalid token address.');
 if(draft.feeMode==='creator'&&equal(predicted,draft.feeRecipient))throw Error('The fee recipient cannot be the token being launched.');
 const existing=await Chain.readLaunch(rpc,predicted).catch(()=>null);
 if(existing)throw fail('A PAR token already exists at the predicted address '+predicted+'. This launch was already executed. Nothing was sent.',{code:'ALREADY_LAUNCHED',predicted});
 const gas=await client.estimateGas(request);
 let nonceAtPrepare=null,gasPrice=null;
 try{const [bal,price,nonceHex]=await Promise.all([client.request({method:'eth_getBalance',params:[draft.account,'latest']}),client.request({method:'eth_gasPrice'}),client.request({method:'eth_getTransactionCount',params:[draft.account,'pending']}).catch(()=>null)]);gasPrice=BigInt(price);nonceAtPrepare=nonceHex==null?null:Number(nonceHex);const need=BigInt(request.value)+(gas*150n/100n)*BigInt(price);if(BigInt(bal)<need)throw Object.assign(Error('Not enough ETH in this wallet: the launch needs about '+viem.formatEther(need)+' ETH (value + gas) and the wallet holds '+viem.formatEther(BigInt(bal))+' ETH.'),{balance:true})}catch(e){if(e&&e.balance)throw e}
 await walletState(provider,draft.account,CHAIN_ID);
 const poolFee=Number((base+BigInt(draft.tax))*100n);
 const P={
  id:recordHash,createdAt:new Date().toISOString(),chainId:CHAIN_ID,account:draft.account,draft,params,pairTokens,predicted,
  request,gas:(gas*150n+99n)/100n,gasPrice,nonceAtPrepare,
  economics:{launchFee:fee,baseFeeBps:Number(base),protocolFeeShareBps:Number(protocolShare),maxCreatorTaxBps:Number(max),creatorTaxBps:draft.tax,poolFee,supply,tickSpacing:parState.launchConfig?parState.launchConfig.tickSpacing:null,commitment,marketPhantoms:phantoms,curated:parState.curated},
  parState,parChecks,openingBuy,provenanceRecord,provenanceJson,recordHash,salt,recipient,
  fn:draft.openingBuyWei===0n?'launchToken':'launchAndBuyWithEth',
  // legacy fields kept for older UI code
  poolFee,baseFeeBps:Number(base),protocolFeeShareBps:Number(protocolShare),launchFee:fee,
 };
 return deepFreeze(P);
}

/**
 * Right before the wallet is asked to send: re-read everything that could have changed and re-simulate P.request.
 * Returns { ok:true } or throws with a precise reason. Never mutates P.
 */
async function presendCheck({client,P}){
 const rpc=rpcOf(client);
 if(await client.getChainId()!==P.chainId)throw Error('RPC chain changed since preparation. Nothing was sent.');
 const now=await Chain.readParState(rpc,{account:P.account,quotes:P.pairTokens,feeMode:P.draft.feeMode});
 const changes=[];
 if(String(now.launchFee)!==String(P.economics.launchFee))changes.push('launch fee '+P.economics.launchFee+' → '+now.launchFee);
 if(now.baseFeeBps!==P.economics.baseFeeBps)changes.push('base fee '+P.economics.baseFeeBps+' → '+now.baseFeeBps+' bps');
 if(now.protocolFeeShareBps!==P.economics.protocolFeeShareBps)changes.push('protocol share '+P.economics.protocolFeeShareBps+' → '+now.protocolFeeShareBps+' bps');
 if(!now.launchConfig||!now.launchConfig.enabled)changes.push('launch config 0 disabled');
 if(now.canLaunch===false)changes.push('PAR no longer allows this wallet to launch');
 if(P.openingBuy&&!equal(now.launchForwarder,ROUTER))changes.push('launch router changed');
 if(changes.length)throw fail('PAR parameters changed since your review: '+changes.join('; ')+'. Run the simulation again. Nothing was sent.',{code:'PAR_CHANGED',changes});
 const existing=await Chain.readLaunch(rpc,P.predicted).catch(()=>null);
 if(existing)throw fail('A token already exists at the predicted address '+P.predicted+'. This launch was already executed. Nothing was sent.',{code:'ALREADY_LAUNCHED'});
 const code=await Chain.getCode(rpc,P.predicted).catch(()=>'0x');
 if(code&&code!=='0x')throw fail('Contract code already exists at the predicted address. Nothing was sent.',{code:'ALREADY_LAUNCHED'});
 const r=await client.call(P.request);
 const out=r&&r.data?String(r.data):'';
 const tokenWord='0x'+out.slice(26,66);
 if(!equal(tokenWord,P.predicted))throw Error('The final re-simulation predicted a different token address. Nothing was sent.');
 if(P.openingBuy){const tokensOut=BigInt('0x'+(out.slice(66,130)||'0'));if(tokensOut<BigInt(P.openingBuy.minTokens))throw Error('The opening buy would now return fewer tokens than your minimum. Nothing was sent — simulate again.')}
 return {ok:true,checkedAt:new Date().toISOString()};
}

window.SyncNetLaunchV2=Object.freeze({prepare,presendCheck,normalize,modeForRecipient,ROUTER,SUPPLY:SUPPLY_FALLBACK,FACTORY,PRICER,VAULT,HOLDER_VAULT:VAULT,BURN_VAULT,FLOOR_VAULT,FEE_MODES,CHAIN,TAX_OPTIONS});
})();
