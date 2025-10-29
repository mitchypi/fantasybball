import { qs, formatCurrency, americanToDecimal, decimalToAmerican, showToast } from './utils.js';

export function initBetting({ api, state }) {
  const availableEl = qs('#bankroll-available');
  const pendingEl = qs('#bankroll-pending');
  const potentialEl = qs('#bankroll-potential');
  const selectionsEl = qs('#bet-slip-selections');
  const stakeInput = qs('#bet-slip-stake');
  const kindEl = qs('#bet-slip-kind');
  const oddsWrap = qs('#bet-slip-odds-wrap');
  const oddsEl = qs('#bet-slip-odds');
  const profitWrap = qs('#bet-slip-profit-wrap');
  const profitEl = qs('#bet-slip-profit');
  const placeBtn = qs('#bet-slip-place');
  const clearBtn = qs('#bet-slip-clear');
  const messageEl = qs('#bet-slip-message');
  const pendingList = qs('#pending-bets');
  const settledList = qs('#settled-bets');

  let selections = [];
  let bankroll = { available: 0, pending_stake: 0, pending_potential: 0 };
  let pending = [];
  let settled = [];

  function renderBankroll() {
    if (availableEl) availableEl.textContent = formatCurrency(bankroll.available);
    if (pendingEl) pendingEl.textContent = formatCurrency(bankroll.pending_stake);
    if (potentialEl) potentialEl.textContent = formatCurrency(bankroll.pending_potential);
  }

  function renderSlip() {
    if (!selectionsEl) return;
    selectionsEl.innerHTML = '';
    if (!selections.length) {
      const p = document.createElement('p');
      p.className = 'bet-slip__empty';
      p.textContent = 'Select odds from the scoreboard to build your slip.';
      selectionsEl.appendChild(p);
    } else {
      selections.forEach((sel, idx) => {
        const row = document.createElement('div');
        row.className = 'bet-slip__selection';
        const info = document.createElement('div');
        info.innerHTML = `<strong>${sel.label}</strong>`;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'bet-slip__remove';
        rm.textContent = 'Remove';
        rm.addEventListener('click', () => { selections.splice(idx, 1); renderSlip(); });
        row.append(info, rm);
        selectionsEl.appendChild(row);
      });
    }
    const isParlay = selections.length > 1;
    if (kindEl) kindEl.textContent = isParlay ? 'Parlay' : 'Single';
    const stake = Number(stakeInput?.value || 0);
    const multiplier = selections.reduce((m, s) => m * americanToDecimal(s.price), 1);
    const payout = stake > 0 ? stake * multiplier : 0;
    if (oddsWrap) oddsWrap.hidden = !isParlay;
    if (isParlay && oddsEl) oddsEl.textContent = (decimalToAmerican(multiplier) >= 0 ? '+' : '') + String(decimalToAmerican(multiplier));
    if (profitWrap) profitWrap.hidden = !isParlay;
    if (isParlay && profitEl) profitEl.textContent = formatCurrency(Math.max(0, payout - stake));
    if (qs('#bet-slip-payout')) qs('#bet-slip-payout').textContent = formatCurrency(payout);
    if (placeBtn) placeBtn.disabled = !(selections.length && stake > 0 && stake <= (bankroll.available || 0) && state.leagueId);
    if (messageEl) messageEl.textContent = (stake > (bankroll.available || 0) ? 'Stake exceeds available balance.' : '');
  }

  function renderBetLists() {
    if (pendingList) pendingList.innerHTML = (pending || []).map(slip => `<div class="bet-item"><strong>${formatCurrency(slip.stake)}</strong> • ${slip.kind} • ${new Date(slip.placed_at).toLocaleDateString()}</div>`).join('');
    if (settledList) settledList.innerHTML = (settled || []).map(slip => `<div class="bet-item ${slip.status}"><strong>${formatCurrency(slip.payout)}</strong> • ${slip.status}</div>`).join('');
  }

  async function refresh({ silent = false } = {}) {
    if (!state.leagueId) return;
    try {
      const [bank, bets] = await Promise.all([
        api.bankroll(state.leagueId),
        api.bets(state.leagueId),
      ]);
      const b = bank?.bankroll || {};
      bankroll = {
        available: Number(b.available || 0),
        pending_stake: Number(b.pending_stake || 0),
        pending_potential: Number(b.pending_potential || 0),
      };
      pending = bets?.pending || [];
      settled = bets?.settled || [];
      renderBankroll();
      renderBetLists();
      renderSlip();
    } catch (err) { if (!silent) showToast(err.message || 'Unable to load betting data.', 'error'); }
  }

  function addSelection(sel) {
    selections.push(sel);
    renderSlip();
  }

  async function place() {
    if (!state.leagueId || !selections.length) return;
    const stake = Number(stakeInput?.value || 0);
    if (!(stake > 0)) { if (messageEl) messageEl.textContent = 'Enter a valid stake.'; return; }
    try {
      placeBtn && (placeBtn.disabled = true);
      const payload = {
        stake,
        kind: selections.length > 1 ? 'parlay' : 'single',
        league_date: elementsDateValue(),
        legs: selections.map(s => ({ game_id: s.gameId, market: s.market, selection: s.selection, price: s.price, point: s.point, label: s.label, metadata: { game: s.game } })),
      };
      await api.placeBet(state.leagueId, payload);
      showToast('Bet placed.', 'success');
      selections = [];
      renderSlip();
      await refresh({ silent: true });
    } catch (err) { if (messageEl) messageEl.textContent = err.message || 'Unable to place bet.'; }
    finally { placeBtn && (placeBtn.disabled = false); }
  }

  function elementsDateValue() {
    const dateInput = qs('#scoreboard-date');
    return dateInput ? (dateInput.value || '') : '';
  }

  placeBtn && placeBtn.addEventListener('click', place);
  clearBtn && clearBtn.addEventListener('click', () => { selections = []; renderSlip(); });
  stakeInput && stakeInput.addEventListener('input', renderSlip);

  return { refresh, addSelection, renderSlip };
}

