import type { BetMarket, BetSelection, BoxscorePayload, ScoreboardGame, ScoreboardPayload } from '../types';
import { americanToDecimal, escapeHtml } from '../utils';

interface OddsSelectionPayload {
  game_id: string | number;
  market: BetMarket;
  selection: BetSelection;
  price: number;
  point?: number;
  label: string;
  game: ScoreboardGame;
}

interface RenderOptions {
  onOddsSelected?: (leg: OddsSelectionPayload) => void;
  onRequestBoxscore?: (gameId: string | number, date: string) => Promise<BoxscorePayload | undefined>;
  showFinalScores?: boolean;
  oddsFormat?: 'american' | 'decimal';
}

export function renderScoreboard(
  container: HTMLElement,
  payload: ScoreboardPayload,
  options: RenderOptions = {},
) {
  container.innerHTML = '';
  container.classList.add('scoreboard-list');
  const games = payload.games || [];
  if (!games.length) {
    const li = document.createElement('li');
    li.className = 'score-card disabled';
    li.innerHTML = '<div class="teams"><div class="team-row"><span>No games to show.</span></div></div>';
    container.appendChild(li);
    return;
  }

  games.forEach((game) => {
    const li = document.createElement('li');
    li.className = 'score-card';
    li.dataset.gameId = String(game.game_id);
    li.dataset.date = payload.date || '';

    const summary = document.createElement('div');
    summary.className = 'score-summary';
    const showFinal = options.showFinalScores ?? true;
    const scoresVisible = showFinal && game.simulated;
    const awayScore = scoresVisible ? (game.away_score ?? '--') : '--';
    const homeScore = scoresVisible ? (game.home_score ?? '--') : '--';
    const statusText = scoresVisible ? (game.status || 'Final') : 'Awaiting simulation';
    const statusClass = scoresVisible ? 'status-final' : 'status-upcoming';

    summary.innerHTML = `
      <div class="teams">
        <div class="team-row"><span>${escapeHtml(game.away_team || '')}</span><span>${escapeHtml(String(awayScore))}</span></div>
        <div class="team-row"><span>${escapeHtml(game.home_team || '')}</span><span>${escapeHtml(String(homeScore))}</span></div>
      </div>
      <div class="meta">
        <div class="${statusClass}">${escapeHtml(statusText)}</div>
        ${game.time ? `<div>${escapeHtml(game.time)}</div>` : ''}
        ${game.period_display ? `<div>${escapeHtml(game.period_display)}</div>` : ''}
      </div>
    `;

    li.appendChild(summary);
    const oddsWrap = buildOddsPreview(game, options.oddsFormat ?? 'american', options.onOddsSelected);
    if (oddsWrap) li.appendChild(oddsWrap);

    if (options.onRequestBoxscore && scoresVisible) {
      const detail = document.createElement('div');
      detail.className = 'score-detail';
      detail.innerHTML = '<p class="muted">Click to load the full box score.</p>';
      li.appendChild(detail);
      summary.addEventListener('click', () => toggleDetail());
      summary.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleDetail();
        }
      });
      summary.setAttribute('role', 'button');
      summary.setAttribute('tabindex', '0');
      async function toggleDetail() {
        const isActive = li.classList.contains('active');
        if (isActive) {
          li.classList.remove('active');
          detail.innerHTML = '<p class="muted">Click to load the full box score.</p>';
          return;
        }
        li.classList.add('active');
        detail.innerHTML = '<p class="muted">Loading box score…</p>';
        try {
          const data = await options.onRequestBoxscore?.(game.game_id, payload.date);
          if (!data) {
            detail.innerHTML = '<p class="muted">Box score unavailable.</p>';
            return;
          }
          renderBoxscore(detail, data);
        } catch (error) {
          detail.innerHTML = `<p class="error">${escapeHtml((error as Error).message || 'Unable to load box score.')}</p>`;
        }
      }
    }

    container.appendChild(li);
  });
}

