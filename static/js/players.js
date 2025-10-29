import { escapeHtml, qs, showToast, openModal, closeModal, formatNumber } from './utils.js';

export function initPlayers({ api, state }) {
  const panel = qs('#players-panel');
  const listEl = qs('#players-list');
  const searchInput = qs('#players-search');
  const viewSelect = qs('#players-view');
  const modal = qs('#player-modal');
  const modalBody = qs('#player-modal-body');
  const modalClose = modal?.querySelector('.player-modal__close');

  let view = 'totals';
  let search = '';

  function bindModal() {
    if (modal) {
      modal.addEventListener('click', (e) => { if (e.target.closest('[data-close-player-modal]')) closeModal(modal); });
    }
    if (modalClose) modalClose.addEventListener('click', (e) => { e.preventDefault(); closeModal(modal); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) closeModal(modal); });
  }

  async function load() {
    if (!panel || !state.leagueId) return;
    const date = qs('#scoreboard-date')?.value || '';
    try {
      const data = await api.players(state.leagueId, { date, view, search, limit: 25, offset: 0 });
      render(data);
    } catch (err) { showToast(err.message || 'Unable to load players.', 'error'); if (listEl) listEl.innerHTML = `<p class="error">${escapeHtml(err.message || 'Unable to load players.')}</p>`; }
  }

  function render(data) {
    if (!listEl) return;
    const rows = (data.results || []).map(p => (
      `<tr>
        <td><button type="button" class="player-link" data-player-id="${Number(p.player_id)}">${escapeHtml(p.player_name || 'Player')}</button></td>
        <td>${escapeHtml(p.team || '')}</td>
        <td>${Number(p.GP || 0)}</td>
        ${view === 'averages' ? '' : `<td>${formatNumber(p.fantasy, { decimals: 1 })}</td>`}
        <td>${formatNumber(p.MIN, { decimals: 1 })}</td>
        <td>${formatNumber(p.PTS, { decimals: 1 })}</td>
        <td>${formatNumber(p.REB, { decimals: 1 })}</td>
        <td>${formatNumber(p.AST, { decimals: 1 })}</td>
        <td>${formatNumber(p.STL, { decimals: 1 })}</td>
        <td>${formatNumber(p.BLK, { decimals: 1 })}</td>
      </tr>`)).join('');
    const thead = `
      <thead><tr>
        <th>Player</th><th>Team</th><th>GP</th>${view === 'averages' ? '' : '<th>Fan Pts</th>'}<th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th>
      </tr></thead>`;
    const body = rows || '<tr class="empty"><td colspan="10">No players to display</td></tr>';
    listEl.innerHTML = `<div class="players-table-wrapper"><table>${thead}<tbody>${body}</tbody></table></div>`;
    listEl.querySelectorAll('.player-link').forEach(btn => {
      btn.addEventListener('click', () => openPlayer(Number(btn.dataset.playerId)));
    });
  }

  async function openPlayer(playerId, dateOverride = null) {
    if (!modal || !modalBody) return;
    const date = (dateOverride !== null && dateOverride !== undefined) ? dateOverride : (qs('#scoreboard-date')?.value || '');
    modalBody.innerHTML = '<div class="player-card__loading">Loading player…</div>';
    openModal(modal);
    try {
      const profile = await api.playerProfile(playerId, { leagueId: state.leagueId, date });
      renderPlayerModal(profile);
    } catch (err) {
      modalBody.innerHTML = `<p class="player-card__empty error">${escapeHtml(err.message || 'Unable to load player.')}</p>`;
    }
  }

  function initials(name) {
    if (!name) return '?';
    return String(name).split(/\s+/).filter(Boolean).map(p => p[0]).slice(0,2).join('');
  }

  function pct(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return '0%';
    return `${(v * 100).toFixed(1).replace(/\.0$/, '')}%`;
  }

  function renderPlayerModal(profile) {
    if (!profile || !profile.player || !modalBody) return;
    const p = profile.player;
    const avatar = p.image_url
      ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name || 'Player')} headshot" />`
      : `<div class="player-card__avatar-fallback">${escapeHtml(initials(p.name))}</div>`;
    const metaLines = [];
    if (Array.isArray(p.positions) && p.positions.length) metaLines.push(p.positions.join(', '));
    metaLines.push(p.team_name || p.team_abbreviation || '');
    if (p.fantasy_team) metaLines.push(`Rostered: ${p.fantasy_team}`); else metaLines.push('Status: Free Agent');
    if (Number.isFinite(p.season_fantasy_avg)) metaLines.push(`Season Avg: ${formatNumber(p.season_fantasy_avg, { decimals: 1 })} fpts`);
    const metaHtml = metaLines.filter(Boolean).map(line => `<span>${escapeHtml(line)}</span>`).join('');
    const header = `
      <header class="player-card__header">
        <div class="player-card__avatar">${avatar}</div>
        <div class="player-card__details">
          <h2 id="player-modal-title">${escapeHtml(p.name || 'Player')}</h2>
          <div class="player-card__meta-list">${metaHtml}</div>
        </div>
      </header>`;
    const summaryHeaders = ['Split', 'Fan Pts', 'MIN', 'FG', 'FG%', '3PT', '3PT%', 'FT', 'FT%', 'REB', 'AST', 'STL', 'BLK', 'TOV', 'PTS'];
    const summary = Array.isArray(profile.summary) && profile.summary.length
      ? `<table class="player-card__summary"><thead><tr>${summaryHeaders.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${profile.summary.map(row => {
          const stats = row.stats || {};
          const fg = `${formatNumber(stats.FGM || 0, { decimals: 1 })}/${formatNumber(stats.FGA || 0, { decimals: 1 })}`;
          const fgPct = Number.isFinite(stats.FG_PCT) ? `${stats.FG_PCT.toFixed(1).replace(/\.0$/, '')}%` : '0%';
          const fg3 = `${formatNumber(stats.FG3M || 0, { decimals: 1 })}/${formatNumber(stats.FG3A || 0, { decimals: 1 })}`;
          const fg3Pct = Number.isFinite(stats.FG3_PCT) ? `${stats.FG3_PCT.toFixed(1).replace(/\.0$/, '')}%` : '0%';
          const ft = `${formatNumber(stats.FTM || 0, { decimals: 1 })}/${formatNumber(stats.FTA || 0, { decimals: 1 })}`;
          const ftPct = Number.isFinite(stats.FT_PCT) ? `${stats.FT_PCT.toFixed(1).replace(/\.0$/, '')}%` : '0%';
          return `<tr>
            <td>${escapeHtml(row.label || '')}</td>
            <td>${formatNumber(row.fantasy_points_total || row.fantasy_points_avg || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.MIN || 0, { decimals: 1 })}</td>
            <td>${fg}</td>
            <td>${fgPct}</td>
            <td>${fg3}</td>
            <td>${fg3Pct}</td>
            <td>${ft}</td>
            <td>${ftPct}</td>
            <td>${formatNumber(stats.REB || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.AST || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.STL || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.BLK || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.TOV || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.PTS || 0, { decimals: 1 })}</td>
          </tr>`;
        }).join('')}</tbody></table>`
      : '<p class="player-card__empty">No summary stats yet.</p>';
    const logHeaders = ['Date', 'Opp', 'Fan Pts', 'MIN', 'FG', 'FG%', '3PT', '3PT%', 'FT', 'FT%', 'REB', 'AST', 'STL', 'BLK', 'TOV', 'PTS'];
    const log = Array.isArray(profile.game_log) && profile.game_log.length
      ? `<table class="player-card__log"><thead><tr>${logHeaders.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${profile.game_log.map(g => {
          const stats = g.stats || {};
          const fg = `${formatNumber(stats.FGM || 0, { decimals: 0 })}/${formatNumber(stats.FGA || 0, { decimals: 0 })}`;
          const fgPct = Number.isFinite(stats.FG_PCT) ? `${(stats.FG_PCT * 100).toFixed(1).replace(/\.0$/, '')}%` : '0%';
          const fg3 = `${formatNumber(stats.FG3M || 0, { decimals: 0 })}/${formatNumber(stats.FG3A || 0, { decimals: 0 })}`;
          const fg3Pct = Number.isFinite(stats.FG3_PCT) ? `${(stats.FG3_PCT * 100).toFixed(1).replace(/\.0$/, '')}%` : '0%';
          const ft = `${formatNumber(stats.FTM || 0, { decimals: 0 })}/${formatNumber(stats.FTA || 0, { decimals: 0 })}`;
          const ftPct = Number.isFinite(stats.FT_PCT) ? `${(stats.FT_PCT * 100).toFixed(1).replace(/\.0$/, '')}%` : '0%';
          return `<tr>
            <td>${escapeHtml(g.date || '')}</td>
            <td>${escapeHtml(g.matchup || '')}</td>
            <td>${formatNumber(g.fantasy || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.MIN || 0, { decimals: 1 })}</td>
            <td>${fg}</td>
            <td>${fgPct}</td>
            <td>${fg3}</td>
            <td>${fg3Pct}</td>
            <td>${ft}</td>
            <td>${ftPct}</td>
            <td>${formatNumber(stats.REB || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.AST || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.STL || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.BLK || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.TOV || 0, { decimals: 1 })}</td>
            <td>${formatNumber(stats.PTS || 0, { decimals: 1 })}</td>
          </tr>`;
        }).join('')}</tbody></table>`
      : '<p class="player-card__empty">No game log entries.</p>';
    modalBody.innerHTML = `<article class="player-card">${header}<div class="player-card__body">${summary}${log}</div></article>`;
  }

  if (searchInput) searchInput.addEventListener('input', () => { search = searchInput.value.trim(); load(); });
  if (viewSelect) viewSelect.addEventListener('change', () => { view = viewSelect.value; load(); });
  bindModal();

  return { load, open: openPlayer };
}
