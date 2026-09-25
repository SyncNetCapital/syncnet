'use strict';

/* =========================================================
   SYNC DUEL // PVP
   Free local skill game with two modes:
   - PRACTICE: play against a deterministic ghost.
   - REAL DUEL: asynchronous peer challenge via a shareable URL.

   IMPORTANT: This build has NO stake, prize, payment, wallet
   requirement or token transfer. Challenge payloads are client-side
   and deliberately carry no financial consequence. A future mode
   with prizes or financial settlement would require a server-side
   anti-cheat boundary and separate compliance review.
   ========================================================= */
const SYNC_DUEL = (() => {
  const ROUNDS = 5;
  const ROUND_MS = 8000;
  const STORAGE_KEY = "syncnet.duel.v2";
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

  const el = id => document.getElementById(id);
  const ui = {
    teaser:el("duelTeaser"), panel:el("duelPanel"), lobby:el("duelLobby"), game:el("duelGame"), result:el("duelResult"),
    panelMode:el("duelPanelMode"), modeGrid:el("duelModeGrid"), modePractice:el("duelModePractice"), modeReal:el("duelModeReal"),
    enter:el("duelEnter"), close:el("duelClose"), start:el("duelStart"), again:el("duelAgain"), share:el("duelShare"),
    sharePanel:el("duelSharePanel"), shareText:el("duelShareText"), copyShare:el("duelCopyShare"), seed:el("duelSeed"),
    opponentName:el("duelOpponentName"), disclaimer:el("duelDisclaimer"), challengeCard:el("duelChallengeCard"),
    challengeKicker:el("duelChallengeKicker"), challengeTitle:el("duelChallengeTitle"), challengeCopy:el("duelChallengeCopy"),
    challengeLinkPanel:el("duelChallengeLinkPanel"), challengeUrl:el("duelChallengeUrl"), copyChallenge:el("duelCopyChallenge"),
    roundNo:el("duelRoundNo"), gameMode:el("duelGameMode"), priceA:el("duelPriceA"), priceB:el("duelPriceB"), div:el("duelDivergence"), clock:el("duelClock"),
    sync:el("duelSync"), pathA:el("duelPathA"), pathB:el("duelPathB"), lockLine:el("duelLockLine"),
    lockDotA:el("duelLockDotA"), lockDotB:el("duelLockDotB"), lockResult:el("duelLockResult"),
    userLock:el("duelUserLock"), ghostLock:el("duelGhostLock"), userClass:el("duelUserClass"), ghostClass:el("duelGhostClass"),
    opponentRoundLabel:el("duelOpponentRoundLabel"), roundOutcome:el("duelRoundOutcome"), roundScore:el("duelRoundScore"), roundStrip:el("duelRoundStrip"),
    resultMode:el("duelResultMode"), finalYou:el("duelFinalYou"), finalGhost:el("duelFinalGhost"), finalOpponentLabel:el("duelFinalOpponentLabel"),
    verdict:el("duelVerdict"), finalBest:el("duelFinalBest"), finalAvg:el("duelFinalAvg"), finalRounds:el("duelFinalRounds"), finalRoundsLabel:el("duelFinalRoundsLabel"), finalScore:el("duelFinalScore"),
    pointsEarned:el("duelPointsEarned"), pointsBreakdown:el("duelPointsBreakdown"),
    recDuels:el("duelRecordDuels"), recWins:el("duelRecordWins"), recBest:el("duelRecordBest"), recPoints:el("duelRecordPoints"), recStreak:el("duelRecordStreak")
  };

  let incomingChallenge = parseChallengeFromUrl();
  let record = loadRecord();
  let mode = incomingChallenge ? "real-accept" : "practice";
  let state = resetState(incomingChallenge?.seed || createSeed());
  let rafId = 0;
  let nextTimer = 0;
  let lastReducedDraw = 0;

  function resetState(seed = createSeed()) {
    return {seed, roundIndex:0, rounds:[], ghostRounds:[], running:false, locked:false, startTime:0, currentRound:null};
  }

  function loadRecord() {
    const fallback = {xp:0,practiceDuels:0,practiceWins:0,realDuels:0,realWins:0,bestSync:null,bestScore:0,streak:0};
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (raw && typeof raw === "object") {
        return {
          xp:Number(raw.xp)||0, practiceDuels:Number(raw.practiceDuels)||0, practiceWins:Number(raw.practiceWins)||0,
          realDuels:Number(raw.realDuels)||0, realWins:Number(raw.realWins)||0,
          bestSync:raw.bestSync != null && Number.isFinite(Number(raw.bestSync)) ? Number(raw.bestSync) : null,
          bestScore:Number(raw.bestScore)||0, streak:Number(raw.streak)||0
        };
      }
      // One-time migration from the old practice record.
      const old = JSON.parse(localStorage.getItem("syncnet.practice.v1") || "null");
      if (old && typeof old === "object") {
        return {...fallback, xp:Number(old.points)||0, practiceDuels:Number(old.duels)||0, practiceWins:Number(old.wins)||0,
          bestSync:old.bestSync != null && Number.isFinite(Number(old.bestSync)) ? Number(old.bestSync) : null,
          bestScore:Number(old.bestScore)||0};
      }
      return fallback;
    } catch (_) { return fallback; }
  }

  function saveRecord() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(record)); } catch (_) {} }

  function updateRecordUI() {
    const total = record.practiceDuels + record.realDuels;
    ui.recDuels.textContent = total.toLocaleString("en-US");
    ui.recWins.textContent = record.realWins.toLocaleString("en-US");
    ui.recBest.textContent = record.bestSync == null ? "—" : formatPct(record.bestSync);
    ui.recPoints.textContent = record.xp.toLocaleString("en-US");
    ui.recStreak.textContent = String(record.streak);
  }

  function createSeed() {
    const bytes = new Uint32Array(1);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
    else bytes[0] = (Date.now() ^ performance.now() * 1000) >>> 0;
    return `SYNC-${String(bytes[0] % 1000000).padStart(6,"0")}`;
  }

  function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i=0;i<str.length;i++) { h ^= str.charCodeAt(i); h = Math.imul(h,16777619); }
    h += h << 13; h ^= h >>> 7; h += h << 3; h ^= h >>> 17; h += h << 5;
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function roundParams(seed, roundIndex) {
    const r = mulberry32(hash32(`${seed}:round:${roundIndex}`));
    return {
      commonAmp:.00045+r()*.00075, commonFreq:.18+r()*.38, commonPhase:r()*Math.PI*2,
      aAmp:.0022+r()*.0036, bAmp:.0022+r()*.0036,
      aFreq:.78+r()*1.18, bFreq:.78+r()*1.18,
      aPhase:r()*Math.PI*2, bPhase:r()*Math.PI*2,
      aAmp2:.00055+r()*.00135, bAmp2:.00055+r()*.00135,
      aFreq2:2.1+r()*2.2, bFreq2:2.1+r()*2.2,
      aPhase2:r()*Math.PI*2, bPhase2:r()*Math.PI*2,
      aDrift:(r()-.5)*.0032, bDrift:(r()-.5)*.0032,
      bow:(r()-.5)*.0012
    };
  }

  function pricesAt(params, ms) {
    const t = Math.max(0,Math.min(1,ms/ROUND_MS));
    const tau = Math.PI*2;
    const common = params.commonAmp*Math.sin(tau*(params.commonFreq*t)+params.commonPhase) + params.bow*Math.sin(Math.PI*t);
    const a = 1 + common + params.aDrift*(t-.5) + params.aAmp*Math.sin(tau*(params.aFreq*t)+params.aPhase) + params.aAmp2*Math.sin(tau*(params.aFreq2*t)+params.aPhase2);
    const b = 1 + common + params.bDrift*(t-.5) + params.bAmp*Math.sin(tau*(params.bFreq*t)+params.bPhase) + params.bAmp2*Math.sin(tau*(params.bFreq2*t)+params.bPhase2);
    return {a:Math.max(.97,Math.min(1.03,a)),b:Math.max(.97,Math.min(1.03,b))};
  }

  function divergencePct(a,b) { return Math.abs(a-b)/((a+b)/2)*100; }
  function scoreFor(pct) { return Math.max(0,Math.min(1000,Math.round(1000-(pct*100)*10))); }
  function classify(pct) {
    if (pct < .05) return "PERFECT SYNC";
    if (pct < .15) return "CLEAN SYNC";
    if (pct < .40) return "CLOSE";
    if (pct < .75) return "DRIFTED";
    return "OUT OF SYNC";
  }
  function formatPct(pct) { return `${pct.toFixed(pct < 1 ? 3 : 2)}%`; }

  function ghostResult(seed, roundIndex, params) {
    const r = mulberry32(hash32(`${seed}:ghost:${roundIndex}`));
    const candidates = [];
    let prev = null;
    for (let ms=450;ms<=7550;ms+=70) {
      const p = pricesAt(params,ms); const d = divergencePct(p.a,p.b);
      if (prev && prev.d <= d && prev.d <= (prev.prevD ?? Infinity)) candidates.push(prev);
      prev = {ms,d,prevD:prev?.d};
    }
    if (!candidates.length) {
      for (let ms=650;ms<=7350;ms+=140) { const p=pricesAt(params,ms); candidates.push({ms,d:divergencePct(p.a,p.b)}); }
    }
    candidates.sort((x,y)=>x.d-y.d);
    const rank = Math.min(candidates.length-1, Math.floor(r()*Math.min(6,candidates.length)));
    const chosen = candidates[rank] || {ms:ROUND_MS*.5};
    const offsetSign = r() < .5 ? -1 : 1;
    const offset = offsetSign*(110+r()*520);
    const ms = Math.max(250,Math.min(ROUND_MS-120,chosen.ms+offset));
    const p = pricesAt(params,ms); const pct = divergencePct(p.a,p.b);
    return {ms,pct,score:scoreFor(pct),classification:classify(pct)};
  }

  function bytesToBase64Url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  }

  function base64UrlToString(value) {
    const clean = value.replace(/-/g,"+").replace(/_/g,"/");
    const padded = clean + "=".repeat((4-clean.length%4)%4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function makeChallengePayload() {
    const scores = state.rounds.map(r => Math.round(r.score));
    const payload = {v:1,s:state.seed,r:scores};
    return bytesToBase64Url(JSON.stringify(payload));
  }

  function challengeUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("duel", makeChallengePayload());
    url.hash = "sync-duel";
    return url.toString();
  }

  function parseChallengeFromUrl() {
    try {
      const encoded = new URL(window.location.href).searchParams.get("duel");
      if (!encoded || encoded.length > 800) return null;
      const raw = JSON.parse(base64UrlToString(encoded));
      if (raw?.v !== 1 || !/^SYNC-\d{6}$/.test(String(raw.s||"")) || !Array.isArray(raw.r) || raw.r.length !== ROUNDS) return null;
      const scores = raw.r.map(Number);
      if (scores.some(x => !Number.isInteger(x) || x < 0 || x > 1000)) return null;
      return {seed:String(raw.s), rounds:scores, total:scores.reduce((a,b)=>a+b,0)};
    } catch (_) { return null; }
  }

  function clearChallengeUrl() {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("duel");
      if (url.hash === "#sync-duel") url.hash = "";
      history.replaceState({},"",url.pathname + (url.search||"") + (url.hash||""));
    } catch (_) {}
  }

  function showOnly(which) {
    ui.lobby.hidden = which !== "lobby";
    ui.game.hidden = which !== "game";
    ui.result.hidden = which !== "result";
  }

  function setMode(nextMode, {keepSeed=false}={}) {
    mode = nextMode;
    if (!keepSeed) state = resetState(nextMode === "real-accept" && incomingChallenge ? incomingChallenge.seed : createSeed());
    ui.modePractice.classList.toggle("active", nextMode === "practice");
    ui.modeReal.classList.toggle("active", nextMode !== "practice");
    ui.challengeCard.hidden = nextMode === "practice";
    ui.seed.textContent = state.seed;
    ui.challengeLinkPanel.hidden = true;
    ui.sharePanel.classList.remove("open");

    if (nextMode === "practice") {
      ui.panelMode.textContent = "// PRACTICE";
      ui.opponentName.textContent = "PRACTICE GHOST";
      ui.challengeCard.hidden = true;
      ui.start.textContent = "Start practice";
      ui.disclaimer.textContent = "SIMULATED MARKET PATH · SYNC XP IS OFF-CHAIN, NON-TRANSFERABLE AND HAS NO MONETARY VALUE.";
    } else if (nextMode === "real-accept" && incomingChallenge) {
      ui.panelMode.textContent = "// REAL DUEL";
      ui.opponentName.textContent = "CHALLENGER";
      ui.challengeKicker.textContent = "CHALLENGE RECEIVED";
      ui.challengeTitle.textContent = "Same market. Same five rounds.";
      ui.challengeCopy.textContent = "The challenger has already played this exact sequence. Their score stays hidden until you finish.";
      ui.start.textContent = "Accept challenge";
      ui.disclaimer.textContent = "FREE PVP · NO WALLET · NO STAKE · NO PRIZE · NO TOKEN TRANSFER.";
    } else {
      mode = "real-create";
      ui.panelMode.textContent = "// REAL DUEL";
      ui.opponentName.textContent = "A REAL PLAYER";
      ui.challengeKicker.textContent = "REAL DUEL";
      ui.challengeTitle.textContent = "Create a challenge.";
      ui.challengeCopy.textContent = "Play first. After five rounds, SyncNet creates a link that gives another player the exact same market sequence.";
      ui.start.textContent = "Create challenge";
      ui.disclaimer.textContent = "FREE PVP · CASUAL PEER CHALLENGE · NO WALLET · NO STAKE · NO PRIZE · NO TOKEN TRANSFER.";
    }
  }

  function openDuel() {
    ui.teaser.style.display = "none";
    ui.panel.classList.add("open");
    if (incomingChallenge) setMode("real-accept", {keepSeed:true});
    else setMode(mode === "practice" ? "practice" : "real-create", {keepSeed:true});
    updateRecordUI();
    showOnly("lobby");
    setTimeout(()=>ui.start.focus(),0);
  }

  function closeDuel() {
    cancelAnimationFrame(rafId); clearTimeout(nextTimer);
    state.running=false; state.locked=true;
    ui.panel.classList.remove("open");
    ui.teaser.style.display = "grid";
  }

  function startDuel() {
    cancelAnimationFrame(rafId); clearTimeout(nextTimer);
    const seed = (mode === "real-accept" && incomingChallenge) ? incomingChallenge.seed : (state.seed || createSeed());
    state = resetState(seed);
    ui.seed.textContent = state.seed;
    ui.roundStrip.innerHTML = "";
    ui.sharePanel.classList.remove("open");
    ui.challengeLinkPanel.hidden = true;
    ui.gameMode.textContent = mode === "practice" ? "Practice path" : mode === "real-accept" ? "Challenge path · opponent hidden" : "Challenge path";
    showOnly("game");
    startRound();
  }

  function startRound() {
    cancelAnimationFrame(rafId); clearTimeout(nextTimer);
    state.running=true; state.locked=false;
    state.currentRound = roundParams(state.seed,state.roundIndex);
    state.startTime = performance.now();
    lastReducedDraw=0;
    ui.roundNo.textContent = `ROUND ${state.roundIndex+1} / ${ROUNDS}`;
    ui.sync.disabled=false; ui.sync.textContent="SYNC";
    ui.lockResult.hidden=true;
    ui.lockLine.style.opacity="0"; ui.lockDotA.style.opacity="0"; ui.lockDotB.style.opacity="0";
    ui.pathA.setAttribute("d",""); ui.pathB.setAttribute("d","");
    drawFrame(0,true);
    rafId=requestAnimationFrame(tick);
  }

  function tick(now) {
    if (!state.running || state.locked) return;
    const elapsed=Math.min(ROUND_MS,now-state.startTime);
    if (!reducedMotion || now-lastReducedDraw>110) { drawFrame(elapsed,false); lastReducedDraw=now; }
    if (elapsed >= ROUND_MS) { lockRound(ROUND_MS,true); return; }
    rafId=requestAnimationFrame(tick);
  }

  function drawFrame(elapsed) {
    const p=pricesAt(state.currentRound,elapsed); const pct=divergencePct(p.a,p.b);
    ui.priceA.textContent=p.a.toFixed(6); ui.priceB.textContent=p.b.toFixed(6); ui.div.textContent=formatPct(pct);
    ui.clock.textContent=`${Math.max(0,(ROUND_MS-elapsed)/1000).toFixed(1)}s`;
    const n = reducedMotion ? 38 : 74;
    const samplesA=[],samplesB=[];
    const maxMs=Math.max(1,elapsed);
    for(let i=0;i<n;i++){
      const ms=maxMs*(i/(n-1)); const q=pricesAt(state.currentRound,ms);
      const x=(ms/ROUND_MS)*1000;
      const yA=Math.max(22,Math.min(238,130-(q.a-1)*10500));
      const yB=Math.max(22,Math.min(238,130-(q.b-1)*10500));
      samplesA.push(`${i?"L":"M"}${x.toFixed(1)},${yA.toFixed(1)}`);
      samplesB.push(`${i?"L":"M"}${x.toFixed(1)},${yB.toFixed(1)}`);
    }
    ui.pathA.setAttribute("d",samplesA.join(" ")); ui.pathB.setAttribute("d",samplesB.join(" "));
  }

  function lockRound(elapsed,autoLock=false) {
    if (!state.running || state.locked) return;
    state.locked=true; cancelAnimationFrame(rafId);
    elapsed=Math.max(0,Math.min(ROUND_MS,elapsed));
    drawFrame(elapsed);
    const p=pricesAt(state.currentRound,elapsed); const pct=divergencePct(p.a,p.b); const score=scoreFor(pct);
    const user={ms:elapsed,pct,score,classification:classify(pct),autoLock};
    state.rounds.push(user);
    ui.sync.disabled=true; ui.sync.textContent=autoLock?"TIME LOCK":"LOCKED";

    const x=(elapsed/ROUND_MS)*1000;
    const yA=Math.max(22,Math.min(238,130-(p.a-1)*10500));
    const yB=Math.max(22,Math.min(238,130-(p.b-1)*10500));
    ui.lockLine.setAttribute("x1",x); ui.lockLine.setAttribute("x2",x); ui.lockLine.style.opacity="1";
    ui.lockDotA.setAttribute("cx",x); ui.lockDotA.setAttribute("cy",yA); ui.lockDotA.style.opacity="1";
    ui.lockDotB.setAttribute("cx",x); ui.lockDotB.setAttribute("cy",yB); ui.lockDotB.style.opacity="1";

    ui.userLock.textContent=formatPct(user.pct);
    ui.userClass.textContent=`${user.classification} · ${user.score} pts`;

    let dotClass="tie";
    if (mode === "practice") {
      const ghost=ghostResult(state.seed,state.roundIndex,state.currentRound);
      state.ghostRounds.push(ghost);
      ui.opponentRoundLabel.textContent="Practice ghost";
      ui.ghostLock.textContent=formatPct(ghost.pct);
      ui.ghostClass.textContent=`${ghost.classification} · ${ghost.score} pts`;
      const outcome=user.score===ghost.score?"TIE":user.score>ghost.score?"YOU ✓":"GHOST ✓";
      ui.roundOutcome.textContent=outcome;
      ui.roundScore.textContent=`${user.score} / ${ghost.score}`;
      dotClass=user.score===ghost.score?"tie":user.score>ghost.score?"won":"lost";
    } else {
      ui.opponentRoundLabel.textContent=mode === "real-accept" ? "Challenger" : "Opponent";
      ui.ghostLock.textContent="HIDDEN";
      ui.ghostClass.textContent=mode === "real-accept" ? "REVEALED AFTER ROUND 5" : "WAITING FOR CHALLENGER";
      ui.roundOutcome.textContent="LOCKED";
      ui.roundScore.textContent=`${user.score} pts`;
      dotClass=user.pct < .15 ? "won" : "tie";
    }
    ui.lockResult.hidden=false;

    const dot=document.createElement("span"); dot.className=`duel-round-dot ${dotClass}`;
    ui.roundStrip.appendChild(dot);

    nextTimer=setTimeout(()=>{
      if(state.roundIndex < ROUNDS-1){ state.roundIndex++; startRound(); }
      else finishDuel();
    }, reducedMotion ? 850 : 1250);
  }

  function finishDuel() {
    state.running=false; state.locked=true; cancelAnimationFrame(rafId); clearTimeout(nextTimer);
    const userTotal=state.rounds.reduce((a,r)=>a+r.score,0);
    const best=Math.min(...state.rounds.map(r=>r.pct));
    const avg=state.rounds.reduce((a,r)=>a+r.pct,0)/state.rounds.length;
    const perfects=state.rounds.filter(r=>r.pct<.05).length;
    let won=false, tied=false, opponentTotal=null, roundsWon=0, roundsLost=0;

    if (mode === "practice") {
      opponentTotal=state.ghostRounds.reduce((a,r)=>a+r.score,0);
      roundsWon=state.rounds.filter((r,i)=>r.score>state.ghostRounds[i].score).length;
      roundsLost=state.rounds.filter((r,i)=>r.score<state.ghostRounds[i].score).length;
      won=userTotal>opponentTotal; tied=userTotal===opponentTotal;
      record.practiceDuels += 1;
      if (won) record.practiceWins += 1;
    } else if (mode === "real-accept" && incomingChallenge) {
      opponentTotal=incomingChallenge.total;
      roundsWon=state.rounds.filter((r,i)=>r.score>incomingChallenge.rounds[i]).length;
      roundsLost=state.rounds.filter((r,i)=>r.score<incomingChallenge.rounds[i]).length;
      won=userTotal>opponentTotal; tied=userTotal===opponentTotal;
      record.realDuels += 1;
      if(won){record.realWins+=1;record.streak+=1;} else if(!tied){record.streak=0;}
    } else {
      record.realDuels += 1;
    }

    const earned=25+(mode!=="practice"?25:0)+((mode==="real-accept"&&won)?50:0)+(perfects*10);
    record.xp += earned;
    record.bestScore=Math.max(record.bestScore,userTotal);
    record.bestSync=record.bestSync==null?best:Math.min(record.bestSync,best);
    saveRecord(); updateRecordUI();

    ui.finalYou.textContent=userTotal.toLocaleString("en-US");
    ui.finalBest.textContent=formatPct(best); ui.finalAvg.textContent=formatPct(avg); ui.finalScore.textContent=userTotal.toLocaleString("en-US");
    ui.challengeLinkPanel.hidden=true;
    ui.verdict.classList.remove("loss");

    if (mode === "practice") {
      ui.resultMode.textContent="Practice complete";
      ui.finalOpponentLabel.textContent="Practice ghost";
      ui.finalGhost.textContent=opponentTotal.toLocaleString("en-US");
      ui.verdict.textContent=tied?"IN SYNC":won?"YOU WIN":"OUT OF SYNC";
      ui.verdict.classList.toggle("loss",!won);
      ui.finalRoundsLabel.textContent="Rounds won";
      ui.finalRounds.textContent=`${roundsWon} / ${ROUNDS}`;
      ui.pointsBreakdown.textContent=`Complete +25${perfects?` · ${perfects} perfect ${perfects===1?"sync":"syncs"} +${perfects*10}`:""}`;
      ui.again.textContent="Play again";
      ui.share.textContent="Share result";
      ui.share.hidden=false;
      ui.shareText.textContent=`I just hit a ${formatPct(best)} lock in SYNC DUEL.\n\n${userTotal.toLocaleString("en-US")} points. ${roundsWon}–${roundsLost} vs the practice ghost.\n\nhow close can you get to zero?\n\n$SYNC\nsyncnet.capital`;
    } else if (mode === "real-create") {
      ui.resultMode.textContent="Real duel · challenge created";
      ui.finalOpponentLabel.textContent="Opponent";
      ui.finalGhost.textContent="WAITING";
      ui.verdict.textContent="CHALLENGE READY";
      ui.finalRoundsLabel.textContent="Mode";
      ui.finalRounds.textContent="PVP";
      ui.pointsBreakdown.textContent=`Complete +25 · Real duel +25${perfects?` · ${perfects} perfect ${perfects===1?"sync":"syncs"} +${perfects*10}`:""}`;
      const url=challengeUrl();
      ui.challengeUrl.value=url;
      ui.challengeLinkPanel.hidden=false;
      ui.again.textContent="New challenge";
      ui.share.textContent="Copy challenge link";
      ui.share.hidden=false;
      ui.shareText.textContent=`I scored ${userTotal.toLocaleString("en-US")} in SYNC DUEL.\n\nSame 5 rounds. Same market path. Beat me.\n\n${url}`;
    } else {
      ui.resultMode.textContent="Real duel complete";
      ui.finalOpponentLabel.textContent="Challenger";
      ui.finalGhost.textContent=opponentTotal.toLocaleString("en-US");
      ui.verdict.textContent=tied?"IN SYNC":won?"YOU WIN":"CHALLENGER WINS";
      ui.verdict.classList.toggle("loss",!won);
      ui.finalRoundsLabel.textContent="Rounds won";
      ui.finalRounds.textContent=`${roundsWon} / ${ROUNDS}`;
      ui.pointsBreakdown.textContent=`Complete +25 · Real duel +25${won?" · Win +50":""}${perfects?` · ${perfects} perfect ${perfects===1?"sync":"syncs"} +${perfects*10}`:""}`;
      ui.again.textContent="Create rematch";
      ui.share.textContent="Share result";
      ui.share.hidden=false;
      ui.shareText.textContent=`SYNC DUEL result:\n\nMe ${userTotal.toLocaleString("en-US")} — ${opponentTotal.toLocaleString("en-US")} Challenger\nBest lock: ${formatPct(best)}\n${won?"I took it.":tied?"Perfect tie.":"You got me."}\n\n$SYNC\nsyncnet.capital`;
    }

    ui.pointsEarned.textContent=`+${earned}`;
    ui.sharePanel.classList.remove("open");
    showOnly("result");
  }

  function playAgain(){
    if (mode === "real-accept") {
      incomingChallenge=null; clearChallengeUrl(); mode="real-create";
    }
    state=resetState(); ui.seed.textContent=state.seed; ui.sharePanel.classList.remove("open"); ui.challengeLinkPanel.hidden=true;
    setMode(mode === "practice" ? "practice" : "real-create", {keepSeed:true});
    showOnly("lobby");
  }

  async function copyText(text, button, original="Copy") {
    try {
      await navigator.clipboard.writeText(text);
      if(button){button.textContent="Copied";button.classList.add("duel-copied");setTimeout(()=>{button.textContent=original;button.classList.remove("duel-copied")},1200);}
    } catch (_) {
      if (ui.challengeUrl && text === ui.challengeUrl.value) { ui.challengeUrl.focus(); ui.challengeUrl.select(); }
    }
  }

  async function copyShare(){ await copyText(ui.shareText.textContent, ui.copyShare, "Copy"); }

  ui.enter?.addEventListener("click",openDuel);
  ui.close?.addEventListener("click",closeDuel);
  ui.modePractice?.addEventListener("click",()=>{ incomingChallenge=null; clearChallengeUrl(); setMode("practice"); });
  ui.modeReal?.addEventListener("click",()=>setMode(incomingChallenge?"real-accept":"real-create"));
  ui.start?.addEventListener("click",startDuel);
  ui.sync?.addEventListener("click",()=>{ if(!state.running||state.locked)return; lockRound(performance.now()-state.startTime,false); });
  ui.again?.addEventListener("click",playAgain);
  ui.share?.addEventListener("click",()=>{
    if(mode==="real-create" && ui.challengeUrl.value){ copyText(ui.challengeUrl.value,ui.share,"Copy challenge link"); return; }
    ui.sharePanel.classList.toggle("open");
  });
  ui.copyShare?.addEventListener("click",copyShare);
  ui.copyChallenge?.addEventListener("click",()=>copyText(ui.challengeUrl.value,ui.copyChallenge,"Copy link"));

  updateRecordUI();
  setMode(mode, {keepSeed:true});

  if (incomingChallenge) {
    setTimeout(()=>{
      openDuel();
      document.getElementById("sync-duel")?.scrollIntoView({behavior:reducedMotion?"auto":"smooth",block:"start"});
    },180);
  }

  // Tiny deterministic engine surface used by local QA. No game state mutation.
  window.__SYNC_DUEL_TEST__ = {
    deterministic(seed="SYNC-483921"){
      return Array.from({length:ROUNDS},(_,i)=>{const p=roundParams(seed,i);const a=pricesAt(p,3210);const g=ghostResult(seed,i,p);return {a:a.a,b:a.b,d:divergencePct(a.a,a.b),ghost:g.pct};});
    },
    scoreFor, classify, divergencePct,
    encode(seed="SYNC-483921",rounds=[800,810,820,830,840]){state.seed=seed;state.rounds=rounds.map(score=>({score,pct:.1}));return makeChallengePayload();}
  };

  return {open:openDuel};
})();