function buildOddsPreview(game: ScoreboardGame, format: 'american' | 'decimal', onSelect?: RenderOptions['onOddsSelected']) {
  const odds = game?.odds;
  if (!odds || !odds.markets) return null;
  const wrap = document.createElement('div');
  wrap.className = 'odds-preview';

  const markets = odds.markets;
  if (markets.moneyline) {
    wrap.appendChild(buildMarketBlock('Moneyline', buildMoneylineChips(game, markets.moneyline, odds, format, onSelect)));
  }
  if (markets.spread) {
    wrap.appendChild(buildMarketBlock('Spread', buildSpreadChips(game, markets.spread, odds, format, onSelect)));
  }
  if (markets.total) {
    wrap.appendChild(buildMarketBlock('Total', buildTotalChips(game, markets.total, format, onSelect)));
  }
  if (!wrap.childNodes.length) return null;
  return wrap;
}

function buildMarketBlock(title: string, chips: HTMLElement[]) {
  if (!chips.length) return document.createElement('div');
  const block = document.createElement('div');
  block.className = 'odds-market';
  const heading = document.createElement('div');
  heading.className = 'odds-market__title';
  heading.textContent = title;
  const chipWrap = document.createElement('div');
  chipWrap.className = 'odds-market__chips';
  chips.forEach(chipEl => chipWrap.appendChild(chipEl));
  block.append(heading, chipWrap);
  return block;
}

function buildMoneylineChips(
  game: ScoreboardGame,
  market: Record<string, { price: number }>,
  oddsSnapshot: ScoreboardGame['odds'],
  format: 'american' | 'decimal',
  onSelect?: RenderOptions['onOddsSelected'],
) {
  const chips: HTMLElement[] = [];
  const homeName = oddsSnapshot?.home_team?.full_name || game.home_team;
  const awayName = oddsSnapshot?.away_team?.full_name || game.away_team;
  const homeEntry = homeName ? market?.[homeName] : undefined;
  const awayEntry = awayName ? market?.[awayName] : undefined;
  if (awayEntry) chips.push(createChip(game, 'moneyline', 'away', awayEntry.price, `${awayName || game.away_team} ML`, undefined, format, onSelect));
  if (homeEntry) chips.push(createChip(game, 'moneyline', 'home', homeEntry.price, `${homeName || game.home_team} ML`, undefined, format, onSelect));
  return chips;
}

function buildSpreadChips(
  game: ScoreboardGame,
  market: Record<string, { price: number; point: number }>,
  oddsSnapshot: ScoreboardGame['odds'],
  format: 'american' | 'decimal',
  onSelect?: RenderOptions['onOddsSelected'],
) {
  const chips: HTMLElement[] = [];
  const homeName = oddsSnapshot?.home_team?.full_name || game.home_team;
  const awayName = oddsSnapshot?.away_team?.full_name || game.away_team;
  const homeEntry = homeName ? market?.[homeName] : undefined;
  const awayEntry = awayName ? market?.[awayName] : undefined;
  if (awayEntry) {
    const point = awayEntry.point;
    chips.push(createChip(game, 'spread', 'away', awayEntry.price, `${awayName || game.away_team} ${formatSpreadPoint(point)}`, point, format, onSelect));
  }
  if (homeEntry) {
    const point = homeEntry.point;
    chips.push(createChip(game, 'spread', 'home', homeEntry.price, `${homeName || game.home_team} ${formatSpreadPoint(point)}`, point, format, onSelect));
  }
  return chips;
}

function buildTotalChips(
  game: ScoreboardGame,
  market: Record<string, { price: number; point: number }>,
  format: 'american' | 'decimal',
  onSelect?: RenderOptions['onOddsSelected'],
) {
  const chips: HTMLElement[] = [];
  Object.entries(market).forEach(([rawLabel, entry]) => {
    const selection = rawLabel.toLowerCase() === 'over' ? 'over' : 'under';
    const label = `${rawLabel} ${formatTotalPoint(entry.point)}`;
    chips.push(createChip(game, 'total', selection, entry.price, label, entry.point, format, onSelect));
  });
  return chips;
}

