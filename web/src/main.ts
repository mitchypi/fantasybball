import './style.css';
import { fetchBoxscore, fetchManifest, fetchScoreboard } from './api';
import { getSystem, setSystem, addBet, listBets, updateBet, cacheScoreboard, getCachedScoreboard, cacheBoxscore, getCachedBoxscore, getSimulationState, setSimulationState, clearBets, clearSimulations, clearScoreboardCache, clearBoxscoreCache } from './db';
import { renderScoreboard } from './ui/scoreboard';
import { renderBetSlip, renderBankroll, renderBetLists } from './ui/bets';
import type { BetLeg, BetSlip, BoxscorePayload, ScoreboardPayload } from './types';
import { settleSlip } from './settlement';

async function boot() {
  const scoreboardList = document.getElementById('scoreboard-list') as HTMLElement;
  const scoreboardDateInput = document.getElementById('scoreboard-date') as HTMLInputElement;
  const datePrevBtn = document.getElementById('date-prev') as HTMLButtonElement;
  const dateNextBtn = document.getElementById('date-next') as HTMLButtonElement;
  const simulateBtn = document.getElementById('simulate-day') as HTMLButtonElement;
  const resetBtn = document.getElementById('reset-game') as HTMLButtonElement;
  const header = document.querySelector('header') as HTMLElement;
  const aside = document.querySelector('aside') as HTMLElement;
  const pendingRoot = document.getElementById('pending-bets') as HTMLElement;
  const settledRoot = document.getElementById('settled-bets') as HTMLElement;
  const pendingToggle = document.getElementById('bets-toggle-pending') as HTMLButtonElement;
  const settledToggle = document.getElementById('bets-toggle-settled') as HTMLButtonElement;
  const oddsAmericanBtn = document.getElementById('odds-format-american') as HTMLButtonElement;
  const oddsDecimalBtn = document.getElementById('odds-format-decimal') as HTMLButtonElement;

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
      onOddsSelected: currentSimulated ? undefined : (sel) => {
        selections.push(sel);
        render();
      },
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
    renderBetSlip(aside, { selections, bankroll }, oddsFormat, (_value) => render(), placeBet, clearSlip, removeSelection);
    renderBetLists(pendingRoot, settledRoot, pending, settled, oddsFormat);
    activateBetTab(activeBetTab);
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
    await refreshBets();
  }

  function clearSlip() { selections = []; render(); }

  function removeSelection(index: number) {
    selections.splice(index, 1);
    render();
  }

  async function simulateCurrentDay() {
    if (!currentScoreboard || currentSimulated) return;
    const date = system.currentDate;
    if (!date) return;
    selections = [];
    render();
    currentSimulated = true;
    await setSimulationState(date, { date, simulated: true, simulatedAt: new Date().toISOString() });
    await autoSettle(currentScoreboard);
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
  await loadScoreboard(start);

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
    const initial = system.initialBankroll ?? 1000;
    system = await setSystem({ currentDate: startDate, bankroll: initial, pendingStake: 0, pendingPotential: 0 });
    scoreboardDateInput.value = startDate;
    selections = [];
    currentSimulated = false;
    currentScoreboard = undefined;
    boxscoreCache.clear();
    pending = [];
    settled = [];
    bankroll = { available: initial, pending_stake: 0, pending_potential: 0 };
    activeBetTab = 'pending';
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

  function changeOddsFormat(format: 'american' | 'decimal') {
    if (oddsFormat === format) return;
    oddsFormat = format;
    if (oddsAmericanBtn) oddsAmericanBtn.classList.toggle('active', format === 'american');
    if (oddsDecimalBtn) oddsDecimalBtn.classList.toggle('active', format === 'decimal');
    presentScoreboard();
    render();
  }
}

boot();
