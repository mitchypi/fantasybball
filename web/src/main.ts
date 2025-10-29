import './style.css';
import { fetchBoxscore, fetchManifest, fetchScoreboard } from './api';
import { getSystem, setSystem, addBet, listBets, updateBet, cacheScoreboard, getCachedScoreboard, cacheBoxscore, getCachedBoxscore, getSimulationState, setSimulationState, clearBets, clearSimulations, clearScoreboardCache, clearBoxscoreCache } from './db';
import { renderScoreboard } from './ui/scoreboard';
import { renderBetSlip, renderBankroll, renderBetLists } from './ui/bets';
import type { BetLeg, BetSlip, BoxscorePayload, ScoreboardPayload } from './types';
import { settleSlip } from './settlement';
import { formatCurrency } from './utils';

interface BlackjackHand {
  cards: string[];
  bet: number;
  status: 'playing' | 'stood' | 'bust' | 'blackjack' | 'settled';
  doubled?: boolean;
  split?: boolean;
  result?: 'win' | 'lose' | 'push';
}

interface BlackjackRound {
  hands: BlackjackHand[];
  activeHand: number;
  dealer: string[];
  stake: number;
  inRound: boolean;
  settled: boolean;
  message: string;
}

const BJ_SUITS = ['♠', '♥', '♦', '♣'];
const BJ_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
let blackjackShoe: string[] = [];
let blackjackHandsSinceShuffle = 0;

type RouletteChoice = 'red' | 'black' | 'green';