function createChip(
  game: ScoreboardGame,
  market: OddsSelectionPayload['market'],
  selection: OddsSelectionPayload['selection'],
  price: number,
  label: string,
  point: number | undefined,
  format: 'american' | 'decimal',
  onSelect?: RenderOptions['onOddsSelected'],
) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'odds-chip';
  btn.innerHTML = `${escapeHtml(label)} <span>${escapeHtml(formatOdds(price, format))}</span>`;
  const payload = {
    game_id: game.game_id,
    label,
    market,
    selection,
    price: Number(price) || 0,
    point,
  };
  btn.dataset.oddsSelection = JSON.stringify(payload);
  if (onSelect) {
    btn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      onSelect({ ...payload, game });
    });
  } else {
    btn.disabled = true;
  }
  return btn;
}

function renderBoxscore(target: HTMLElement, boxscore: BoxscorePayload) {
  target.innerHTML = '';
  target.appendChild(buildTeamBlock(boxscore.away_team, 'Away'));
  target.appendChild(buildTeamBlock(boxscore.home_team, 'Home'));
}

function buildTeamBlock(team: BoxscorePayload['home_team'], label: string) {
  const section = document.createElement('section');
  section.className = 'boxscore-team';
  const heading = document.createElement('h4');
  heading.textContent = `${label}: ${team.name}${Number.isFinite(team.score) ? ` • ${team.score}` : ''}`;
  section.appendChild(heading);
  const wrapper = document.createElement('div');
  wrapper.className = 'boxscore-table-wrapper';
  const table = document.createElement('table');
  table.className = 'boxscore-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Player</th>
        <th>POS</th>
        <th>MIN</th>
        <th>FG</th>
        <th>3PT</th>
        <th>FT</th>
        <th>REB</th>
        <th>AST</th>
        <th>STL</th>
        <th>BLK</th>
        <th>TOV</th>
        <th>PTS</th>
      </tr>
    </thead>
    <tbody>
      ${team.players.map(row => boxscoreRow(row)).join('')}
    </tbody>`;
  wrapper.appendChild(table);
  section.appendChild(wrapper);
  return section;
}

function boxscoreRow(row: BoxscorePayload['home_team']['players'][number]) {
  const name = escapeHtml(row.player_name || '');
  const pos = escapeHtml(row.position || '');
  const mins = fmt(row.MINUTES, 1);
  const fg = `${fmt(row.FGM)}/${fmt(row.FGA)}`;
  const fg3 = `${fmt(row.FG3M)}/${fmt(row.FG3A)}`;
  const ft = `${fmt(row.FTM)}/${fmt(row.FTA)}`;
  const reb = fmt(row.REB);
  const ast = fmt(row.AST);
  const stl = fmt(row.STL);
  const blk = fmt(row.BLK);
  const tov = fmt(row.TOV);
  const pts = fmt(row.PTS);
  return `
    <tr>
      <td>${name}</td>
      <td>${pos}</td>
      <td>${mins}</td>
      <td>${fg}</td>
      <td>${fg3}</td>
      <td>${ft}</td>
      <td>${reb}</td>
      <td>${ast}</td>
      <td>${stl}</td>
      <td>${blk}</td>
      <td>${tov}</td>
      <td>${pts}</td>
    </tr>`;
}

function fmt(value: number | undefined, decimals = 0) {
  if (!Number.isFinite(value ?? NaN)) return '0';
  const factor = Math.pow(10, decimals);
  return String(Math.round((value ?? 0) * factor) / factor).replace(/\.0+$/, '');
}

function formatSpreadPoint(point: number) {
  return point > 0 ? `+${point}` : `${point}`;
}

function formatTotalPoint(point: number) {
  return point % 1 === 0 ? point.toFixed(0) : point.toString();
}

function formatOdds(price: number, format: 'american' | 'decimal') {
  if (!Number.isFinite(price)) return '—';
  if (format === 'decimal') {
    const dec = americanToDecimal(price);
    return dec.toFixed(2);
  }
  return price > 0 ? `+${price}` : `${price}`;
}
