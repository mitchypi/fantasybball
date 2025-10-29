import { fetchJSON } from './utils.js';

export async function ensureGlobalLeague() {
  const data = await fetchJSON('/global/league');
  return data?.league_id || null;
}

export const API = {
  getLeagueState: (leagueId) => fetchJSON(`/leagues/${leagueId}`),
  getGames: (leagueId, date) => {
    const params = new URLSearchParams({ league_id: leagueId });
    if (date) params.set('date', date);
    return fetchJSON(`/games?${params.toString()}`);
  },
  simulate: (leagueId) => fetchJSON(`/leagues/${leagueId}/simulate`, { method: 'POST' }),
  advance: (leagueId) => fetchJSON(`/leagues/${leagueId}/advance`, { method: 'POST' }),
  reset: (leagueId) => fetchJSON(`/leagues/${leagueId}/reset`, { method: 'POST' }),
  bankroll: (leagueId) => fetchJSON(`/leagues/${leagueId}/bankroll`),
  bets: (leagueId) => fetchJSON(`/leagues/${leagueId}/bets`),
  placeBet: (leagueId, payload) => fetchJSON(`/leagues/${leagueId}/bets`, { method: 'POST', body: JSON.stringify(payload) }),
  players: (leagueId, { date, view = 'totals', search = '', sort = 'fantasy', order = 'desc', limit = 25, offset = 0 } = {}) => {
    const params = new URLSearchParams({ view, sort, order, limit: String(limit), offset: String(offset) });
    if (date) params.set('date', date);
    if (search) params.set('search', search);
    return fetchJSON(`/leagues/${leagueId}/players?${params.toString()}`);
  },
  playerProfile: (playerId, { leagueId, date } = {}) => {
    const params = new URLSearchParams();
    if (leagueId) params.set('league_id', leagueId);
    if (date) params.set('date', date);
    return fetchJSON(`/players/${playerId}/profile${params.toString() ? `?${params.toString()}` : ''}`);
  },
  boxscore: (gameId, { leagueId, date }) => {
    const params = new URLSearchParams({ league_id: leagueId });
    if (date) params.set('date', date);
    return fetchJSON(`/games/${gameId}/boxscore?${params.toString()}`);
  },
};

