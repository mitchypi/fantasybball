import type { BetLeg, BetSlip, ScoreboardGame } from '../types';
import { americanToDecimal, decimalToAmerican, formatCurrency, escapeHtml } from '../utils';

export interface BetUIDeps {
  bankroll: { available: number; pending_stake: number; pending_potential: number };
  selections: BetLeg[];
}

export function renderBetSlip(
  root: HTMLElement,
  deps: BetUIDeps,
  oddsFormat: 'american' | 'decimal',
  onChangeStake: (value: number) => void,
  onPlace: () => void,
  onClear: () => void,
  onRemoveSelection: (index: number) => void,
) {
  const { selections, bankroll } = deps;
  const stakeInput = root.querySelector<HTMLInputElement>('#bet-slip-stake')!;
  const kindEl = root.querySelector('#bet-slip-kind')!;
  const oddsWrap = root.querySelector<HTMLElement>('#bet-slip-odds-wrap')!;
  const oddsEl = root.querySelector('#bet-slip-odds')!;
  const profitWrap = root.querySelector<HTMLElement>('#bet-slip-profit-wrap')!;
  const profitEl = root.querySelector('#bet-slip-profit')!;
  const payoutEl = root.querySelector('#bet-slip-payout')!;
  const placeBtn = root.querySelector<HTMLButtonElement>('#bet-slip-place')!;
  const clearBtn = root.querySelector<HTMLButtonElement>('#bet-slip-clear')!;
  const messageEl = root.querySelector<HTMLElement>('#bet-slip-message')!;
  const selectionsEl = root.querySelector('#bet-slip-selections')!;

  const stake = Number(stakeInput.value || 0);
  const isParlay = selections.length > 1;
  selectionsEl.innerHTML = '';
  if (!selections.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Select odds from the scoreboard to build your slip.';
    selectionsEl.appendChild(p);
  } else {
    const card = document.createElement('div');
    card.className = 'bet-card bet-card--slip';
    const combinedLabel = formatCombinedOdds(selections, oddsFormat);
    const primaryLegPrice = formatOdds(selections[0].price, oddsFormat);
    const header = `
      <div class="bet-card__header">
        <div class="bet-card__kind">${escapeHtml(isParlay ? 'Parlay' : 'Single')}</div>
        <div class="bet-card__price">${escapeHtml(isParlay ? combinedLabel : primaryLegPrice)}</div>
        <div class="bet-card__status muted">Pending</div>
      </div>`;
    const legs = selections
      .map((leg, idx) => renderLegLine(leg, oddsFormat, idx, true))
      .join('');
    card.innerHTML = `${header}<div class="bet-card__legs">${legs}</div>`;
    card.querySelectorAll<HTMLButtonElement>('.bet-card__leg-remove').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.stopPropagation();
        const idx = Number(btn.dataset.index);
        if (Number.isInteger(idx)) onRemoveSelection(idx);
      });
    });
    selectionsEl.appendChild(card);
  }

  kindEl.textContent = isParlay ? 'Parlay' : 'Single';
  const multiplier = selections.reduce((m, s) => m * americanToDecimal(s.price), 1);
  const payout = stake > 0 ? stake * multiplier : 0;
  payoutEl.textContent = formatCurrency(payout);
  oddsWrap.classList.toggle('hidden', !isParlay);
  profitWrap.classList.toggle('hidden', !isParlay);
  if (isParlay) {
    oddsEl.textContent = formatParlayOdds(multiplier, oddsFormat);
    profitEl.textContent = formatCurrency(Math.max(0, payout - stake));
  }
  placeBtn.disabled = !(selections.length && stake > 0 && stake <= (bankroll.available || 0));
  messageEl.textContent = stake > (bankroll.available || 0) ? 'Stake exceeds available balance.' : '';

  stakeInput.oninput = () => onChangeStake(Number(stakeInput.value || 0));
  placeBtn.onclick = onPlace;
  clearBtn.onclick = onClear;
}

export function renderBankroll(header: HTMLElement, data: { available: number; pending_stake: number; pending_potential: number }) {
  const availableEl = header.querySelector('#bankroll-available')!;
  const pendingEl = header.querySelector('#bankroll-pending')!;
  const potentialEl = header.querySelector('#bankroll-potential')!;
  availableEl.textContent = formatCurrency(data.available);
  pendingEl.textContent = formatCurrency(data.pending_stake);
  potentialEl.textContent = formatCurrency(data.pending_potential);
}

export function renderBetLists(
  pendingRoot: HTMLElement,
  settledRoot: HTMLElement,
  pending: BetSlip[],
  settled: BetSlip[],
  oddsFormat: 'american' | 'decimal',
) {
  pendingRoot.innerHTML = buildBetCards(pending, 'No pending bets.', false, oddsFormat);
  settledRoot.innerHTML = buildBetCards(settled, 'No settled bets.', true, oddsFormat);
}

function describeLeg(leg: BetLeg) {
  switch (leg.market) {
    case 'moneyline':
      return (leg.label) || (leg.selection === 'home' ? 'Home ML' : 'Away ML');
    case 'spread':
      return `${capitalize(leg.selection)} ${formatSpreadPoint(leg.point)}`;
    case 'total':
      return `${leg.selection === 'over' ? 'Over' : 'Under'} ${formatTotalPoint(leg.point)}`;
    default:
      return leg.label || 'Selection';
  }
}

function formatSpreadPoint(point?: number) {
  if (point == null) return '';
  return point > 0 ? `+${point}` : `${point}`;
}

function formatTotalPoint(point?: number) {
  if (point == null) return '';
  return point % 1 === 0 ? point.toFixed(0) : point.toString();
}

