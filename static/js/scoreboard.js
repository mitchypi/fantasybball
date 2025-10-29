import { escapeHtml } from './utils.js';

export function initScoreboard({ elements, api, state, onOddsSelected, onOpenPlayer }) {
  const list = elements.list;
  const dateInput = elements.dateInput;

  async function load(date) {
    try {
      const data = await api.getGames(state.leagueId, date);
      render(data);
      if (dateInput) dateInput.value = data.date || '';
    } catch (err) {
      // Show a friendly placeholder instead of failing hard
      render({ games: [] });
    }
  }

  async function loadBox(gameDate, gameId, card, detail) {
    try {
      detail.innerHTML = '<p>Loading box score…</p>';
      const box = await api.boxscore(gameId, { leagueId: state.leagueId, date: gameDate });
      renderBox(detail, box);
      card.classList.add('active');
    } catch (err) {
      detail.innerHTML = `<p class="error">${escapeHtml(err.message || 'Unable to load box score.')}</p>`;
    }
  }

  function renderBox(detail, box) {
    function fmt(n, d = 0) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(d).replace(/\.0+$/, '') : '0'; }
    function teamBlock(team) {
      const rows = (team.players || []).map(p => {
        const fg = `${fmt(p.FGM)}/${fmt(p.FGA)}`;
        const fg3 = `${fmt(p.FG3M)}/${fmt(p.FG3A)}`;
        const ft = `${fmt(p.FTM)}/${fmt(p.FTA)}`;
        const min = fmt(p.MINUTES);
        return `
          <tr>
            <td><button type=\"button\" class=\"player-link\" data-player-id=\"${Number(p.player_id) || 0}\">${escapeHtml(p.player_name || '')}</button></td>
            <td>${min}</td>
            <td>${fg}</td>
            <td>${fg3}</td>
            <td>${ft}</td>
            <td>${fmt(p.PTS)}</td>
            <td>${fmt(p.REB)}</td>
            <td>${fmt(p.AST)}</td>
            <td>${fmt(p.STL)}</td>
            <td>${fmt(p.BLK)}</td>
            <td>${fmt(p.TOV)}</td>
          </tr>`;
      }).join('');
      return `
        <section class=\"team-card\" data-result-date=\"${escapeHtml(box.date || '')}\"> 
          <h4>${escapeHtml(team.name || '')}</h4>
          <div class=\"player-card__table-wrapper\">
            <table class=\"box\">
              <thead>
                <tr><th>Player</th><th>MIN</th><th>FG</th><th>3PT</th><th>FT</th><th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TOV</th></tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </section>`;
    }
    detail.innerHTML = `${teamBlock(box.away_team)}${teamBlock(box.home_team)}`;
    detail.querySelectorAll('.player-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = Number(btn.dataset.playerId);
        const date = box.date || '';
        if (onOpenPlayer) onOpenPlayer(pid, { date });
      });
    });
  }

  function render(data) {
    if (!list) return;
    list.innerHTML = '';
    const games = data.games || [];
    if (!games.length) {
      const li = document.createElement('li');
      li.className = 'score-card disabled';
      li.innerHTML = '<div class="teams"><div class="team-row"><span>No games to show.</span></div></div>';
      list.appendChild(li);
      return;
    }
    games.forEach(game => {
      const li = document.createElement('li');
      li.className = 'score-card';
      li.dataset.gameId = String(game.game_id);
      li.dataset.date = data.date || '';
      const isSim = game.simulated === undefined ? true : Boolean(game.simulated);
      const awayScore = isSim ? (game.away_score ?? '--') : '--';
      const homeScore = isSim ? (game.home_score ?? '--') : '--';
      const statusText = game.status || (isSim ? 'Final' : 'Not played yet');
      const summary = document.createElement('div');
      summary.className = 'score-summary';
      const periodDisplay = game.period_display || '';
      const timeText = (game.time && game.time !== game.status) ? game.time : '';
      summary.innerHTML = `
        <div class="teams">
          <div class="team-row"><span>${escapeHtml(game.away_team || '')}</span><span>${escapeHtml(String(awayScore))}</span></div>
          <div class="team-row"><span>${escapeHtml(game.home_team || '')}</span><span>${escapeHtml(String(homeScore))}</span></div>
        </div>
        <div class="meta">
          <div class="status">${escapeHtml(statusText)}</div>
          ${timeText ? `<div>${escapeHtml(timeText)}</div>` : ''}
          ${periodDisplay ? `<div>${escapeHtml(periodDisplay)}</div>` : ''}
        </div>
        ${buildOddsPreview(game)}`;
      summary.setAttribute('role', 'button');
      summary.setAttribute('tabindex', '0');
      const detail = document.createElement('div');
      detail.className = 'score-detail';
      detail.innerHTML = isSim ? '<p>Click to view the full box score.</p>' : '<p>Simulate this day to unlock the box score.</p>';
      li.append(summary, detail);
      list.appendChild(li);
      if (isSim) {
        const handler = () => {
          const isActive = li.classList.contains('active');
          if (isActive) {
            li.classList.remove('active');
            detail.innerHTML = '<p>Click to view the full box score.</p>';
          } else {
            loadBox(data.date, game.game_id, li, detail);
          }
        };
        summary.addEventListener('click', handler);
        summary.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
      }
      if (game.odds && onOddsSelected) {
        summary.querySelectorAll('[data-odds-selection]').forEach(node => {
          node.addEventListener('click', (evt) => {
            evt.stopPropagation();
            try {
              const payload = JSON.parse(node.getAttribute('data-odds-selection'));
              onOddsSelected({ ...payload, game });
            } catch (_) {
              /* ignore */
            }
          });
        });
      }
    });
  }

  function buildOddsPreview(game) {
    const odds = game?.odds;
    if (!odds || !odds.markets) return '';
    const ml = odds.markets.moneyline || {};
    const homeName = odds.home_team?.full_name;
    const awayName = odds.away_team?.full_name;
    const home = homeName ? ml[homeName] : null;
    const away = awayName ? ml[awayName] : null;
    if (!home && !away) return '';
    const chip = (label, selection, price) => {
      const payload = JSON.stringify({ gameId: game.game_id, label, market: 'moneyline', selection, price: Number(price) || 0 }).replace(/'/g, '&apos;');
      const priceLabel = price > 0 ? `+${price}` : `${price}`;
      return `<button type="button" class="odds-chip" data-odds-selection='${payload}'>${escapeHtml(label)} ${escapeHtml(String(priceLabel))}</button>`;
    };
    return `
      <div class="odds-preview">
        ${away ? chip(`${game.away_team} ML`, 'away', away.price) : ''}
        ${home ? chip(`${game.home_team} ML`, 'home', home.price) : ''}
      </div>`;
  }

  return { load };
}