const ROULETTE_SEQUENCE = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24,
  16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const ROULETTE_RED_NUMBERS = new Set<number>([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);
const ROULETTE_SEGMENT = 360 / ROULETTE_SEQUENCE.length;
const ROULETTE_SPIN_DURATION = 3200;

function getRouletteColor(value: number): RouletteChoice {
  if (value === 0) return 'green';
  return ROULETTE_RED_NUMBERS.has(value) ? 'red' : 'black';
}

function rouletteColorHex(choice: RouletteChoice) {
  switch (choice) {
    case 'green':
      return '#15803d';
    case 'red':
      return '#b91c1c';
    default:
      return '#111827';
  }
}

async function boot() {
  const scoreboardList = document.getElementById('scoreboard-list') as HTMLElement;
  const scoreboardDateInput = document.getElementById('scoreboard-date') as HTMLInputElement;
  const datePrevBtn = document.getElementById('date-prev') as HTMLButtonElement;
  const dateNextBtn = document.getElementById('date-next') as HTMLButtonElement;
  const simulateBtn = document.getElementById('simulate-day') as HTMLButtonElement;
  const resetBtn = document.getElementById('reset-game') as HTMLButtonElement;
  const currentDateLabel = document.getElementById('scoreboard-current-date') as HTMLElement;
  const header = document.querySelector('header') as HTMLElement;
  const aside = document.querySelector('aside') as HTMLElement;
  const pendingRoot = document.getElementById('pending-bets') as HTMLElement;
  const settledRoot = document.getElementById('settled-bets') as HTMLElement;
  const pendingToggle = document.getElementById('bets-toggle-pending') as HTMLButtonElement;
  const settledToggle = document.getElementById('bets-toggle-settled') as HTMLButtonElement;
  const betPanelSlipBtn = document.getElementById('bet-panel-slip') as HTMLButtonElement;
  const betPanelHistoryBtn = document.getElementById('bet-panel-history') as HTMLButtonElement;
  const betPanelSlipView = document.getElementById('bet-panel-slip-view') as HTMLElement;
  const betPanelHistoryView = document.getElementById('bet-panel-history-view') as HTMLElement;
  const oddsAmericanBtn = document.getElementById('odds-format-american') as HTMLButtonElement;
  const oddsDecimalBtn = document.getElementById('odds-format-decimal') as HTMLButtonElement;
  const blackjackStakeInput = document.getElementById('blackjack-stake') as HTMLInputElement;
  const blackjackDealBtn = document.getElementById('blackjack-deal') as HTMLButtonElement;
  const blackjackHitBtn = document.getElementById('blackjack-hit') as HTMLButtonElement;
  const blackjackStandBtn = document.getElementById('blackjack-stand') as HTMLButtonElement;
  const blackjackDoubleBtn = document.getElementById('blackjack-double') as HTMLButtonElement;
  const blackjackSplitBtn = document.getElementById('blackjack-split') as HTMLButtonElement;
  const blackjackStatus = document.getElementById('blackjack-status') as HTMLElement;
  const rouletteStakeInput = document.getElementById('roulette-stake') as HTMLInputElement;
  const rouletteBtn = document.getElementById('roulette-spin') as HTMLButtonElement;
  const rouletteClearBtn = document.getElementById('roulette-clear') as HTMLButtonElement;
  const rouletteStatus = document.getElementById('roulette-status') as HTMLElement;
  const rouletteWheel = document.getElementById('roulette-wheel') as HTMLElement;
  const rouletteBall = document.getElementById('roulette-ball') as HTMLElement;
  const rouletteBoard = document.getElementById('roulette-board') as HTMLElement;
  const rouletteDenomButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.roulette-chip.denom'));

  const manifest = await safeFetchManifest();
  let system = await getSystem();
  const boxscoreCache = new Map<string, BoxscorePayload>();
  let currentScoreboard: ScoreboardPayload | undefined;
  let currentSimulated = false;

  // Ensure the stored date lands within the manifest range when available
  if (manifest?.start_date) {
    const manifestDates = new Set<string>((manifest.dates || []) as string[]);
    const fallbackDate = manifest.start_date;
    const currentDate = system.currentDate;
    const needsReset = !currentDate || (manifestDates.size > 0 && currentDate && !manifestDates.has(currentDate));
    if (needsReset) {
      system = await setSystem({ currentDate: fallbackDate });
    }
    if (scoreboardDateInput) {
      scoreboardDateInput.min = manifest.start_date;
      if (manifest.end_date) scoreboardDateInput.max = manifest.end_date;
    }
  }
  let selections: BetLeg[] = [];
  let pending: BetSlip[] = [];
  let settled: BetSlip[] = [];
  let bankroll = { available: system.bankroll, pending_stake: system.pendingStake, pending_potential: system.pendingPotential };
  let activeBetTab: 'pending' | 'settled' = 'pending';
  let oddsFormat: 'american' | 'decimal' = 'american';
  let activeBetPanel: 'slip' | 'history' = 'slip';
  let betSlipMessage = '';
  let blackjackState: BlackjackRound | null = null;
  let latestPendingDate: string | undefined = manifest?.start_date || system.currentDate;
  const rouletteBoardCells = new Map<number, HTMLElement>();
  const rouletteBets = new Map<number, number>();
  let selectedDenomination = 0;
  let rouletteSpinning = false;
  let wheelRotation = 0;

  function setDate(d: string) {
    const currentDate = system.currentDate;
    if (currentDate && !currentSimulated && (currentScoreboard?.games.length || 0) > 0) {
      const currentTime = new Date(currentDate);
      const targetTime = new Date(d);
      if (targetTime > currentTime) {
        window.alert('Simulate the current day before advancing.');
        scoreboardDateInput.value = currentDate;
        return;
      }
    }
    system = { ...system, currentDate: d };
    setSystem({ currentDate: d });
    scoreboardDateInput.value = d;
    selections = [];
    betSlipMessage = '';
    render();
    loadScoreboard(d).catch(console.error);
  }

  async function safeFetchManifest() {
    try { return await fetchManifest(); } catch { return { dates: [], start_date: '', end_date: '' }; }
  }

  async function loadScoreboard(date: string) {
    let payload: ScoreboardPayload | undefined = await getCachedScoreboard(date);
    if (!payload) {
      try {
        payload = await fetchScoreboard(date);
        await cacheScoreboard(date, payload);
      } catch {
        payload = { date, games: [] };
      }
    }
    currentScoreboard = payload;
    const simState = await getSimulationState(date);
    currentSimulated = Boolean(simState?.simulated);

    if (!currentSimulated && (payload.games.length === 0)) {
      currentSimulated = true;
      await setSimulationState(date, { date, simulated: true });
    }

    if (currentSimulated && payload.games.length) {
      await autoSettle(payload);
    } else {
      await refreshBets();
    }

    await refreshLatestPendingDate();
    presentScoreboard();
  }

  async function autoSettle(scoreboard: ScoreboardPayload) {
    const gamesById = new Map(scoreboard.games.map(g => [String(g.game_id), g] as const));
    const slips = await listBets();
    const pend = slips.filter(s => s.status === 'pending');
    for (const slip of pend) {
      const res = settleSlip(slip, gamesById);
      if (res.status !== 'pending') {
        const updatedLegs = slip.legs.map((leg, idx) => {
          const existingMeta = (leg.metadata || {}) as Record<string, unknown>;
          const nextMeta = { ...existingMeta, result: res.legResults ? res.legResults[idx] : existingMeta['result'] };
          return { ...leg, metadata: nextMeta };
        });
        await updateBet(slip.id!, { status: res.status, payout: res.payout, legs: updatedLegs });
      }
    }
    await refreshBets();
  }

  function presentScoreboard() {
    if (!currentScoreboard) return;
    const hasGames = currentScoreboard.games.length > 0;
    renderScoreboard(scoreboardList, currentScoreboard, {
      showFinalScores: currentSimulated,
      oddsFormat,
      onOddsSelected: currentSimulated ? undefined : addSelection,
      onRequestBoxscore: currentSimulated ? loadBoxscore : undefined,
    });
    updateSimulationControls(system.currentDate, currentSimulated, hasGames);
    activateBetTab(activeBetTab);
  }

  async function loadBoxscore(gameId: string | number) {
    const key = String(gameId);
    if (boxscoreCache.has(key)) return boxscoreCache.get(key);
    const cached = await getCachedBoxscore(gameId);
    if (cached) {
      boxscoreCache.set(key, cached);
      return cached;
    }
    const fetched = await fetchBoxscore(gameId);
    await cacheBoxscore(gameId, fetched);
    boxscoreCache.set(key, fetched);
    return fetched;
  }

  function updateSimulationControls(currentDate: string, simulated: boolean, hasGames: boolean) {
    if (simulateBtn) {
      simulateBtn.disabled = simulated || !hasGames;
      if (!hasGames) {
        simulateBtn.textContent = 'No Games';
      } else {
        simulateBtn.textContent = simulated ? 'Day Simulated' : 'Simulate Day';
      }
    }
    if (dateNextBtn) {
      dateNextBtn.disabled = hasGames && !simulated;
    }
  }

  async function refreshBets() {
    const all = await listBets();
    pending = all.filter(s => s.status === 'pending');
    settled = all.filter(s => s.status !== 'pending');
    // Recompute bankroll summary
    const pendingStake = pending.reduce((s, b) => s + b.stake, 0);
    const pendingPotential = pending.reduce((s, b) => s + (b.payout || 0), 0);
    const settledDelta = settled.reduce((s, b) => s + ((b.payout || 0) - b.stake), 0);
    // available = initial + winnings/losses - pending stakes
    const base = system.initialBankroll ?? 1000;
    const available = base + settledDelta - pendingStake;
    bankroll = { available, pending_stake: pendingStake, pending_potential: pendingPotential };
    await setSystem({ bankroll: available, pendingStake, pendingPotential });
    render();
  }

  function render() {
    renderBankroll(header, bankroll);
    renderBetSlip(aside, { selections, bankroll }, oddsFormat, betSlipMessage, (_value) => render(), placeBet, clearSlip, removeSelection);
    renderBetLists(pendingRoot, settledRoot, pending, settled, oddsFormat);
    activateBetTab(activeBetTab);
    updateBetPanelView();
    renderBlackjack();
  }

  async function placeBet() {
    const stakeInput = document.getElementById('bet-slip-stake') as HTMLInputElement;
    const stake = Number(stakeInput.value || 0);
    if (!(stake > 0) || !selections.length || stake > bankroll.available) return;
    const legs = selections.map((sel) => ({
      game_id: sel.game_id,
      market: sel.market,
      selection: sel.selection,
      price: sel.price,
      point: sel.point,
      label: sel.label,
      game: sel.game,
      metadata: { ...(sel.metadata || {}), game: sel.game || (sel.metadata && (sel.metadata as any).game) },
    }));
    const slip: Omit<BetSlip, 'id'> = {
      placed_at: new Date().toISOString(),
      status: 'pending',
      kind: selections.length > 1 ? 'parlay' : 'single',
      stake,
      legs,
    };
    // Compute potential payout
    const multiplier = selections.reduce((m, l) => m * (l.price ? (l.price > 0 ? (1 + l.price / 100) : (1 + 100 / Math.abs(l.price))) : 1), 1);
    (slip as any).payout = +(stake * multiplier).toFixed(2);
    await addBet(slip);
    selections = [];
    betSlipMessage = '';
    await refreshBets();
  }

  function clearSlip() {
    selections = [];
    betSlipMessage = '';
    render();
  }

  function removeSelection(index: number) {
    selections.splice(index, 1);
    betSlipMessage = '';
    render();
  }

  function addSelection(sel: BetLeg) {
    const gameKey = String(sel.game_id);
    const sameGame = selections.filter(s => String(s.game_id) === gameKey);
    if (sel.market === 'total') {
      if (sameGame.some(s => s.market === 'total')) {
        betSlipMessage = 'Only one total selection per game.';
        render();
        return;
      }
    } else {
      if (sameGame.some(s => s.market === 'moneyline' || s.market === 'spread')) {
        betSlipMessage = 'Only one moneyline or spread selection per game.';
        render();
        return;
      }
    }
    if (selections.some(s => s.game_id === sel.game_id && s.market === sel.market && s.selection === sel.selection && (s.point ?? null) === (sel.point ?? null))) {
      betSlipMessage = 'Selection already added.';
      render();
      return;
    }
    betSlipMessage = '';
    selections.push(sel);
    render();
  }

  function adjustBankroll(delta: number) {
    if (!Number.isFinite(delta) || delta === 0) return;
    bankroll.available = Math.max(0, bankroll.available + delta);
    setSystem({ bankroll: bankroll.available }).then((next) => {
      system = { ...system, bankroll: next.bankroll };
    }).catch(() => {
      /* noop */
    });
  }

  async function simulateCurrentDay() {
    if (!currentScoreboard || currentSimulated) return;
    const date = system.currentDate;
    if (!date) return;
    selections = [];
    betSlipMessage = '';
    render();
    currentSimulated = true;
    await setSimulationState(date, { date, simulated: true, simulatedAt: new Date().toISOString() });
    await autoSettle(currentScoreboard);
    await refreshLatestPendingDate();
    presentScoreboard();
  }

  // Init
  const start = manifest.start_date || system.currentDate || new Date().toISOString().slice(0, 10);
  scoreboardDateInput.value = start;
  scoreboardDateInput.onchange = () => setDate(scoreboardDateInput.value);
  datePrevBtn.onclick = () => stepDate(-1);
  dateNextBtn.onclick = () => stepDate(1);
  if (simulateBtn) simulateBtn.onclick = () => simulateCurrentDay().catch(console.error);
  if (resetBtn) resetBtn.onclick = () => resetToStart(start).catch(console.error);
  if (pendingToggle) pendingToggle.onclick = () => activateBetTab('pending');
  if (settledToggle) settledToggle.onclick = () => activateBetTab('settled');
  if (oddsAmericanBtn) oddsAmericanBtn.onclick = () => changeOddsFormat('american');
  if (oddsDecimalBtn) oddsDecimalBtn.onclick = () => changeOddsFormat('decimal');
  if (blackjackDealBtn) blackjackDealBtn.onclick = () => startBlackjack();
  if (blackjackHitBtn) blackjackHitBtn.onclick = () => playerHit();
  if (blackjackStandBtn) blackjackStandBtn.onclick = () => playerStand();
  if (blackjackDoubleBtn) blackjackDoubleBtn.onclick = () => playerDouble();
  if (blackjackSplitBtn) blackjackSplitBtn.onclick = () => playerSplit();
  rouletteDenomButtons.forEach((chip) => {
    chip.onclick = () => selectRouletteDenomination(chip);
  });
  if (rouletteClearBtn) rouletteClearBtn.onclick = () => clearRouletteBet();
  if (betPanelSlipBtn) betPanelSlipBtn.onclick = () => setActiveBetPanel('slip');
  if (betPanelHistoryBtn) betPanelHistoryBtn.onclick = () => setActiveBetPanel('history');
  if (rouletteStakeInput) {
    rouletteStakeInput.oninput = () => {
      const value = Math.max(0, Number(rouletteStakeInput.value || 0));
      rouletteStakeInput.value = Number.isFinite(value) ? String(value) : '0';
    };
  }
  if (rouletteBtn) rouletteBtn.onclick = () => playRoulette();
  await loadScoreboard(start);
  if (blackjackStatus) blackjackStatus.textContent = 'Select a stake and deal.';
  if (rouletteStatus) rouletteStatus.textContent = 'Choose a chip, then tap the board.';
  setRouletteWheelGradient();
  buildRouletteBoard();
  updateRouletteStakeDisplay();
  if (rouletteBall) {
    rouletteBall.style.transform = `rotate(${ROULETTE_SEGMENT / 2}deg) translateY(-82px)`;
  }

  function stepDate(deltaDays: number) {
    if (deltaDays > 0 && !currentSimulated && (currentScoreboard?.games.length || 0) > 0) {
      window.alert('Simulate the current day before advancing.');
      return;
    }
    const currentValue = scoreboardDateInput.value || start;
    const d = new Date(currentValue);
    d.setDate(d.getDate() + deltaDays);
    setDate(d.toISOString().slice(0, 10));
  }

  async function resetToStart(startDate: string) {
    const confirmed = window.confirm('Reset to season start? Current progress will remain but you will jump back to the first day.');
    if (!confirmed) return;
    const initial = 1000;
    system = await setSystem({ currentDate: startDate, bankroll: initial, initialBankroll: initial, pendingStake: 0, pendingPotential: 0 });
    scoreboardDateInput.value = startDate;
    selections = [];
    currentSimulated = false;
    currentScoreboard = undefined;
    boxscoreCache.clear();
    pending = [];
    settled = [];
    bankroll = { available: initial, pending_stake: 0, pending_potential: 0 };
    activeBetTab = 'pending';
    betSlipMessage = '';
    blackjackState = null;
    blackjackShoe = [];
    blackjackHandsSinceShuffle = 0;
    if (blackjackStatus) blackjackStatus.textContent = 'Select a stake and deal.';
    if (blackjackStakeInput) blackjackStakeInput.value = '10';
    rouletteBets.clear();
    activeBetPanel = 'slip';
    selectedDenomination = 0;
    rouletteDenomButtons.forEach((chip) => {
      chip.classList.remove('selected');
      chip.disabled = false;
    });
    if (rouletteClearBtn) rouletteClearBtn.disabled = false;
    rouletteSpinning = false;
    wheelRotation = 0;
    if (rouletteWheel) rouletteWheel.style.transform = 'rotate(0deg)';
    if (rouletteBall) {
      rouletteBall.classList.remove('rolling');
      rouletteBall.style.transform = `rotate(${ROULETTE_SEGMENT / 2}deg) translateY(-82px)`;
    }
    rouletteBoardCells.forEach((cell) => cell.classList.remove('active'));
    updateRouletteStakeDisplay();
    renderRouletteBoardBets();
    updateBetPanelView();
    if (rouletteStatus) {
      rouletteStatus.textContent = 'Choose a chip, then tap the board.';
      rouletteStatus.classList.add('muted');
    }
    render();
    await clearBets();
    await clearSimulations();
    await clearScoreboardCache();
    await clearBoxscoreCache();
    presentScoreboard();
    await loadScoreboard(startDate);
  }

  function activateBetTab(tab: 'pending' | 'settled') {
    activeBetTab = tab;
    if (pendingToggle) pendingToggle.classList.toggle('active', tab === 'pending');
    if (settledToggle) settledToggle.classList.toggle('active', tab === 'settled');
    if (pendingRoot) pendingRoot.classList.toggle('hidden', tab !== 'pending');
    if (settledRoot) settledRoot.classList.toggle('hidden', tab !== 'settled');
  }

  function setActiveBetPanel(panel: 'slip' | 'history') {
    if (activeBetPanel === panel) return;
    activeBetPanel = panel;
    updateBetPanelView();
  }

  function updateBetPanelView() {
    if (betPanelSlipView) betPanelSlipView.classList.toggle('hidden', activeBetPanel !== 'slip');
    if (betPanelHistoryView) betPanelHistoryView.classList.toggle('hidden', activeBetPanel !== 'history');
    if (betPanelSlipBtn) betPanelSlipBtn.classList.toggle('active', activeBetPanel === 'slip');
    if (betPanelHistoryBtn) betPanelHistoryBtn.classList.toggle('active', activeBetPanel === 'history');
  }

  function changeOddsFormat(format: 'american' | 'decimal') {
    if (oddsFormat === format) return;
    oddsFormat = format;
    if (oddsAmericanBtn) oddsAmericanBtn.classList.toggle('active', format === 'american');
    if (oddsDecimalBtn) oddsDecimalBtn.classList.toggle('active', format === 'decimal');
    presentScoreboard();
    render();
  }

  function updateDateLabel(dateString?: string) {
    if (!dateString) dateString = latestPendingDate;
    if (!currentDateLabel) return;
    if (!dateString) {
      currentDateLabel.textContent = '';
      return;
    }
    const date = new Date(`${dateString}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
      currentDateLabel.textContent = dateString;
    } else {
      currentDateLabel.textContent = date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    }
  }

  async function refreshLatestPendingDate() {
    if (!manifest?.dates || !manifest.dates.length) {
      latestPendingDate = system.currentDate;
      updateDateLabel(latestPendingDate);
      return;
    }
    const ordered = [...manifest.dates as string[]].sort();
    for (const date of ordered) {
      const state = await getSimulationState(date);
      if (!state?.simulated) {
        latestPendingDate = date;
        updateDateLabel(latestPendingDate);
        return;
      }
    }
    latestPendingDate = ordered[ordered.length - 1];
    updateDateLabel(latestPendingDate);
  }

  function startBlackjack() {
    if (!blackjackStakeInput || !blackjackStatus || !blackjackDealBtn) return;
    const stake = Math.floor(Number(blackjackStakeInput.value || 0));
    if (!(stake > 0)) {
      blackjackStatus.textContent = 'Enter a valid stake.';
      return;
    }
    if (stake > bankroll.available) {
      blackjackStatus.textContent = 'Stake exceeds available balance.';
      return;
    }
    if (!blackjackShoe.length || blackjackHandsSinceShuffle >= 6 || blackjackShoe.length < 52) {
      blackjackShoe = createShoe();
      blackjackHandsSinceShuffle = 0;
    }
    adjustBankroll(-stake);
    renderBankroll(header, bankroll);

    const playerCards = [drawCard(), drawCard()];
    const dealerCards = [drawCard(), drawCard()];
    const playerHand: BlackjackHand = {
      cards: playerCards,
      bet: stake,
      status: 'playing',
      doubled: false,
      split: false,
    };

    blackjackState = {
      hands: [playerHand],
      activeHand: 0,
      dealer: dealerCards,
      stake,
      inRound: true,
      settled: false,
      message: 'Hit, Stand, Double, or Split when available.',
    };

    const playerVal = calculateBlackjackValue(playerHand.cards);
    const dealerVal = calculateBlackjackValue(dealerCards);

    if (playerVal.isBlackjack) {
      blackjackState.inRound = false;
      blackjackState.settled = true;
      if (dealerVal.isBlackjack) {
        playerHand.status = 'settled';
        playerHand.result = 'push';
        blackjackState.message = 'Both you and the dealer have blackjack. Push.';
        adjustBankroll(stake);
      } else {
        playerHand.status = 'blackjack';
        playerHand.result = 'win';
        blackjackState.message = 'Blackjack! Paid 3:2.';
        adjustBankroll(stake * 2.5);
      }
      renderBankroll(header, bankroll);
      blackjackHandsSinceShuffle += 1;
      renderBlackjack();
      return;
    }

    if (dealerVal.isBlackjack) {
      blackjackState.inRound = false;
      blackjackState.settled = true;
      playerHand.status = 'settled';
      playerHand.result = 'lose';
      blackjackState.message = 'Dealer has blackjack.';
      blackjackHandsSinceShuffle += 1;
      renderBlackjack();
      return;
    }

    renderBlackjack();
  }

  function playerHit() {
    if (!blackjackState || !blackjackState.inRound) return;
    const hand = getActiveHand();
    if (!hand) return;
    hand.cards.push(drawCard());
    const value = calculateBlackjackValue(hand.cards);
    if (value.total > 21) {
      hand.status = 'bust';
      hand.result = 'lose';
      blackjackState.message = `Hand ${blackjackState.activeHand + 1} busts with ${value.total}.`;
      moveToNextHand();
    } else if (value.total === 21) {
      hand.status = 'stood';
      blackjackState.message = `Hand ${blackjackState.activeHand + 1} shows 21.`;
      moveToNextHand();
    } else {
      blackjackState.message = `Hand ${blackjackState.activeHand + 1} totals ${value.total}.`;
    }
    renderBlackjack();
  }

  function playerStand() {
    if (!blackjackState || !blackjackState.inRound) return;
    const hand = getActiveHand();
    if (!hand) return;
    const value = calculateBlackjackValue(hand.cards);
    hand.status = 'stood';
    blackjackState.message = `Hand ${blackjackState.activeHand + 1} stands at ${value.total}.`;
    moveToNextHand();
    renderBlackjack();
  }

  function playerDouble() {
    if (!blackjackState || !blackjackState.inRound) return;
    const hand = getActiveHand();
    if (!hand || !canDouble(hand)) return;
    adjustBankroll(-hand.bet);
    renderBankroll(header, bankroll);
    hand.bet *= 2;
    hand.doubled = true;
    hand.cards.push(drawCard());
    const value = calculateBlackjackValue(hand.cards);
    if (value.total > 21) {
      hand.status = 'bust';
      hand.result = 'lose';
      blackjackState.message = `Hand ${blackjackState.activeHand + 1} busts with ${value.total}.`;
    } else {
      hand.status = 'stood';
      blackjackState.message = `Hand ${blackjackState.activeHand + 1} doubles to ${value.total}.`;
    }
    moveToNextHand();
    renderBlackjack();
  }

  function playerSplit() {
    if (!blackjackState || !blackjackState.inRound) return;
    const hand = getActiveHand();
    if (!hand || !canSplit(hand)) return;
    if (hand.bet > bankroll.available) {
      blackjackState.message = 'Insufficient bankroll to split.';
      renderBlackjack();
      return;
    }
    adjustBankroll(-hand.bet);
    renderBankroll(header, bankroll);
    const [firstCard, secondCard] = hand.cards;
    hand.cards = [firstCard, drawCard()];
    hand.status = 'playing';
    hand.split = true;
    const newHand: BlackjackHand = {
      cards: [secondCard, drawCard()],
      bet: hand.bet,
      status: 'playing',
      doubled: false,
      split: true,
    };
    blackjackState.hands.splice(blackjackState.activeHand + 1, 0, newHand);
    blackjackState.message = 'Hands split. Play the first hand.';
    renderBlackjack();
  }

  function moveToNextHand() {
    if (!blackjackState) return;
    const state = blackjackState;
    const currentIndex = state.activeHand;
    const nextIndex = state.hands.findIndex((hand, idx) => idx > currentIndex && hand.status === 'playing');
    if (nextIndex !== -1) {
      state.activeHand = nextIndex;
      return;
    }
    const firstActive = state.hands.findIndex((hand) => hand.status === 'playing');
    if (firstActive !== -1) {
      state.activeHand = firstActive;
      return;
    }
    state.inRound = false;
    dealerPlay();
  }

  function dealerPlay() {
    if (!blackjackState) return;
    const state = blackjackState;
    const activeHands = state.hands.filter((hand) => hand.status !== 'bust');
    if (!activeHands.length) {
      finalizeBlackjackRound();
      return;
    }
    let dealerValue = calculateBlackjackValue(state.dealer);
    while (dealerValue.total < 17 || (dealerValue.total === 17 && dealerValue.isSoft)) {
      state.dealer.push(drawCard());
      dealerValue = calculateBlackjackValue(state.dealer);
    }
    finalizeBlackjackRound();
  }

  function finalizeBlackjackRound() {
    if (!blackjackState) return;
    const state = blackjackState;
    const dealerValue = calculateBlackjackValue(state.dealer);
    const messages: string[] = [];
    let totalDelta = 0;

    state.hands.forEach((hand, idx) => {
      const value = calculateBlackjackValue(hand.cards);
      if (hand.status === 'bust') {
        hand.result = 'lose';
        hand.status = 'settled';
        messages.push(`Hand ${idx + 1} busts (${value.total}).`);
        return;
      }

      const naturalWin = !hand.split && hand.cards.length === 2 && value.isBlackjack;
      if (dealerValue.total > 21) {
        hand.result = 'win';
        hand.status = naturalWin ? 'blackjack' : 'settled';
        if (naturalWin) {
          messages.push(`Hand ${idx + 1} blackjack! Dealer busts. Paid 3:2.`);
        } else {
          messages.push(`Hand ${idx + 1} wins ${value.total} vs dealer bust.`);
        }
        totalDelta += hand.bet * (naturalWin ? 2.5 : 2);
        return;
      }

      if (value.total > dealerValue.total) {
        hand.result = 'win';
        hand.status = naturalWin ? 'blackjack' : 'settled';
        if (naturalWin) {
          messages.push(`Hand ${idx + 1} blackjack beats dealer ${dealerValue.total}. Paid 3:2.`);
        } else {
          messages.push(`Hand ${idx + 1} wins ${value.total} to ${dealerValue.total}.`);
        }
        totalDelta += hand.bet * (naturalWin ? 2.5 : 2);
      } else if (value.total < dealerValue.total) {
        hand.result = 'lose';
        hand.status = 'settled';
        messages.push(`Hand ${idx + 1} loses ${value.total} to ${dealerValue.total}.`);
      } else {
        hand.result = 'push';
        hand.status = 'settled';
        messages.push(`Hand ${idx + 1} pushes at ${value.total}.`);
        totalDelta += hand.bet;
      }
    });

    blackjackState.message = messages.join('<br/>');
    blackjackState.settled = true;
    blackjackState.inRound = false;
    blackjackState.activeHand = -1;
    blackjackHandsSinceShuffle += 1;
    if (blackjackHandsSinceShuffle >= 6) {
      blackjackShoe = [];
      blackjackHandsSinceShuffle = 0;
    }
    if (totalDelta !== 0) {
      adjustBankroll(totalDelta);
      renderBankroll(header, bankroll);
    }
    renderBlackjack();
  }

  function renderBlackjack() {
    if (!blackjackStatus || !blackjackDealBtn || !blackjackHitBtn || !blackjackStandBtn || !blackjackDoubleBtn || !blackjackSplitBtn) return;
    const dealerCardsEl = document.getElementById('blackjack-dealer-cards') as HTMLElement | null;
    const dealerMetaEl = document.getElementById('blackjack-dealer-meta') as HTMLElement | null;
    const playerHandsRoot = document.getElementById('blackjack-player-hands') as HTMLElement | null;
    const messageEl = document.getElementById('blackjack-message') as HTMLElement | null;

    if (!blackjackState) {
      blackjackStatus.textContent = 'Select a stake and deal.';
      blackjackDealBtn.disabled = false;
      blackjackHitBtn.disabled = true;
      blackjackStandBtn.disabled = true;
      blackjackDoubleBtn.disabled = true;
      blackjackSplitBtn.disabled = true;
      if (dealerCardsEl) dealerCardsEl.textContent = '—';
      if (dealerMetaEl) dealerMetaEl.textContent = '';
      if (playerHandsRoot) playerHandsRoot.innerHTML = '<p class="muted">No active hands.</p>';
      if (messageEl) {
        messageEl.textContent = '';
        messageEl.classList.add('muted');
      }
      return;
    }

    const activeHand = getActiveHand();
    const canAct = Boolean(blackjackState.inRound && activeHand);
    blackjackDealBtn.disabled = blackjackState.inRound;
    blackjackHitBtn.disabled = !canAct;
    blackjackStandBtn.disabled = !canAct;
    blackjackDoubleBtn.disabled = !canAct || !activeHand || !canDouble(activeHand);
    blackjackSplitBtn.disabled = !canAct || !activeHand || !canSplit(activeHand);

    const revealDealer = !blackjackState.inRound || blackjackState.settled;
    const dealerValue = calculateBlackjackValue(blackjackState.dealer);
    if (dealerCardsEl) dealerCardsEl.textContent = formatBlackjackHand(blackjackState.dealer, revealDealer);
    if (dealerMetaEl) {
      dealerMetaEl.textContent = revealDealer
        ? `Total: ${dealerValue.total}${dealerValue.isSoft ? ' (soft)' : ''}`
        : 'Total: ?';
      dealerMetaEl.classList.toggle('muted', !revealDealer);
    }

    if (playerHandsRoot) {
      playerHandsRoot.innerHTML = '';
      blackjackState.hands.forEach((hand, idx) => {
        const wrapper = document.createElement('div');
        const classes = ['blackjack-hand'];
        if (blackjackState.activeHand === idx && blackjackState.inRound) classes.push('active');
        if (hand.status === 'bust') classes.push('bust');
        wrapper.className = classes.join(' ');

        const cardsEl = document.createElement('div');
        cardsEl.className = 'blackjack-cards';
        cardsEl.textContent = formatBlackjackHand(hand.cards, true);
        wrapper.appendChild(cardsEl);

        const metaEl = document.createElement('div');
        metaEl.className = 'blackjack-hand-meta';
        const value = calculateBlackjackValue(hand.cards);
        const tags = [
          `Total: ${value.total}`,
          value.isSoft ? 'Soft' : '',
          hand.doubled ? 'Doubled' : '',
          hand.split ? 'Split' : '',
        ].filter(Boolean);
        metaEl.textContent = tags.join(' • ');
        wrapper.appendChild(metaEl);

        if (hand.result || hand.status === 'blackjack') {
          const resultEl = document.createElement('div');
          const resultKey = hand.status === 'blackjack' ? 'blackjack' : (hand.result ?? 'win');
          resultEl.className = `blackjack-hand-result ${resultKey}`;
          resultEl.textContent = hand.status === 'blackjack' ? 'BLACKJACK' : resultKey.toUpperCase();
          wrapper.appendChild(resultEl);
        }

        playerHandsRoot.appendChild(wrapper);
      });
    }

    blackjackStatus.textContent = blackjackState.inRound ? 'Your move.' : 'Round complete.';
    if (messageEl) {
      if (blackjackState.message) {
        messageEl.innerHTML = blackjackState.message;
        messageEl.classList.remove('muted');
      } else {
        messageEl.textContent = '';
        messageEl.classList.add('muted');
      }
    }
  }

  function playRoulette() {
    if (!rouletteStakeInput || !rouletteStatus || !rouletteWheel) return;
    if (rouletteSpinning) return;
    const totalStake = getRouletteTotalStake();
    if (!(totalStake > 0)) {
      rouletteStatus.textContent = 'Place chips on the board before spinning.';
      rouletteStatus.classList.remove('muted');
      return;
    }
    if (totalStake > bankroll.available) {
      rouletteStatus.textContent = 'Stake exceeds available balance.';
      rouletteStatus.classList.remove('muted');
      return;
    }

    const betsSnapshot = new Map(rouletteBets);
    rouletteSpinning = true;
    rouletteStatus.textContent = 'Spinning...';
    rouletteStatus.classList.remove('muted');
    rouletteDenomButtons.forEach((chip) => {
      chip.disabled = true;
    });
    if (rouletteClearBtn) rouletteClearBtn.disabled = true;
    if (rouletteBtn) rouletteBtn.disabled = true;
    rouletteBoardCells.forEach((cell) => cell.classList.remove('active'));
    if (rouletteBall) {
      rouletteBall.classList.remove('rolling');
      void rouletteBall.offsetWidth;
      rouletteBall.classList.add('rolling');
    }

    const outcomeIndex = Math.floor(Math.random() * ROULETTE_SEQUENCE.length);
    const outcomeNumber = ROULETTE_SEQUENCE[outcomeIndex];
    const desiredAngle = outcomeIndex * ROULETTE_SEGMENT + (ROULETTE_SEGMENT / 2);
    const currentAngle = ((360 - (wheelRotation % 360)) + 360) % 360;
    const baseSpins = 4 + Math.floor(Math.random() * 3);
    const angleDiff = (currentAngle - desiredAngle + 360) % 360;
    wheelRotation = wheelRotation + baseSpins * 360 + angleDiff;
    rouletteWheel.style.transform = `rotate(${wheelRotation}deg)`;

    window.setTimeout(() => {
      if (rouletteBall) {
        rouletteBall.classList.remove('rolling');
        rouletteBall.style.transform = `rotate(${desiredAngle}deg) translateY(-82px)`;
      }
      highlightRouletteOutcome(outcomeNumber);

      const result = resolveRouletteWinnings(betsSnapshot, outcomeNumber);
      rouletteStatus.textContent = result.message;
      rouletteStatus.classList.toggle('muted', result.delta === 0);
      if (result.delta !== 0) {
        adjustBankroll(result.delta);
      }
      renderBankroll(header, bankroll);

      rouletteBets.clear();
      renderRouletteBoardBets();
      updateRouletteStakeDisplay();

      rouletteDenomButtons.forEach((chip) => {
        chip.disabled = false;
      });
      if (rouletteClearBtn) rouletteClearBtn.disabled = false;
      if (rouletteBtn) rouletteBtn.disabled = false;
      rouletteSpinning = false;
    }, ROULETTE_SPIN_DURATION);
  }

  function getActiveHand(): BlackjackHand | null {
    if (!blackjackState) return null;
    const idx = blackjackState.activeHand;
    if (idx < 0 || idx >= blackjackState.hands.length) return null;
    return blackjackState.hands[idx];
  }

  function canDouble(hand: BlackjackHand) {
    if (!blackjackState?.inRound) return false;
    if (hand.status !== 'playing') return false;
    if (hand.cards.length !== 2) return false;
    if (hand.doubled) return false;
    if (bankroll.available < hand.bet) return false;
    return true;
  }

  function canSplit(hand: BlackjackHand) {
    if (!blackjackState?.inRound) return false;
    if (hand.status !== 'playing') return false;
    if (hand.cards.length !== 2) return false;
    if (hand.split) return false;
    if (bankroll.available < hand.bet) return false;
    const [first, second] = hand.cards;
    return getCardRank(first) === getCardRank(second);
  }

  function getCardRank(card: string) {
    if (!card) return '';
    if (card.startsWith('10')) return '10';
    return card.charAt(0);
  }

  function createShoe(decks = 6) {
    const shoe: string[] = [];
    for (let i = 0; i < decks; i += 1) {
      shoe.push(...createDeck());
    }
    for (let i = shoe.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
    }
    return shoe;
  }

  function createDeck() {
    const deck: string[] = [];
    for (const rank of BJ_RANKS) {
      for (const suit of BJ_SUITS) deck.push(`${rank}${suit}`);
    }
    return deck;
  }

  function drawCard() {
    if (!blackjackShoe.length) {
      blackjackShoe = createShoe();
    }
    const card = blackjackShoe.pop();
    return card ?? '??';
  }

  function calculateBlackjackValue(hand: string[]) {
    let total = 0;
    let aces = 0;
    for (const card of hand) {
      const rank = card.startsWith('10') ? '10' : card.charAt(0);
      if (rank === 'A') {
        aces += 1;
        total += 11;
      } else if (['K', 'Q', 'J'].includes(rank) || rank === '10') {
        total += 10;
      } else {
        total += Number(rank);
      }
    }
    let adjustableAces = aces;
    while (total > 21 && adjustableAces > 0) {
      total -= 10;
      adjustableAces -= 1;
    }
    const isBlackjack = hand.length === 2 && total === 21;
    return { total, isSoft: aces > adjustableAces, bust: total > 21, isBlackjack };
  }

  function formatBlackjackHand(hand: string[], revealAll: boolean) {
    if (!hand.length) return '';
    if (revealAll) return hand.join(' ');
    return `${hand[0]} ??`;
  }

  function selectRouletteDenomination(chip: HTMLButtonElement) {
    const amount = Number(chip.dataset.amount || 0);
    if (!(amount > 0)) return;
    selectedDenomination = amount;
    rouletteDenomButtons.forEach((btn) => btn.classList.toggle('selected', btn === chip));
    if (rouletteStatus) {
      rouletteStatus.textContent = `Selected ${formatCurrency(amount)} chip. Tap the board to place it.`;
      rouletteStatus.classList.add('muted');
    }
  }

  function handleRouletteCellClick(value: number) {
    if (rouletteSpinning) return;
    if (!(selectedDenomination > 0)) {
      if (rouletteStatus) {
        rouletteStatus.textContent = 'Select a chip value before placing bets.';
        rouletteStatus.classList.remove('muted');
      }
      return;
    }
    const projectedTotal = getRouletteTotalStake() + selectedDenomination;
    if (projectedTotal > bankroll.available) {
      if (rouletteStatus) {
        rouletteStatus.textContent = 'Stake exceeds available balance.';
        rouletteStatus.classList.remove('muted');
      }
      return;
    }
    rouletteBets.set(value, (rouletteBets.get(value) || 0) + selectedDenomination);
    updateRouletteStakeDisplay();
    renderRouletteBoardBets();
    if (rouletteStatus) {
      rouletteStatus.textContent = `Placed ${formatCurrency(selectedDenomination)} on ${value === 0 ? '0' : value}.`;
      rouletteStatus.classList.add('muted');
    }
  }

  function clearRouletteBet() {
    rouletteBets.clear();
    updateRouletteStakeDisplay();
    renderRouletteBoardBets();
    if (rouletteStatus) {
      rouletteStatus.textContent = 'Bets cleared. Select a chip and tap the board.';
      rouletteStatus.classList.add('muted');
    }
  }

  function updateRouletteStakeDisplay() {
    if (!rouletteStakeInput) return;
    rouletteStakeInput.value = String(getRouletteTotalStake());
  }

  function getRouletteTotalStake() {
    let total = 0;
    rouletteBets.forEach((amount) => {
      total += amount;
    });
    return total;
  }

  function renderRouletteBoardBets() {
    rouletteBoardCells.forEach((cell, number) => {
      const stack = cell.querySelector('.roulette-chip-stack') as HTMLElement | null;
      if (!stack) return;
      const amount = rouletteBets.get(number) || 0;
      if (amount > 0) {
        stack.textContent = formatCurrency(amount);
        stack.classList.add('active');
      } else {
        stack.textContent = '';
        stack.classList.remove('active');
      }
    });
  }

  function highlightRouletteOutcome(value: number) {
    rouletteBoardCells.forEach((cell) => cell.classList.remove('active'));
    const target = rouletteBoardCells.get(value);
    if (target) target.classList.add('active');
  }

  function buildRouletteBoard() {
    if (!rouletteBoard) return;
    rouletteBoard.innerHTML = '';
    rouletteBoardCells.clear();

    const zeroCell = document.createElement('div');
   zeroCell.className = 'roulette-zero';
    zeroCell.dataset.number = '0';
    zeroCell.innerHTML = '<span>0</span>';
    const zeroStack = document.createElement('div');
    zeroStack.className = 'roulette-chip-stack';
    zeroCell.appendChild(zeroStack);
    zeroCell.addEventListener('click', () => handleRouletteCellClick(0));
    rouletteBoard.appendChild(zeroCell);
    rouletteBoardCells.set(0, zeroCell);

    const grid = document.createElement('div');
    grid.className = 'roulette-grid';
    for (let row = 11; row >= 0; row -= 1) {
      for (let col = 0; col < 3; col += 1) {
        const number = row * 3 + (3 - col);
        const cell = document.createElement('div');
        cell.className = `roulette-cell ${getRouletteColor(number)}`;
        cell.dataset.number = String(number);
        cell.innerHTML = `<span>${number}</span>`;
        const stack = document.createElement('div');
        stack.className = 'roulette-chip-stack';
        cell.appendChild(stack);
        cell.addEventListener('click', () => handleRouletteCellClick(number));
        grid.appendChild(cell);
        rouletteBoardCells.set(number, cell);
      }
    }
    rouletteBoard.appendChild(grid);
    renderRouletteBoardBets();
  }

  function setRouletteWheelGradient() {
    if (!rouletteWheel) return;
    let cursor = 0;
    const segments: string[] = [];
    for (const num of ROULETTE_SEQUENCE) {
      const color = rouletteColorHex(getRouletteColor(num));
      const start = cursor;
      const end = start + ROULETTE_SEGMENT;
      segments.push(`${color} ${start.toFixed(4)}deg ${end.toFixed(4)}deg`);
      cursor = end;
    }
    rouletteWheel.style.setProperty('--roulette-gradient', `conic-gradient(${segments.join(', ')})`);
    renderRouletteWheelNumbers();
  }

  function renderRouletteWheelNumbers() {
    if (!rouletteWheel) return;
    let container = rouletteWheel.querySelector('.roulette-wheel-numbers') as HTMLElement | null;
    if (container) container.remove();
    container = document.createElement('div');
    container.className = 'roulette-wheel-numbers';
    ROULETTE_SEQUENCE.forEach((num, idx) => {
      const angle = idx * ROULETTE_SEGMENT + (ROULETTE_SEGMENT / 2);
      const span = document.createElement('span');
      span.className = `roulette-wheel-number roulette-wheel-number-${getRouletteColor(num)}`;
      span.textContent = String(num);
      span.style.transform = `rotate(${angle}deg) translateY(-82px) rotate(${-angle}deg)`;
      container!.appendChild(span);
    });
    rouletteWheel.appendChild(container);
  }

  function resolveRouletteWinnings(bets: Map<number, number>, resultNumber: number) {
    const totalStake = Array.from(bets.values()).reduce((sum, amount) => sum + amount, 0);
    const winningStake = bets.get(resultNumber) || 0;
    const color = getRouletteColor(resultNumber);
    let delta = -totalStake;
    if (winningStake > 0) {
      delta += winningStake * 36;
    }
    let message = `Ball lands on ${resultNumber} ${color === 'green' ? 'GREEN' : color.toUpperCase()}.`;
    if (winningStake > 0) {
      message += ` You win ${formatCurrency(winningStake * 35)}.`;
    } else if (totalStake > 0) {
      message += ` You lose ${formatCurrency(totalStake)}.`;
    }
    return { delta, message };
  }
}

boot();