function capitalize(value: string) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderLegLine(leg: BetLeg, oddsFormat: 'american' | 'decimal', index?: number, removable = false) {
  const label = leg.label || describeLeg(leg);
  const price = formatOdds(leg.price, oddsFormat);
  const context = formatLegContext(leg);
  const result = formatLegResult(leg);
  const wrapper = document.createElement('div');
  wrapper.className = 'bet-card__leg';

  const info = document.createElement('div');
  info.innerHTML = `
    <strong>${escapeHtml(label)}</strong>
    ${context ? `<div class="bet-card__context">${escapeHtml(context)}</div>` : ''}`;
  wrapper.appendChild(info);

  const meta = document.createElement('div');
  meta.className = 'bet-card__leg-meta';
  meta.innerHTML = `
    <span class="bet-card__leg-price">${escapeHtml(price)}</span>
    ${result ? `<span class="bet-card__leg-result ${result.toLowerCase()}">${escapeHtml(result)}</span>` : ''}`;
  wrapper.appendChild(meta);

  if (removable && Number.isInteger(index)) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'bet-card__leg-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.dataset.index = String(index);
    wrapper.appendChild(removeBtn);
  }

  const container = document.createElement('div');
  container.appendChild(wrapper);
  return container.innerHTML;
}

function formatLegContext(leg: BetLeg) {
  const game = extractGame(leg);
  if (!game) return '';
  const matchup = `${game.away_team} @ ${game.home_team}`;
  const datePart = game.date ? new Date(game.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const timePart = game.time || '';
  const parts = [matchup];
  if (datePart) parts.push(datePart);
  if (timePart) parts.push(timePart);
  return parts.join(' • ');
}

function extractGame(leg: BetLeg): ScoreboardGame | undefined {
  const meta = leg.metadata as { game?: ScoreboardGame } | undefined;
  return (meta && meta.game) || leg.game;
}

function formatLegResult(leg: BetLeg) {
  const meta = leg.metadata as { result?: string } | undefined;
  const value = meta?.result;
  if (!value || typeof value !== 'string') return '';
  if (value === 'won') return 'Won';
  if (value === 'lost') return 'Lost';
  if (value === 'void') return 'Push';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildBetCards(slips: BetSlip[], empty: string, newestFirst: boolean, oddsFormat: 'american' | 'decimal') {
  if (!slips.length) return `<p class="muted">${escapeHtml(empty)}</p>`;
  const sorted = slips.slice().sort((a, b) => {
    const ta = new Date(a.placed_at).getTime();
    const tb = new Date(b.placed_at).getTime();
    return newestFirst ? (tb - ta) : (ta - tb);
  });
  return sorted.map((slip) => buildBetCard(slip, oddsFormat)).join('');
}

function buildBetCard(slip: BetSlip, oddsFormat: 'american' | 'decimal') {
  const combined = computeCombinedDecimal(slip.legs);
  const priceLabel = combined != null && slip.legs.length > 1
    ? formatParlayOdds(combined, oddsFormat)
    : formatOdds(slip.legs[0]?.price ?? 0, oddsFormat);
  const statusText = formatSlipStatus(slip.status);
  const statusClass = `bet-card bet-card--${slip.status}`;
  const legs = slip.legs.map((leg) => renderLegLine(leg, oddsFormat)).join('');
  const payoutLabel = slip.status === 'pending' ? 'Potential' : 'Payout';
  const payoutValue = formatCurrency(slip.payout ?? 0);
  const placed = formatPlacedDate(slip.placed_at);
  return `
    <div class="${statusClass}">
      <div class="bet-card__header">
        <div class="bet-card__kind">${escapeHtml(capitalize(slip.kind))}</div>
        <div class="bet-card__price">${escapeHtml(priceLabel)}</div>
        <div class="bet-card__status">${escapeHtml(statusText)}</div>
      </div>
      <div class="bet-card__legs">${legs}</div>
      <dl class="bet-card__meta">
        <div><dt>Stake</dt><dd>${formatCurrency(slip.stake)}</dd></div>
        <div><dt>${escapeHtml(payoutLabel)}</dt><dd>${payoutValue}</dd></div>
        <div><dt>Placed</dt><dd>${escapeHtml(placed)}</dd></div>
      </dl>
    </div>`;
}

function formatSlipStatus(status: BetSlip['status']) {
  switch (status) {
    case 'won': return 'Won';
    case 'lost': return 'Lost';
    case 'void': return 'Push';
    default: return 'Pending';
  }
}

function formatPlacedDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function computeCombinedDecimal(legs: BetLeg[]) {
  if (!legs.length) return null;
  return legs.reduce((acc, leg) => acc * americanToDecimal(leg.price), 1);
}

function formatCombinedOdds(legs: BetLeg[], format: 'american' | 'decimal') {
  const combined = computeCombinedDecimal(legs);
  if (combined == null) return '—';
  return formatParlayOdds(combined, format);
}

function formatParlayOdds(decimalMultiplier: number, format: 'american' | 'decimal') {
  if (!Number.isFinite(decimalMultiplier) || decimalMultiplier <= 0) return '—';
  if (format === 'decimal') {
    return decimalMultiplier.toFixed(2);
  }
  const american = decimalToAmerican(decimalMultiplier);
  return american > 0 ? `+${american}` : `${american}`;
}

function formatOdds(price: number, format: 'american' | 'decimal') {
  if (!Number.isFinite(price)) return '—';
  if (format === 'decimal') {
    const dec = americanToDecimal(price);
    return dec.toFixed(2);
  }
  return price > 0 ? `+${price}` : `${price}`;
}
