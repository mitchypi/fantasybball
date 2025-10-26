const scoreboardList = document.getElementById("scoreboard-list");
const scoreboardDateInput = document.getElementById("scoreboard-date");
const simulateBtn = document.getElementById("simulate-day");
const resetBtn = document.getElementById("reset-league");
const leagueDateEl = document.getElementById("league-date");
const leagueScoringEl = document.getElementById("league-scoring");
const fantasyResultsEl = document.getElementById("fantasy-results");
const fantasyWeekHeader = document.getElementById("fantasy-week-header");
const weekSelect = document.getElementById("week-select");
const weekPrevBtn = document.getElementById("week-prev");
const weekNextBtn = document.getElementById("week-next");
const fantasyStandingsEl = document.getElementById("fantasy-standings");
const autoplayBtn = document.getElementById("autoplay-league");
const rosterPanel = document.getElementById("roster-panel");
const rosterTeamSelect = document.getElementById("roster-team-select");
const rosterTeamView = document.getElementById("roster-team-view");
const scoringSelect = document.getElementById("scoring-select");
const weightsEditor = document.getElementById("weights-editor");
const scoringForm = document.getElementById("scoring-form");
const saveProfileBtn = document.getElementById("save-profile");
const leagueNameInput = document.getElementById("league-name");
const deleteProfileBtn = document.getElementById("delete-profile");
const teamCountInput = document.getElementById("team-count");
const rosterSizeInput = document.getElementById("roster-size");
const teamNameInput = document.getElementById("team-name");
const suggestTeamNameBtn = document.getElementById("suggest-team-name");
const createLeagueBtn = document.getElementById("create-league");
const setupPanel = document.getElementById("setup-panel");
const leaguePanels = document.getElementById("league-panels");
const leagueListEl = document.getElementById("league-list");
const deleteAllLeaguesBtn = document.getElementById("delete-all-leagues");
const navMenuBtn = document.getElementById("nav-menu");
const toast = document.getElementById("toast");
const playerModal = document.getElementById("player-modal");
const playerModalBody = document.getElementById("player-modal-body");
const playerModalClose = playerModal ? playerModal.querySelector(".player-modal__close") : null;
// Players panel controls
const playersPanel = document.getElementById("players-panel");
const playersListEl = document.getElementById("players-list");
const playersSearchInput = document.getElementById("players-search");
const playersViewSelect = document.getElementById("players-view");
const playersFilterSelect = document.getElementById("players-filter");
const rosterStatusEl = document.getElementById("roster-status");
const draftPanel = document.getElementById("draft-panel");
const draftStatusEl = document.getElementById("draft-status");
const draftRosterList = document.getElementById("draft-roster-list");
const draftPlayerListEl = document.getElementById("draft-player-list");
const draftSearchInput = document.getElementById("draft-search");
const draftLoadMoreBtn = document.getElementById("draft-load-more");
const draftAutoPickBtn = document.getElementById("draft-autopick");
const draftAutoRestBtn = document.getElementById("draft-autopick-rest");
const draftCompleteBtn = document.getElementById("draft-complete");
const draftViewSelect = document.getElementById("draft-view");
const scoreboardPanel = document.getElementById("scoreboard-panel");
const fantasyPanel = document.getElementById("fantasy-panel");
let scoringProfiles = {};
let availableStats = [];
let activeProfileKey = "";
let currentScoreboardDate = "";
let activeGameId = null;
let leagueInitialized = false;
let currentLeagueId = null;
let leaguesCache = [];
let lastFocusedElement = null;
let currentLeagueState = null;
let weekOverviewData = { weeks: [], standings: [], current_week_index: null };
let activeWeekIndex = null;
let lastSuggestedWeekIndex = null;
let playersSortKey = "fantasy";
let playersSortDir = "desc";
let playersSearchTerm = "";
let playersViewMode = "totals";
let playersFilter = "all";
const PLAYER_PAGE_SIZES = [10, 25, 50, 100];
let playersPageSize = PLAYER_PAGE_SIZES[1];
let playersPage = 1;
let playersTotal = 0;
let rosterSelectedTeam = null;
let draftViewMode = draftViewSelect && draftViewSelect.value === "totals" ? "totals" : "averages";
let draftSummaryState = null;
let draftPlayersState = [];
let draftPlayersTotal = 0;
let draftOffset = 0;
let draftSearchTerm = "";
let draftIsActive = false;
let draftLoading = false;
const DRAFT_PAGE_SIZE = 25;

let draftPanelRemoved = false;
function destroyDraftPanel() {
    try {
        if (!draftPanelRemoved && draftPanel && draftPanel.parentElement) {
            draftPanel.parentElement.removeChild(draftPanel);
            draftPanelRemoved = true;
        }
    } catch (_) {
        // no-op
    }
}

async function refreshLeagueStateAfterRosterChange() {
    if (!currentLeagueId) {
        return;
    }
    try {
        await loadLeagueState(currentLeagueId, { suppressToast: true, maintainWeekSelection: true });
        await loadPlayersPanel({ silent: true });
        await loadRosterDaily({ silent: true });
        updateRosterStatus();
    } catch (error) {
        console.error("Unable to refresh league after roster change", error);
    }
}

function ensureDraftCompleteForTransactions() {
    if (currentLeagueState && currentLeagueState.draft_state && currentLeagueState.draft_state.status !== "completed") {
        showToast("Finish the draft before managing your roster.", "error");
        return false;
    }
    return true;
}

async function addPlayerToRoster(playerId) {
    if (!currentLeagueId) {
        throw new Error("No active league");
    }
    if (!ensureDraftCompleteForTransactions()) {
        const err = new Error("draft_incomplete");
        err.silent = true;
        throw err;
    }
    await fetchJSON(`/leagues/${currentLeagueId}/roster/add`, {
        method: "POST",
        body: JSON.stringify({ player_id: playerId }),
    });
    showToast("Player added to your team.", "success");
    await refreshLeagueStateAfterRosterChange();
}

async function dropPlayerFromRoster(playerId) {
    if (!currentLeagueId) {
        throw new Error("No active league");
    }
    if (!ensureDraftCompleteForTransactions()) {
        const err = new Error("draft_incomplete");
        err.silent = true;
        throw err;
    }
    await fetchJSON(`/leagues/${currentLeagueId}/roster/drop`, {
        method: "POST",
        body: JSON.stringify({ player_id: playerId }),
    });
    showToast("Player dropped from your team.", "success");
    await refreshLeagueStateAfterRosterChange();
}
function getUserRosterInfo() {
    const state = currentLeagueState || {};
    const teamName = state.user_team_name || null;
    const rosterSize = Number(state.roster_size || 0);
    const current = teamName && state.rosters && state.rosters[teamName] ? state.rosters[teamName].length : 0;
    const full = rosterSize > 0 && current >= rosterSize;
    return { teamName, current, size: rosterSize, full };
}
function updateRosterStatus() {
    if (!rosterStatusEl) return;
    const info = getUserRosterInfo();
    if (!info.teamName) {
        rosterStatusEl.textContent = "";
        return;
    }
    rosterStatusEl.textContent = `Roster: ${info.current}/${info.size}`;
}
const STAT_ORDER = [
    { key: "PTS", label: "PTS" },
    { key: "OREB", label: "OREB" },
    { key: "DREB", label: "DREB" },
    { key: "TREB", label: "TREB" },
    { key: "AST", label: "AST" },
    { key: "STL", label: "STL" },
    { key: "BLK", label: "BLK" },
    { key: "3PM", label: "3PM" },
    { key: "3PA", label: "3PA" },
    { key: "MPG", label: "MPG" },
    { key: "FGM", label: "FGM" },
    { key: "FGA", label: "FGA" },
    { key: "FG_MISS", label: "FG MISS" },
    { key: "FTM", label: "FTM" },
    { key: "FTA", label: "FTA" },
    { key: "FT_MISS", label: "FT MISS" },
    { key: "TO", label: "TO" },
    { key: "DD", label: "DD" },
    { key: "TD", label: "TD" },
    { key: "PF", label: "PF" },
];
const STAT_LABELS = Object.fromEntries(STAT_ORDER.map((item) => [item.key, item.label]));
const PLAYER_MODAL_SUMMARY_HEADERS = [
    { key: "label", label: "Split" },
    { key: "matchup", label: "Matchup" },
    { key: "fantasy", label: "Fan Pts" },
    { key: "MIN", label: "MIN" },
    { key: "PTS", label: "PTS" },
    { key: "REB", label: "REB" },
    { key: "AST", label: "AST" },
    { key: "STL", label: "STL" },
    { key: "BLK", label: "BLK" },
    { key: "FG", label: "FG" },
    { key: "FG_PCT", label: "FG%" },
    { key: "3PT", label: "3PT" },
    { key: "3PT_PCT", label: "3PT%" },
    { key: "FT", label: "FT" },
    { key: "FT_PCT", label: "FT%" },
    { key: "TOV", label: "TO" },
    { key: "PF", label: "PF" },
];
const PLAYER_MODAL_LOG_HEADERS = [
    { key: "date", label: "Date" },
    { key: "matchup", label: "Opponent" },
    { key: "result", label: "Time / Result" },
    { key: "fantasy", label: "Fan Pts" },
    { key: "MIN", label: "MIN" },
    { key: "PTS", label: "PTS" },
    { key: "REB", label: "REB" },
    { key: "AST", label: "AST" },
    { key: "STL", label: "STL" },
    { key: "BLK", label: "BLK" },
    { key: "FG", label: "FG" },
    { key: "FG_PCT", label: "FG%" },
    { key: "3PT", label: "3PT" },
    { key: "3PT_PCT", label: "3PT%" },
    { key: "FT", label: "FT" },
    { key: "FT_PCT", label: "FT%" },
    { key: "TOV", label: "TO" },
    { key: "PF", label: "PF" },
];
const SHOT_COLUMNS = {
    FG: { made: "FGM", attempts: "FGA", percent: "FG_PCT" },
    "3PT": { made: "FG3M", attempts: "FG3A", percent: "FG3_PCT" },
    FT: { made: "FTM", attempts: "FTA", percent: "FT_PCT" },
};
function escapeHtml(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
async function fetchJSON(url, options = {}) {
    const response = await fetch(url, {
        headers: {
            "Content-Type": "application/json",
        },
        ...options,
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.detail || response.statusText);
    }
    if (response.status === 204) {
        return {};
    }
    const text = await response.text();
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        console.warn("Non-JSON response received from", url);
        return {};
    }
}
function showToast(message, type = "success") {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    setTimeout(() => toast.classList.add("hidden"), 4000);
    requestAnimationFrame(() => toast.classList.remove("hidden"));
}
function parseIsoDate(value) {
    if (!value) {
        return null;
    }
    const parts = String(value).split("-");
    if (parts.length !== 3) {
        return null;
    }
    const [year, month, day] = parts.map((part) => Number.parseInt(part, 10));
    if ([year, month, day].some((num) => Number.isNaN(num))) {
        return null;
    }
    return new Date(Date.UTC(year, month - 1, day));
}
function formatDisplayDate(value, options = {}) {
    const dateObj = value instanceof Date ? value : parseIsoDate(value);
    if (!dateObj || Number.isNaN(dateObj.getTime())) {
        return "";
    }
    const formatter = new Intl.DateTimeFormat(undefined, {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
        ...options,
    });
    return formatter.format(dateObj);
}
function formatNumber(value, { decimals = 1, allowZero = true } = {}) {
    if (value === null || value === undefined) {
        return "–";
    }
    const num = Number(value);
    if (Number.isNaN(num)) {
        return "–";
    }
    if (!allowZero && Math.abs(num) < 0.0001) {
        return "–";
    }
    const fixed = num.toFixed(decimals);
    return decimals ? fixed.replace(/\.0+$/, "") : fixed;
}
function formatFantasy(value) {
    if (value === null || value === undefined) {
        return "0.00";
    }
    const num = Number(value);
    if (Number.isNaN(num)) {
        return "0.00";
    }
    return num.toFixed(2);
}
function formatShotDisplay(stats, key, hasData) {
    const config = SHOT_COLUMNS[key];
    if (!config || !stats || !hasData) {
        return { line: "–", percent: "–" };
    }
    const made = Number(stats[config.made] ?? 0);
    const attempts = Number(stats[config.attempts] ?? 0);
    if (!Number.isFinite(made) || !Number.isFinite(attempts)) {
        return { line: "–", percent: "–" };
    }
    const madeText = formatNumber(made, { decimals: 1 }).replace(/\.0$/, "");
    const attemptsText = formatNumber(attempts, { decimals: 1 }).replace(/\.0$/, "");
    const line = `${madeText}-${attemptsText}`;
    if (attempts === 0) {
        return { line, percent: "—" };
    }
    const pctValue = Number(stats[config.percent]);
    if (!Number.isFinite(pctValue)) {
        return { line, percent: "—" };
    }
    const pctText = pctValue.toFixed(1).replace(/\.0+$/, "");
    return { line, percent: `${pctText}%` };
}
function buildSummaryRows(summary) {
    return summary
        .map((row) => {
            const stats = row.stats || {};
            const hasGames = (row.games_played || 0) > 0;
            const metaParts = [];
            if (row.result) {
                metaParts.push(row.result);
            } else if (row.time) {
                metaParts.push(row.time);
            }
            const metaText = metaParts.map(escapeHtml).join(" · ");
            const matchup = row.matchup ? escapeHtml(row.matchup) : "—";
            const matchupCell = `
                <div class="player-card__matchup-cell">
                    <span>${matchup}</span>
                    ${metaText ? `<span class="player-card__matchup-meta">${escapeHtml(metaText)}</span>` : ""}
                </div>
            `;
            const fg = formatShotDisplay(stats, "FG", hasGames);
            const three = formatShotDisplay(stats, "3PT", hasGames);
            const ft = formatShotDisplay(stats, "FT", hasGames);
            const cells = [
                `<div class="player-card__matchup-label">${escapeHtml(row.label || "")}</div>`,
                matchupCell,
                formatFantasy(row.fantasy_points_avg),
                formatNumber(stats.MIN, { decimals: 1, allowZero: hasGames }),
                formatNumber(stats.PTS, { decimals: 1, allowZero: hasGames }),
                formatNumber(stats.REB, { decimals: 1, allowZero: hasGames }),
                formatNumber(stats.AST, { decimals: 1, allowZero: hasGames }),
                formatNumber(stats.STL, { decimals: 1, allowZero: hasGames }),
                formatNumber(stats.BLK, { decimals: 1, allowZero: hasGames }),
                fg.line,
                fg.percent,
                three.line,
                three.percent,
                ft.line,
                ft.percent,
                formatNumber(stats.TOV ?? stats.TO, { decimals: 1, allowZero: hasGames }),
                formatNumber(stats.PF, { decimals: 1, allowZero: hasGames }),
            ];
            const rowClass = hasGames ? "" : ' class="no-games"';
            return `<tr${rowClass}>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
        })
        .join("");
}
function buildGameLogRows(entries) {
    if (!entries || !entries.length) {
        return "";
    }
    return entries
        .map((entry) => {
            const stats = entry.stats || {};
            const played = Number(stats.MIN ?? 0) > 0;
            const opp = entry.matchup ? escapeHtml(entry.matchup) : "—";
            const result = entry.result
                ? escapeHtml(entry.result)
                : entry.status
                    ? escapeHtml(entry.status)
                    : entry.time
                        ? escapeHtml(entry.time)
                        : "—";
            const fg = formatShotDisplay(stats, "FG", played);
            const three = formatShotDisplay(stats, "3PT", played);
            const ft = formatShotDisplay(stats, "FT", played);
            const cells = [
                formatDisplayDate(entry.date) || "—",
                opp,
                result,
                formatFantasy(entry.fantasy_points),
                formatNumber(stats.MIN, { decimals: 1, allowZero: played }),
                formatNumber(stats.PTS, { decimals: 1, allowZero: played }),
                formatNumber(stats.REB, { decimals: 1, allowZero: played }),
                formatNumber(stats.AST, { decimals: 1, allowZero: played }),
                formatNumber(stats.STL, { decimals: 1, allowZero: played }),
                formatNumber(stats.BLK, { decimals: 1, allowZero: played }),
                fg.line,
                fg.percent,
                three.line,
                three.percent,
                ft.line,
                ft.percent,
                formatNumber(stats.TOV ?? stats.TO, { decimals: 1, allowZero: played }),
                formatNumber(stats.PF, { decimals: 1, allowZero: played }),
            ];
            const rowClass = played ? "" : ' class="dnp"';
            return `<tr${rowClass}>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
        })
        .join("");
}
function renderPlayerProfile(profile) {
    if (!profile || !profile.player) {
        return '<p class="player-card__empty">No player data available.</p>';
    }
    const player = profile.player;
    const summaryRows = profile.summary && profile.summary.length ? buildSummaryRows(profile.summary) : "";
    const gameLogRows = buildGameLogRows(profile.game_log || []);
    const throughDate = profile.target_date ? `Through ${escapeHtml(formatDisplayDate(profile.target_date))}` : "";
    const fantasyTeam = player.fantasy_team ? escapeHtml(player.fantasy_team) : "Free Agent";
    const positions = player.positions && player.positions.length ? escapeHtml(player.positions.join(", ")) : "—";
    const teamLine = player.team_name
        ? `${escapeHtml(player.team_name)}${player.team_abbreviation ? ` (${escapeHtml(player.team_abbreviation)})` : ""}`
        : escapeHtml(player.team_abbreviation || "");
    const scoringLine = player.scoring_profile ? `Scoring preset: ${escapeHtml(player.scoring_profile)}` : "";
    const fantasyAverage =
        typeof player.season_fantasy_avg === "number" && Number.isFinite(player.season_fantasy_avg)
            ? `Season avg: ${player.season_fantasy_avg.toFixed(1)} fpts`
            : null;
    const initials = player.name
        ? player.name
              .split(/\s+/)
              .filter(Boolean)
              .map((part) => part[0])
              .slice(0, 2)
              .join("")
        : "?";
    const avatar = player.image_url
        ? `<img src="${escapeHtml(player.image_url)}" alt="${escapeHtml(player.name)} headshot" />`
        : `<div class="player-card__avatar-fallback">${escapeHtml(initials)}</div>`;
    const metaLines = [
        `${positions} &ndash; ${teamLine || "—"}`,
        `Team: ${fantasyTeam}`,
    ];
    if (scoringLine) {
        metaLines.push(scoringLine);
    }
    if (fantasyAverage) {
        metaLines.push(escapeHtml(fantasyAverage));
    }
    const rosterInfo = getUserRosterInfo();
    const actions = [];
    if (!player.fantasy_team) {
        actions.push({ key: "add", label: "Add", disabled: rosterInfo.full, title: rosterInfo.full ? "Roster full" : null });
    } else if (player.user_team && player.fantasy_team === player.user_team) {
        actions.push({ key: "drop", label: "Drop" });
        actions.push({ key: "trade", label: "Trade" });
    } else {
        actions.push({ key: "trade", label: "Trade" });
    }
    if (!actions.length) {
        actions.push({ key: "watch", label: "Watch" });
    }
    const actionsHtml = actions
        .map((action) => {
            const disabledAttr = action.disabled ? " disabled" : "";
            const titleAttr = action.title ? ` title="${escapeHtml(action.title)}"` : "";
            return `<button type="button" class="player-card__action" data-player-action="${action.key}" data-player-id="${player.id}"${disabledAttr}${titleAttr}>${escapeHtml(action.label)}</button>`;
        })
        .join("");
    const summaryTable = summaryRows
        ? `
            <div class="player-card__table-wrapper">
                <table class="player-card__summary">
                    <thead>
                        <tr>${PLAYER_MODAL_SUMMARY_HEADERS.map((header) => `<th>${escapeHtml(header.label)}</th>`).join("")}</tr>
                    </thead>
                    <tbody>${summaryRows}</tbody>
                </table>
            </div>
        `
        : '<p class="player-card__empty">No summary stats yet.</p>';
    const gameLogTable = gameLogRows
        ? `
            <div class="player-card__log-wrapper">
                <table class="player-card__log">
                    <thead>
                        <tr>${PLAYER_MODAL_LOG_HEADERS.map((header) => `<th>${escapeHtml(header.label)}</th>`).join("")}</tr>
                    </thead>
                    <tbody>${gameLogRows}</tbody>
                </table>
            </div>
        `
        : '<p class="player-card__empty">No game log entries before this date.</p>';
    const throughLabel = throughDate ? `<span class="player-card__through">${escapeHtml(throughDate)}</span>` : "";
    return `
        <article class="player-card" data-player-id="${player.id}">
            <header class="player-card__header">
                <div class="player-card__avatar">${avatar}</div>
                <div class="player-card__details">
                    <h2 id="player-modal-title">${escapeHtml(player.name || "Player")}</h2>
                    <div class="player-card__meta-list">
                        ${metaLines.map((line) => `<span class="player-card__meta-line">${line}</span>`).join("")}
                    </div>
                </div>
            </header>
            <div class="player-card__body">
                <nav class="player-card__tabs" role="tablist" aria-label="Player detail tabs">
                    <button type="button" class="player-card__tab active" role="tab" id="player-tab-stats" data-tab="stats" aria-controls="player-panel-stats" aria-selected="true">
                        Stats
                    </button>
                    <button type="button" class="player-card__tab" role="tab" id="player-tab-log" data-tab="log" aria-controls="player-panel-log" aria-selected="false">
                        Game Log
                    </button>
                </nav>
                <div class="player-card__panels">
                    <section class="player-card__panel player-card__section is-active" role="tabpanel" id="player-panel-stats" data-panel="stats" aria-labelledby="player-tab-stats" aria-hidden="false">
                        <h3>Stats</h3>
                        ${summaryTable}
                    </section>
                    <section class="player-card__panel player-card__section" role="tabpanel" id="player-panel-log" data-panel="log" aria-labelledby="player-tab-log" aria-hidden="true" hidden>
                        <div class="player-card__section-header">
                            <h3>Game Log</h3>
                            ${throughLabel}
                        </div>
                        ${gameLogTable}
                    </section>
                </div>
            </div>
            <footer class="player-card__actions">
                ${actionsHtml}
            </footer>
        </article>
    `;
}
async function loadPlayerModalContent(
    playerId,
    { leagueId = currentLeagueId, date = null } = {},
    { suppressToast = false } = {},
) {
    if (!playerModalBody) {
        return null;
    }
    const params = new URLSearchParams();
    if (leagueId) {
        params.set("league_id", leagueId);
    }
    if (date) {
        params.set("date", date);
    }
    const query = params.toString();
    try {
        const profile = await fetchJSON(`/players/${playerId}/profile${query ? `?${query}` : ""}`);
        playerModalBody.innerHTML = renderPlayerProfile(profile);
        initPlayerCardTabs();
        return profile;
    } catch (error) {
        const message = error.message || "Unable to load player.";
        playerModalBody.innerHTML = `<p class="player-card__empty error">${escapeHtml(message)}</p>`;
        if (!suppressToast) {
            showToast(message, "error");
        }
        return null;
    }
}
async function openPlayerModal(playerId, { leagueId = currentLeagueId, date = null } = {}) {
    if (!playerModal || !playerModalBody || !playerId) {
        return;
    }
    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("modal-open");
    playerModal.classList.remove("hidden");
    playerModal.setAttribute("aria-hidden", "false");
    playerModal.dataset.playerId = String(playerId);
    playerModal.dataset.leagueId = leagueId || "";
    playerModal.dataset.playerDate = date || "";
    playerModalBody.innerHTML = '<div class="player-card__loading">Loading player…</div>';
    await loadPlayerModalContent(playerId, { leagueId, date });
    (playerModalClose || playerModal.querySelector(".player-modal__close"))?.focus();
}
function closePlayerModal() {
    if (!playerModal || !playerModalBody) {
        return;
    }
    playerModal.classList.add("hidden");
    playerModal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    playerModalBody.innerHTML = "";
    if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        lastFocusedElement.focus();
    }
    lastFocusedElement = null;
}
function renderScoreboard(data) {
    const previousDate = currentScoreboardDate;
    const previousActive = previousDate === data.date ? activeGameId : null;
    scoreboardList.innerHTML = "";
    currentScoreboardDate = data.date;
    activeGameId = null;
    if (!data.games.length) {
        const li = document.createElement("li");
        li.className = "score-card disabled";
        li.innerHTML = `
            <div class="teams">
                <div class="team-row">
                    <span>No simulated games yet.</span>
                </div>
            </div>
        `;
        scoreboardList.appendChild(li);
        return;
    }
    let restoreTarget = null;
    data.games.forEach((game) => {
        const card = document.createElement("li");
        card.className = "score-card";
        card.dataset.gameId = game.game_id;
        card.dataset.date = data.date;
        const summary = document.createElement("div");
        summary.className = "score-summary";
        const isSimulated = game.simulated === undefined ? true : Boolean(game.simulated);
        if (!isSimulated) {
            card.classList.add("disabled");
        }
        const awayScore = isSimulated ? game.away_score : "--";
        const homeScore = isSimulated ? game.home_score : "--";
        const statusText = game.status || (isSimulated ? "Final" : "Not played yet");
        const rawTime = (game.time || "").trim();
        const statusLower = statusText.toLowerCase();
        const showTime = rawTime && rawTime.toLowerCase() !== statusLower;
        const timeRow = showTime ? `<div>${escapeHtml(rawTime)}</div>` : "";
        const periodLabel = game.period_display || "";
        const periodHtml = (() => {
            if (periodLabel) {
                return `Period: ${escapeHtml(periodLabel)}`;
            }
            if (statusLower.includes("final") || statusLower.includes("not played")) {
                return "";
            }
            if (game.period) {
                return `Period: ${escapeHtml(`Q${game.period}`)}`;
            }
            return "";
        })();
        const periodRow = periodHtml ? `<div>${periodHtml}</div>` : "";
        summary.innerHTML = `
            <div class="teams">
                <div class="team-row">
                    <span>${game.away_team}</span>
                    <span>${awayScore}</span>
                </div>
                <div class="team-row">
                    <span>${game.home_team}</span>
                    <span>${homeScore}</span>
                </div>
            </div>
            <div class="meta">
                <div class="${statusText.toLowerCase().includes("final") ? "status-final" : "status-upcoming"}">${escapeHtml(statusText)}</div>
                ${timeRow}
                ${periodRow}
            </div>
        `;
        summary.setAttribute("role", "button");
        summary.setAttribute("tabindex", "0");
        const detail = document.createElement("div");
        detail.className = "score-detail";
        detail.innerHTML = isSimulated
            ? "<p>Click to view the full box score.</p>"
            : "<p>Simulate this day to unlock the box score.</p>";
        card.append(summary, detail);
        scoreboardList.appendChild(card);
        if (isSimulated) {
            const handler = () => loadBoxScore(data.date, game.game_id, card, detail);
            summary.addEventListener("click", handler);
            summary.addEventListener("keydown", (evt) => {
                if (evt.key === "Enter" || evt.key === " ") {
                    evt.preventDefault();
                    handler();
                }
            });
            if (previousActive === game.game_id) {
                restoreTarget = { card, detail, gameId: game.game_id };
            }
        }
    });
    if (restoreTarget) {
        loadBoxScore(data.date, restoreTarget.gameId, restoreTarget.card, restoreTarget.detail);
    }
}
function renderBoxscore(card, detail, boxscore) {
    activeGameId = boxscore.game_id;
    scoreboardList.querySelectorAll(".score-card").forEach((c) => {
        c.classList.toggle("active", c === card);
        const detailEl = c.querySelector(".score-detail");
        if (c !== card && detailEl) {
            detailEl.innerHTML = "";
        }
    });
    const scoreboard = boxscore.scoreboard;
    const home = boxscore.home_team;
    const away = boxscore.away_team;
    const renderTeamTable = (team) => {
        const fmt = (value, decimals = 0) => {
            if (value === null || value === undefined) {
                return "";
            }
            const num = Number(value);
            if (!Number.isFinite(num)) {
                return escapeHtml(value);
            }
            if (decimals) {
                return num.toFixed(decimals).replace(/\.0$/, "");
            }
            return num;
        };
        const gameDate = boxscore.date || currentScoreboardDate || card.dataset.date || "";
        const statCell = (value) => {
            const content = value === null || value === undefined ? "" : value;
            return `<span class="stat-value">${content}</span>`;
        };
        const rows = (team.players || [])
            .map((player) => {
                const name = escapeHtml(player.player_name || "");
                const playerId = Number(player.player_id);
                const playerButton =
                    Number.isFinite(playerId) && playerId
                        ? `<button type="button" class="player-link" data-player-id="${playerId}" data-player-name="${name}" data-game-date="${escapeHtml(gameDate)}" data-source="boxscore">${name}</button>`
                        : name;
                const rebounds =
                    player.REB !== undefined ? fmt(player.REB) : fmt((player.OREB || 0) + (player.DREB || 0));
                return `
                    <tr>
                        <td>${playerButton}</td>
                        <td>${statCell(fmt(player.MINUTES, 1))}</td>
                        <td>${statCell(fmt(player.PTS))}</td>
                        <td>${statCell(rebounds)}</td>
                        <td>${statCell(fmt(player.AST))}</td>
                        <td>${statCell(fmt(player.STL))}</td>
                        <td>${statCell(fmt(player.BLK))}</td>
                        <td>${statCell(`${fmt(player.FGM)}-${fmt(player.FGA)}`)}</td>
                        <td>${statCell(`${fmt(player.FG3M)}-${fmt(player.FG3A)}`)}</td>
                        <td>${statCell(`${fmt(player.FTM)}-${fmt(player.FTA)}`)}</td>
                        <td>${statCell(fmt(player.TOV))}</td>
                    </tr>
                `;
            })
            .join("");
        const totals = team.totals;
        return `
            <div class="boxscore-team">
                <h3>${escapeHtml(team.name || "")} (${escapeHtml(team.abbreviation || "")})</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Player</th>
                            <th>MIN</th>
                            <th>PTS</th>
                            <th>REB</th>
                            <th>AST</th>
                            <th>STL</th>
                            <th>BLK</th>
                            <th>FG</th>
                            <th>3PT</th>
                            <th>FT</th>
                            <th>TO</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                    <tfoot>
                        <tr>
                            <th>Total</th>
                            <th>${statCell(fmt(totals.MINUTES, 1))}</th>
                            <th>${statCell(fmt(totals.PTS))}</th>
                            <th>${statCell(totals.REB !== undefined ? fmt(totals.REB) : fmt((totals.OREB || 0) + (totals.DREB || 0)))}</th>
                            <th>${statCell(fmt(totals.AST))}</th>
                            <th>${statCell(fmt(totals.STL))}</th>
                            <th>${statCell(fmt(totals.BLK))}</th>
                            <th>${statCell(`${fmt(totals.FGM)}-${fmt(totals.FGA)}`)}</th>
                            <th>${statCell(`${fmt(totals.FG3M)}-${fmt(totals.FG3A)}`)}</th>
                            <th>${statCell(`${fmt(totals.FTM)}-${fmt(totals.FTA)}`)}</th>
                            <th>${statCell(fmt(totals.TOV))}</th>
                        </tr>
                    </tfoot>
                </table>
            </div>
        `;
    };
    detail.innerHTML = `
        <div class="boxscore-header">
            <div>
                <strong>${escapeHtml(away.name || "")} ${escapeHtml(scoreboard.away_score ?? "")}</strong>
                @
                <strong>${escapeHtml(home.name || "")} ${escapeHtml(scoreboard.home_score ?? "")}</strong>
            </div>
            <span>${escapeHtml(boxscore.date || "")}</span>
        </div>
        <div class="score-detail-inner">
            ${renderTeamTable(away)}
            ${renderTeamTable(home)}
        </div>
    `;
    detail.dataset.boxscoreDate = boxscore.date || currentScoreboardDate || "";
    detail.dataset.leagueId = boxscore.league_id || currentLeagueId || "";
}
async function loadBoxScore(date, gameId, card, detail) {
    if (!date || typeof gameId === "undefined" || gameId === null || !currentLeagueId) {
        return;
    }
    if (currentScoreboardDate === date && activeGameId === Number(gameId)) {
        card.classList.remove("active");
        detail.innerHTML = "<p>Click to view the full box score.</p>";
        activeGameId = null;
        return;
    }
    detail.innerHTML = "<p>Loading box score…</p>";
    try {
        const params = new URLSearchParams({ league_id: currentLeagueId });
        params.set("date", date);
        const data = await fetchJSON(`/games/${gameId}/boxscore?${params.toString()}`);
        renderBoxscore(card, detail, data);
    } catch (error) {
        detail.innerHTML = `<p class="error">${error.message || "Unable to load box score."}</p>`;
        showToast(error.message || "Unable to load box score.", "error");
    }
}
function resetFantasyView(message = "") {
    if (fantasyWeekHeader) {
        fantasyWeekHeader.classList.add("hidden");
    }
    if (weekSelect) {
        weekSelect.innerHTML = "";
    }
    if (weekPrevBtn) {
        weekPrevBtn.disabled = true;
    }
    if (weekNextBtn) {
        weekNextBtn.disabled = true;
    }
    fantasyResultsEl.innerHTML = message ? `<p>${escapeHtml(message)}</p>` : "";
    if (fantasyStandingsEl) {
        fantasyStandingsEl.classList.add("hidden");
        fantasyStandingsEl.innerHTML = "";
    }
}
function updateWeekControls() {
    if (!fantasyWeekHeader || !weekSelect) {
        return;
    }
    const weeks = (weekOverviewData.weeks || []).slice().sort((a, b) => Number(a.index) - Number(b.index));
    if (!weeks.length) {
        resetFantasyView("No matchups scheduled yet.");
        return;
    }
    fantasyWeekHeader.classList.remove("hidden");
    const options = weeks
        .map((week) => {
            const startLabel = formatDisplayDate(week.start, { month: "short", day: "numeric" }) || week.start;
            const endLabel = formatDisplayDate(week.end, { month: "short", day: "numeric" }) || week.end;
            return `<option value="${week.index}">Week ${week.index} · ${startLabel} – ${endLabel}</option>`;
        })
        .join("");
    weekSelect.innerHTML = options;
    const validWeek = weeks.find((week) => Number(week.index) === Number(activeWeekIndex));
    if (!validWeek) {
        activeWeekIndex = Number(weeks[0].index);
    }
    weekSelect.value = String(activeWeekIndex);
    const position = weeks.findIndex((week) => Number(week.index) === Number(activeWeekIndex));
    if (weekPrevBtn) {
        weekPrevBtn.disabled = position <= 0;
    }
    if (weekNextBtn) {
        weekNextBtn.disabled = position === -1 || position >= weeks.length - 1;
    }
}
function renderMatchups() {
    fantasyResultsEl.innerHTML = "";
    const weeks = weekOverviewData.weeks || [];
    if (!weeks.length) {
        fantasyResultsEl.innerHTML = "<p>No matchups scheduled yet.</p>";
        return;
    }
    const targetWeek =
        weeks.find((week) => Number(week.index) === Number(activeWeekIndex)) || weeks[0];
    if (!targetWeek) {
        fantasyResultsEl.innerHTML = "<p>No matchup data available.</p>";
        return;
    }
    const matchups = targetWeek.matchups || [];
    if (!matchups.length) {
        fantasyResultsEl.innerHTML = "<p>No head-to-head matchups scheduled for this week.</p>";
        return;
    }
    matchups.forEach((matchup) => {
        const card = document.createElement("article");
        card.className = "matchup-card";
        card.dataset.weekIndex = targetWeek.index;
        const lastDay = (matchup.days && matchup.days.length && matchup.days[matchup.days.length - 1]) || "";
        if (lastDay) {
            card.dataset.matchupDate = lastDay;
        }
        const summary = document.createElement("div");
        summary.className = "matchup-summary";
        summary.setAttribute("role", "button");
        summary.setAttribute("tabindex", "0");
        const teamsWrapper = document.createElement("div");
        teamsWrapper.className = "matchup-teams";
        const teams = matchup.teams || [];
        teams.forEach((team) => {
            const row = document.createElement("div");
            row.className = "matchup-team";
            if (matchup.leader && team.name === matchup.leader) {
                row.classList.add("is-leading");
            }
            const nameEl = document.createElement("span");
            nameEl.textContent = team.name || "TBD";
            const totalEl = document.createElement("span");
            totalEl.className = "matchup-total";
            totalEl.textContent = formatFantasy(team.total || 0);
            row.append(nameEl, totalEl);
            teamsWrapper.appendChild(row);
        });
        const statusEl = document.createElement("div");
        statusEl.className = "matchup-status";
        const statusLabel = {
            completed: "Completed",
            in_progress: "In progress",
            not_started: "Not started",
        }[matchup.status] || "Not started";
        if (matchup.days && matchup.days.length) {
            const count = matchup.days.length;
            statusEl.textContent = `${statusLabel} · ${count} day${count === 1 ? "" : "s"} played`;
        } else {
            statusEl.textContent = statusLabel;
        }
        summary.append(teamsWrapper, statusEl);
        const detail = document.createElement("div");
        detail.className = "matchup-detail";
        if (teams.length) {
            teams.forEach((team) => {
                const teamSection = document.createElement("section");
                teamSection.className = "matchup-team-detail";
                const heading = document.createElement("h4");
                heading.innerHTML = `
                    <span>${escapeHtml(team.name || "Team")}</span>
                    <span>${formatFantasy(team.total || 0)} pts</span>
                `;
                teamSection.appendChild(heading);
                const players = (team.players || []).slice();
                if (!players.length) {
                    const empty = document.createElement("p");
                    empty.textContent = "No player stats yet for this matchup.";
                    teamSection.appendChild(empty);
                } else {
                    const table = document.createElement("table");
                    const rows = players
                        .map((player) => {
                            const name = escapeHtml(player.player_name || "");
                            const playerId = Number(player.player_id);
                            const playerButton =
                                Number.isFinite(playerId) && playerId
                                    ? `<button type="button" class="player-link" data-player-id="${playerId}" data-player-name="${name}" data-result-date="${escapeHtml(lastDay)}" data-week-index="${escapeHtml(String(targetWeek.index))}" data-source="matchup">${name}</button>`
                                    : name;
                            const teamLabel = escapeHtml(player.team || "");
                            const fantasy = formatFantasy(player.fantasy_points || 0);
                            const gamesPlayed = player.games_played ? Number(player.games_played) : 0;
                            return `
                                <tr>
                                    <td>${playerButton}</td>
                                    <td>${teamLabel}</td>
                                    <td>${gamesPlayed}</td>
                                    <td>${fantasy}</td>
                                </tr>
                            `;
                        })
                        .join("");
                    table.innerHTML = `
                        <thead>
                            <tr>
                                <th>Player</th>
                                <th>Team</th>
                                <th>GP</th>
                                <th>Fan Pts</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    `;
                    teamSection.appendChild(table);
                }
                detail.appendChild(teamSection);
            });
        }
        const toggle = () => {
            const willActivate = !card.classList.contains("active");
            document.querySelectorAll(".matchup-card.active").forEach((openCard) => {
                if (openCard !== card) {
                    openCard.classList.remove("active");
                }
            });
            card.classList.toggle("active");
            if (willActivate) {
                card.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }
        };
        summary.addEventListener("click", toggle);
        summary.addEventListener("keydown", (evt) => {
            if (evt.key === "Enter" || evt.key === " ") {
                evt.preventDefault();
                toggle();
            }
        });
        card.append(summary, detail);
        fantasyResultsEl.appendChild(card);
    });
}
function renderStandings() {
    if (!fantasyStandingsEl) {
        return;
    }
    fantasyStandingsEl.innerHTML = "";
    const standings = weekOverviewData.standings || [];
    if (!standings.length) {
        fantasyStandingsEl.classList.add("hidden");
        return;
    }
    fantasyStandingsEl.classList.remove("hidden");
    const heading = document.createElement("h3");
    heading.textContent = "Standings";
    fantasyStandingsEl.appendChild(heading);
    const table = document.createElement("table");
    const rows = standings
        .map((entry) => {
            const record = `${entry.wins}-${entry.losses}-${entry.ties}`;
            return `
                <tr>
                    <td>${entry.rank}</td>
                    <td>${escapeHtml(entry.team)}</td>
                    <td>${record}</td>
                    <td>${formatNumber(entry.win_pct, { decimals: 3 })}</td>
                    <td class="points">${formatNumber(entry.points_for, { decimals: 1 })}</td>
                    <td class="points">${formatNumber(entry.points_against, { decimals: 1 })}</td>
                    <td class="points">${formatNumber(entry.point_diff, { decimals: 1 })}</td>
                </tr>
            `;
        })
        .join("");
    table.innerHTML = `
        <thead>
            <tr>
                <th>Rank</th>
                <th>Team</th>
                <th>Record</th>
                <th>Win%</th>
                <th class="points">PF</th>
                <th class="points">PA</th>
                <th class="points">Diff</th>
            </tr>
        </thead>
        <tbody>${rows}</tbody>
    `;
    fantasyStandingsEl.appendChild(table);
}
function setActiveWeek(nextIndex) {
    if (!Number.isFinite(Number(nextIndex))) {
        return;
    }
    activeWeekIndex = Number(nextIndex);
    updateWeekControls();
    renderMatchups();
}
async function loadLeagueWeeks(leagueId, options = {}) {
    if (!leagueId) {
        resetFantasyView("Create a league to begin your season replay.");
        return;
    }
    const maintainSelection = options.maintainSelection ?? true;
    try {
        const data = await fetchJSON(`/leagues/${leagueId}/weeks`);
        weekOverviewData = data;
        const recommended = Number(data.current_week_index) || (data.weeks && data.weeks.length ? Number(data.weeks[0].index) : null);
        if (!maintainSelection || activeWeekIndex === null) {
            activeWeekIndex = recommended;
        } else if (
            lastSuggestedWeekIndex !== null &&
            activeWeekIndex === lastSuggestedWeekIndex &&
            recommended &&
            recommended !== lastSuggestedWeekIndex
        ) {
            activeWeekIndex = recommended;
        } else if (!data.weeks || !data.weeks.some((week) => Number(week.index) === Number(activeWeekIndex))) {
            activeWeekIndex = recommended;
        }
        lastSuggestedWeekIndex = recommended;
        updateWeekControls();
        renderMatchups();
        renderStandings();
    } catch (error) {
        if (!options.silent) {
            showToast(error.message || "Unable to load weekly matchups.", "error");
        }
        weekOverviewData = { weeks: [], standings: [], current_week_index: null };
        activeWeekIndex = null;
        lastSuggestedWeekIndex = null;
        resetFantasyView(error.message || "Unable to load weekly matchups.");
    }
}
function renderLeagueState(state) {
    currentLeagueState = state || null;
    if (!state) {
        leagueDateEl.textContent = "—";
        leagueScoringEl.textContent = "—";
        weekOverviewData = { weeks: [], standings: [], current_week_index: null };
        activeWeekIndex = null;
        lastSuggestedWeekIndex = null;
        resetFantasyView("Create a league to begin your season replay.");
        simulateBtn.disabled = true;
        simulateBtn.textContent = "Play today's games";
        simulateBtn.dataset.action = "play";
        return;
    }
    const draftActive = Boolean(state.draft_state && state.draft_state.status !== "completed");
    if (draftActive) {
        enterDraftMode(state);
        return;
    }
    exitDraftMode();
    const currentDate = state.current_date;
    const awaiting = Boolean(state.awaiting_simulation && currentDate);
    let dateLabel = "Season complete";
    if (currentDate) {
        const status = awaiting ? " (awaiting simulation)" : " (completed)";
        dateLabel = `${currentDate}${status}`;
        simulateBtn.disabled = false;
        simulateBtn.textContent = awaiting ? "Play today's games" : "Go to next day";
        simulateBtn.dataset.action = awaiting ? "play" : "advance";
    } else {
        const last = state.latest_completed_date ? ` (Last: ${state.latest_completed_date})` : "";
        dateLabel = `Season complete${last}`;
        simulateBtn.disabled = true;
        simulateBtn.textContent = "Season complete";
        simulateBtn.dataset.action = "complete";
    }
    leagueDateEl.textContent = dateLabel;
    leagueScoringEl.textContent = state.scoring_profile;
    if (!currentDate) {
        simulateBtn.disabled = true;
    }
    fantasyResultsEl.innerHTML = "<p>Loading weekly matchups…</p>";
}

function enterDraftMode(state) {
    draftIsActive = true;
    draftViewMode = draftViewSelect && draftViewSelect.value === "totals" ? "totals" : "averages";
    if (draftPanel && !draftPanelRemoved) draftPanel.classList.remove("hidden");
    if (scoreboardPanel) scoreboardPanel.classList.add("hidden");
    if (fantasyPanel) fantasyPanel.classList.add("hidden");
    simulateBtn.classList.add("hidden");
    resetBtn.classList.add("hidden");
    scoreboardDateInput.disabled = true;
    draftSummaryState = null;
    draftPlayersState = [];
    draftPlayersTotal = 0;
    draftOffset = 0;
    if (draftStatusEl) draftStatusEl.textContent = "Loading draft…";
    if (draftRosterList) draftRosterList.innerHTML = "";
    if (draftPlayerListEl) draftPlayerListEl.innerHTML = "";
    if (draftLoadMoreBtn) draftLoadMoreBtn.disabled = true;
    if (draftAutoPickBtn) draftAutoPickBtn.disabled = true;
    if (draftAutoRestBtn) draftAutoRestBtn.disabled = true;
    if (draftCompleteBtn) draftCompleteBtn.disabled = true;
    loadDraftData({ reset: true }).catch((error) => {
        console.error(error);
        showToast(error.message || "Unable to load draft data.", "error");
    });
}

function exitDraftMode() {
    if (!draftIsActive) {
        return;
    }
    draftIsActive = false;
    if (draftPanel && !draftPanelRemoved) draftPanel.classList.add("hidden");
    if (scoreboardPanel) scoreboardPanel.classList.remove("hidden");
    if (fantasyPanel) fantasyPanel.classList.remove("hidden");
    simulateBtn.classList.remove("hidden");
    resetBtn.classList.remove("hidden");
    scoreboardDateInput.disabled = false;
    draftSummaryState = null;
    draftPlayersState = [];
    draftPlayersTotal = 0;
    draftOffset = 0;
    draftSearchTerm = "";
    if (draftSearchInput) {
        draftSearchInput.value = "";
    }
}

async function loadDraftData(options = {}) {
    const reset = options.reset ?? false;
    if (!currentLeagueId) {
        return;
    }
    try {
        await loadDraftSummaryOnly();
        await loadDraftPlayers({ reset });
    } catch (error) {
        console.error(error);
    }
}

async function loadDraftSummaryOnly() {
    if (!currentLeagueId) {
        return;
    }
    try {
        const params = new URLSearchParams({ view: draftViewMode });
        const summary = await fetchJSON(`/leagues/${currentLeagueId}/draft?${params.toString()}`);
        applyDraftSummary(summary);
    } catch (error) {
        draftSummaryState = null;
        if (draftStatusEl) {
            draftStatusEl.textContent = error.message || "Unable to load draft.";
        }
        throw error;
    }
}

function applyDraftSummary(summary) {
    draftSummaryState = summary;
    if (summary?.view) {
        const normalized = summary.view === "totals" ? "totals" : "averages";
        if (draftViewSelect && draftViewSelect.value !== normalized) {
            draftViewSelect.value = normalized;
        }
        draftViewMode = normalized;
    }
    if (!draftStatusEl) {
        return;
    }
    if (!summary) {
        draftStatusEl.textContent = "Draft unavailable.";
        return;
    }
    const rosterSize = Number(summary.roster_size || 0);
    const remaining = Number(summary.remaining_slots || 0);
    const draftedCount = Math.max(0, rosterSize - remaining);
    const teamLabel = summary.user_team ? `${summary.user_team}` : "Your team";
    if (summary.status === "completed") {
        draftStatusEl.textContent = `${teamLabel} draft complete.`;
    } else {
        draftStatusEl.textContent = `${teamLabel}: ${draftedCount}/${rosterSize} players selected (${remaining} remaining).`;
    }
    renderDraftRoster(summary, rosterSize);
    const canDraftMore = remaining > 0 && summary.status !== "completed";
    if (draftAutoPickBtn) draftAutoPickBtn.disabled = !canDraftMore;
    if (draftAutoRestBtn) draftAutoRestBtn.disabled = !canDraftMore;
    if (draftCompleteBtn) draftCompleteBtn.disabled = !summary.can_complete;
    if (summary.status === "completed") {
        // Remove draft UI from the DOM to avoid any lingering state
        destroyDraftPanel();
        exitDraftMode();
        showDashboardView();
    }
}

function renderDraftRoster(summary, rosterSize) {
    if (!draftRosterList) {
        return;
    }
    const picks = Array.isArray(summary?.picks) ? summary.picks : [];
    draftRosterList.innerHTML = "";
    const totalSlots = rosterSize || picks.length;
    for (let index = 0; index < totalSlots; index += 1) {
        const pick = picks[index];
        const li = document.createElement("li");
        if (pick) {
            const name = escapeHtml(pick.player_name || "Player");
            const team = escapeHtml(pick.team || "");
            const fantasy = typeof pick.fantasy_points === "number" ? formatFantasy(pick.fantasy_points) : "";
            const fantasyTag = draftViewMode === "totals" ? " total" : " avg";
            li.innerHTML = `<span>${name}</span><span>${team}${fantasy ? ` · ${fantasy}${fantasyTag}` : ""}</span>`;
        } else {
            li.classList.add("empty-slot");
            li.innerHTML = `<span>Slot ${index + 1}</span><span>Available</span>`;
        }
        draftRosterList.appendChild(li);
    }
}

async function loadDraftPlayers(options = {}) {
    if (!currentLeagueId) {
        return;
    }
    const reset = options.reset ?? false;
    if (draftLoading) {
        return;
    }
    draftLoading = true;
    if (reset) {
        draftOffset = 0;
        draftPlayersState = [];
        draftPlayersTotal = 0;
        if (draftPlayerListEl) {
            draftPlayerListEl.innerHTML = "<p class=\"empty\">Loading players…</p>";
        }
        if (draftLoadMoreBtn) draftLoadMoreBtn.disabled = true;
    }
    try {
        const params = new URLSearchParams({
            limit: String(DRAFT_PAGE_SIZE),
            offset: String(draftOffset),
        });
        if (draftSearchTerm) {
            params.set("search", draftSearchTerm);
        }
        params.set("view", draftViewMode);
        const data = await fetchJSON(`/leagues/${currentLeagueId}/draft/players?${params.toString()}`);
        const responseView = data.view === "totals" ? "totals" : "averages";
        if (draftViewMode !== responseView) {
            draftViewMode = responseView;
            if (draftViewSelect && draftViewSelect.value !== responseView) {
                draftViewSelect.value = responseView;
            }
        }
        const results = Array.isArray(data.results) ? data.results : [];
        if (reset) {
            draftPlayersState = results;
            draftOffset = results.length;
        } else {
            draftPlayersState = draftPlayersState.concat(results);
            draftOffset += results.length;
        }
        draftPlayersTotal = Number(data.count || draftPlayersState.length);
        renderDraftPlayers(draftPlayersState, draftPlayersTotal);
        if (draftLoadMoreBtn) {
            draftLoadMoreBtn.disabled = draftPlayersState.length >= draftPlayersTotal;
        }
    } catch (error) {
        showToast(error.message || "Unable to load draft players.", "error");
    } finally {
        draftLoading = false;
    }
}

function renderDraftPlayers(players, total) {
    if (!draftPlayerListEl) {
        return;
    }
    if (!players.length) {
        draftPlayerListEl.innerHTML = "<p class=\"empty\">No players match your filters.</p>";
        return;
    }
    const remainingSlots = Number(draftSummaryState?.remaining_slots || 0);
    const statDecimals = draftViewMode === "totals" ? 0 : 1;
    const statLabelSuffix = draftViewMode === "totals" ? " (tot)" : " (avg)";
    const fantasyHeader = draftViewMode === "totals" ? "Fan Pts (tot)" : "Fan Pts (avg)";
    const rows = players
        .map((player) => {
            const disabled = Boolean(player.taken) || remainingSlots <= 0;
            const buttonAttr = disabled ? "disabled" : "";
            return `
                <tr>
                    <td>${escapeHtml(player.player_name || "")}</td>
                    <td>${escapeHtml(player.team || "")}</td>
                    <td>${formatFantasy(player.fantasy_points || 0)}</td>
                    <td>${formatNumber(player.pts || 0, { decimals: statDecimals })}</td>
                    <td>${formatNumber(player.reb || 0, { decimals: statDecimals })}</td>
                    <td>${formatNumber(player.ast || 0, { decimals: statDecimals })}</td>
                    <td>${formatNumber(player.stl || 0, { decimals: statDecimals })}</td>
                    <td>${formatNumber(player.blk || 0, { decimals: statDecimals })}</td>
                    <td><button type="button" data-player-id="${player.player_id}" ${buttonAttr}>Add</button></td>
                </tr>
            `;
        })
        .join("");
    draftPlayerListEl.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Player</th>
                    <th>Team</th>
                    <th>${fantasyHeader}</th>
                    <th>PTS${statLabelSuffix}</th>
                    <th>REB${statLabelSuffix}</th>
                    <th>AST${statLabelSuffix}</th>
                    <th>STL${statLabelSuffix}</th>
                    <th>BLK${statLabelSuffix}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
    draftPlayerListEl.querySelectorAll("button[data-player-id]").forEach((button) => {
        button.addEventListener("click", () => {
            const playerId = Number(button.dataset.playerId);
            if (!Number.isFinite(playerId)) {
                return;
            }
            button.disabled = true;
            draftSelectPlayer(playerId).finally(() => {
                button.disabled = false;
            });
        });
    });
    if (draftLoadMoreBtn) {
        draftLoadMoreBtn.disabled = players.length >= total;
    }
}

async function draftSelectPlayer(playerId) {
    if (!currentLeagueId) {
        return;
    }
    try {
        const response = await fetchJSON(`/leagues/${currentLeagueId}/draft/pick?view=${draftViewMode}`, {
            method: "POST",
            body: JSON.stringify({ player_id: playerId }),
        });
        if (response?.draft) {
            applyDraftSummary(response.draft);
        }
        await loadDraftPlayers({ reset: true });
        const draftedName = response?.player?.player_name || "Player";
        showToast(`${draftedName} added to your roster.`, "success");
    } catch (error) {
        showToast(error.message || "Unable to draft player.", "error");
    }
}

async function draftAutopick() {
    if (!currentLeagueId || (draftSummaryState && draftSummaryState.remaining_slots <= 0)) {
        return;
    }
    const original = draftAutoPickBtn ? draftAutoPickBtn.textContent : "";
    if (draftAutoPickBtn) {
        draftAutoPickBtn.disabled = true;
        draftAutoPickBtn.textContent = "Drafting…";
    }
    try {
        const response = await fetchJSON(`/leagues/${currentLeagueId}/draft/autopick?view=${draftViewMode}`, { method: "POST" });
        if (response?.draft) {
            applyDraftSummary(response.draft);
        }
        await loadDraftPlayers({ reset: true });
        const draftedName = response?.player?.player_name || "Player";
        showToast(`${draftedName} drafted automatically.`, "success");
    } catch (error) {
        showToast(error.message || "Unable to autodraft pick.", "error");
    } finally {
        if (draftAutoPickBtn) {
            draftAutoPickBtn.textContent = original || "Autodraft Pick";
            draftAutoPickBtn.disabled = !(draftSummaryState && draftSummaryState.remaining_slots > 0);
        }
    }
}

async function draftAutopickRest() {
    if (!currentLeagueId) {
        return;
    }
    const original = draftAutoRestBtn ? draftAutoRestBtn.textContent : "";
    if (draftAutoRestBtn) {
        draftAutoRestBtn.disabled = true;
        draftAutoRestBtn.textContent = "Drafting…";
    }
    try {
        const response = await fetchJSON(`/leagues/${currentLeagueId}/draft/autopick/rest?view=${draftViewMode}`, { method: "POST" });
        if (response?.draft) {
            applyDraftSummary(response.draft);
        }
        showToast("Draft completed automatically.", "success");
        await loadLeagueState(currentLeagueId, { suppressToast: true });
        // Force-remove draft panel to prevent re-appearing
        destroyDraftPanel();
        exitDraftMode();
        showDashboardView();
    } catch (error) {
        showToast(error.message || "Unable to autodraft the rest.", "error");
    } finally {
        if (draftAutoRestBtn) {
            draftAutoRestBtn.textContent = original || "Autodraft Rest";
            draftAutoRestBtn.disabled = !(draftSummaryState && draftSummaryState.remaining_slots > 0);
        }
    }
}

async function draftComplete() {
    if (!currentLeagueId || !draftSummaryState?.can_complete) {
        return;
    }
    const original = draftCompleteBtn ? draftCompleteBtn.textContent : "";
    if (draftCompleteBtn) {
        draftCompleteBtn.disabled = true;
        draftCompleteBtn.textContent = "Completing…";
    }
    try {
        const response = await fetchJSON(`/leagues/${currentLeagueId}/draft/complete?view=${draftViewMode}`, { method: "POST" });
        if (response?.draft) {
            applyDraftSummary(response.draft);
        }
        showToast("Draft complete. Let's play!", "success");
        await loadLeagueState(currentLeagueId, { suppressToast: true });
        // Ensure the draft panel is removed and main panels restored
        destroyDraftPanel();
        exitDraftMode();
        showDashboardView();
    } catch (error) {
        showToast(error.message || "Unable to finalize draft.", "error");
        if (draftCompleteBtn) {
            draftCompleteBtn.disabled = false;
        }
    } finally {
        if (draftCompleteBtn) {
            draftCompleteBtn.textContent = original || "Finish Draft";
        }
    }
}
function showSetupView() {
    currentLeagueState = null;
    setupPanel.classList.remove("hidden");
    leaguePanels.classList.remove("active");
    renderLeagueList(leaguesCache);
    navMenuBtn.classList.add("hidden");
    navMenuBtn.disabled = true;
    simulateBtn.classList.add("hidden");
    resetBtn.classList.add("hidden");
    scoreboardDateInput.disabled = true;
    scoreboardDateInput.value = "";
    if (!leagueInitialized) {
        scoreboardList.innerHTML = `
            <li class="score-card disabled">
                <div class="teams"><div class="team-row"><span>No simulated games yet.</span></div></div>
            </li>
        `;
        weekOverviewData = { weeks: [], standings: [], current_week_index: null };
        activeWeekIndex = null;
        lastSuggestedWeekIndex = null;
        resetFantasyView("Create a league to begin your season replay.");
        activeGameId = null;
    }
}
function showDashboardView() {
    if (!leagueInitialized || !currentLeagueId) {
        return;
    }
    setupPanel.classList.add("hidden");
    leaguePanels.classList.add("active");
    navMenuBtn.classList.remove("hidden");
    navMenuBtn.disabled = false;
    simulateBtn.classList.remove("hidden");
    resetBtn.classList.remove("hidden");
    scoreboardDateInput.disabled = false;
    const draftActive = Boolean(currentLeagueState?.draft_state && currentLeagueState.draft_state.status !== "completed");
    if (draftActive) {
        scoreboardDateInput.disabled = true;
        return;
    }
    // Load players panel if a league is active and draft completed
    loadPlayersPanel({ silent: true });
}
function renderLeagueList(leagues) {
    leagueListEl.innerHTML = "";
    if (!leagues || !leagues.length) {
        leagueListEl.innerHTML = `<li class="empty">No leagues yet. Create one below.</li>`;
        return;
    }
    leagues.forEach((league) => {
        const li = document.createElement("li");
        const info = document.createElement("div");
        info.className = "league-info";
        const details = [
            `${league.team_count} teams`,
            league.latest_completed_date ? `Last: ${league.latest_completed_date}` : "No games yet",
            league.scoring_profile,
        ].join(" | ");
        info.innerHTML = `<strong>${league.league_name}</strong><span>${details}</span>`;
        const actions = document.createElement("div");
        actions.className = "league-actions";
        const openButton = document.createElement("button");
        openButton.type = "button";
        openButton.textContent = "Play";
        openButton.classList.add("btn-league-play");
        openButton.addEventListener("click", () => enterLeague(league.id));
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.textContent = "Delete";
        deleteButton.classList.add("btn-league-delete");
        deleteButton.addEventListener("click", async () => {
            const confirmed = confirm(`Delete league "${league.league_name}"? This cannot be undone.`);
            if (!confirmed) {
                return;
            }
            const original = deleteButton.textContent;
            deleteButton.disabled = true;
            deleteButton.textContent = "Deleting...";
            try {
                await fetchJSON(`/leagues/${league.id}`, { method: "DELETE" });
                showToast("League deleted.", "success");
                await loadLeaguesList();
            } catch (error) {
                deleteButton.disabled = false;
                deleteButton.textContent = original;
                showToast(error.message || "Unable to delete league.", "error");
            }
        });
        actions.append(openButton, deleteButton);
        li.append(info, actions);
        leagueListEl.appendChild(li);
    });
}
async function loadLeaguesList() {
    try {
        const data = await fetchJSON("/leagues");
        leaguesCache = data.leagues || [];
        // Do not forcibly bounce the user to the setup menu if the
        // active league temporarily disappears from the listing (race conditions
        // while writing files can cause brief gaps). Keep the current view.
        renderLeagueList(leaguesCache);
        if (deleteAllLeaguesBtn) {
            deleteAllLeaguesBtn.disabled = !leaguesCache.length;
        }
    } catch (error) {
        renderLeagueList([]);
        if (deleteAllLeaguesBtn) {
            deleteAllLeaguesBtn.disabled = true;
        }
        showToast(error.message || "Unable to load leagues.", "error");
    }
}
async function enterLeague(leagueId) {
    try {
        currentLeagueId = leagueId;
        await loadLeagueState(leagueId, { suppressToast: false });
        if (!draftIsActive) {
            await loadPlayersPanel({ silent: true });
        }
    } catch (error) {
        console.error(error);
    } finally {
        await loadLeaguesList();
    }
}
function setLeagueUI(hasLeague) {
    leagueInitialized = hasLeague;
    if (hasLeague) {
        showDashboardView();
    } else {
        currentLeagueId = null;
        showSetupView();
    }
}
function populateWeightsEditor(weights, stats = []) {
    weightsEditor.innerHTML = "";
    const statsToRender = stats.length ? stats : Object.keys(weights);
    statsToRender.forEach((stat) => {
        const value = stat in weights ? weights[stat] : 0;
        const label = document.createElement("label");
        label.innerHTML = `
            <span>${STAT_LABELS[stat] || stat}</span>
            <input type="number" step="any" name="weights.${stat}" data-stat="${stat}" value="${value}" />
        `;
        weightsEditor.appendChild(label);
    });
}
async function loadScoringProfiles() {
    const data = await fetchJSON("/settings/scoring");
    scoringProfiles = data.profiles;
    const allKeys = new Set(Object.values(scoringProfiles).flatMap((profile) => Object.keys(profile.weights || {})));
    // ensure we include stat order even if defaults missing yet
    availableStats = STAT_ORDER.map((item) => item.key).filter((key) => allKeys.has(key) || STAT_LABELS[key]);
    const previousKey = activeProfileKey;
    scoringSelect.innerHTML = "";
    let fallbackKey = null;
    Object.entries(data.profiles).forEach(([key, profile]) => {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = profile.name;
        if (!fallbackKey) {
            fallbackKey = key;
        }
        if (previousKey && key === previousKey) {
            option.selected = true;
        }
        scoringSelect.appendChild(option);
    });
    if (!scoringSelect.value) {
        if (previousKey && scoringProfiles[previousKey]) {
            scoringSelect.value = previousKey;
        } else if (data.default && scoringProfiles[data.default]) {
            scoringSelect.value = data.default;
        } else if (fallbackKey) {
            scoringSelect.value = fallbackKey;
        }
    }
    activeProfileKey = scoringSelect.value || previousKey || fallbackKey || "";
    const activeKey = activeProfileKey;
    if (activeKey && scoringProfiles[activeKey]) {
        populateWeightsEditor(scoringProfiles[activeKey].weights, availableStats);
    }
    updateProfileActionsState();
}
function updateProfileActionsState() {
    const totalProfiles = Object.keys(scoringProfiles).length;
    const hasActive = Boolean(activeProfileKey && scoringProfiles[activeProfileKey]);
    if (deleteProfileBtn) {
        deleteProfileBtn.disabled = !hasActive || totalProfiles <= 1;
    }
}
async function deleteScoringProfileAction() {
    if (!activeProfileKey || !scoringProfiles[activeProfileKey]) {
        showToast("Select a scoring preset first.", "error");
        return;
    }
    if (Object.keys(scoringProfiles).length <= 1) {
        showToast("At least one scoring preset must remain.", "error");
        return;
    }
    const profile = scoringProfiles[activeProfileKey];
    const confirmed = window.confirm(`Delete scoring preset "${profile.name}"?`);
    if (!confirmed) {
        return;
    }
    if (deleteProfileBtn) deleteProfileBtn.disabled = true;
    try {
        await fetchJSON(`/settings/scoring/${activeProfileKey}`, { method: "DELETE" });
        showToast("Scoring preset deleted.", "success");
        activeProfileKey = "";
        await loadScoringProfiles();
    } catch (error) {
        showToast(error.message || "Unable to delete preset.", "error");
    } finally {
        updateProfileActionsState();
    }
}
async function loadScoreboard(dateValue) {
    if (!leagueInitialized || !currentLeagueId) {
        scoreboardList.innerHTML = `
            <li class="score-card disabled">
                <div class="teams"><div class="team-row"><span>No simulated games yet.</span></div></div>
            </li>
        `;
        activeGameId = null;
        return;
    }
    const targetDate = dateValue || scoreboardDateInput.value;
    try {
        const params = new URLSearchParams({ league_id: currentLeagueId });
        if (targetDate) {
            params.set("date", targetDate);
        }
        const data = await fetchJSON(`/games?${params.toString()}`);
        scoreboardDateInput.value = data.date;
        renderScoreboard(data);
    } catch (error) {
        showToast(error.message || "Unable to load scoreboard.", "error");
    }
}
async function loadLeagueState(leagueId, options = {}) {
    if (!leagueId) {
        return;
    }
    const suppressToast = options.suppressToast ?? false;
    try {
        const state = await fetchJSON(`/leagues/${leagueId}`);
        currentLeagueId = leagueId;
        renderLeagueState(state);
        setLeagueUI(true);
        navMenuBtn.classList.remove("hidden");
        const draftActive = Boolean(state.draft_state && state.draft_state.status !== "completed");
        await loadLeagueWeeks(leagueId, { maintainSelection: options.maintainWeekSelection ?? true, silent: true });
        setupRosterPanel(state);
        updateRosterStatus();
        if (draftActive) {
            scoreboardDateInput.value = "";
            if (autoplayBtn) autoplayBtn.disabled = true;
            return;
        }
        if (autoplayBtn) autoplayBtn.disabled = false;
        const scoreboardTarget = state.current_date || state.latest_completed_date || "";
        if (scoreboardTarget) {
            scoreboardDateInput.value = scoreboardTarget;
            await loadScoreboard(scoreboardTarget);
            // Sync week selection to the scoreboard date
            syncActiveWeekToDate(scoreboardTarget);
            await loadRosterDaily({ silent: true });
        } else {
            scoreboardDateInput.value = "";
            await loadScoreboard(null);
        }
    } catch (error) {
        if (!suppressToast) {
            showToast(error.message || "Unable to load league.", "error");
        }
        throw error;
    }
}
async function createLeague() {
    const teamCount = Math.max(2, Number(teamCountInput.value) || 12);
    const rosterSize = Math.max(1, Number(rosterSizeInput.value) || 13);
    const userTeamName = teamNameInput.value.trim();
    const scoringProfileKey = scoringSelect.value || activeProfileKey;
    const leagueName = leagueNameInput.value.trim();
    const profileFallbackName =
        (scoringProfileKey && scoringProfiles[scoringProfileKey] && scoringProfiles[scoringProfileKey].name) || "";
    // Only include the user's desired team name; let the server fill the rest
    // from its CSV-backed name pool.
    const teamNames = userTeamName ? [userTeamName] : [];
    createLeagueBtn.disabled = true;
    const originalLabel = createLeagueBtn.textContent;
    createLeagueBtn.textContent = "Creating...";
    try {
        const payload = {
            league_name: leagueName || profileFallbackName || "New League",
            scoring_profile: scoringProfileKey || undefined,
            team_count: teamCount,
            roster_size: rosterSize,
            user_team_name: userTeamName || null,
            team_names: teamNames,
        };
        const data = await fetchJSON("/leagues", {
            method: "POST",
            body: JSON.stringify(payload),
        });
        showToast("League created.", "success");
        await loadLeaguesList();
        currentLeagueId = data.league_id;
        await loadLeagueState(data.league_id, { suppressToast: true });
        showDashboardView();
    } catch (error) {
        showToast(error.message || "Unable to create league.", "error");
    } finally {
        createLeagueBtn.disabled = false;
        createLeagueBtn.textContent = originalLabel;
    }
}
async function simulateDay() {
    // Prevent concurrent simulate/advance requests from UI spamming
    if (simulateDay.inFlight) {
        return;
    }
    if (!currentLeagueId) {
        showToast("Select a league first.", "error");
        return;
    }
    if (!currentLeagueState) {
        showToast("League state not ready yet.", "error");
        return;
    }
    if (!currentLeagueState.current_date) {
        showToast("Season complete.", "error");
        return;
    }
    const awaiting = Boolean(currentLeagueState.awaiting_simulation);
    const endpoint = awaiting ? `/leagues/${currentLeagueId}/simulate` : `/leagues/${currentLeagueId}/advance`;
    const requestOptions = awaiting
        ? { method: "POST", body: JSON.stringify({}) }
        : { method: "POST" };
    try {
        simulateDay.inFlight = true;
        simulateBtn.disabled = true;
        simulateBtn.textContent = awaiting ? "Simulating…" : "Advancing…";
        const response = await fetchJSON(endpoint, requestOptions);
        let message;
        if (awaiting) {
            message = response && response.date ? `Played ${response.date}` : "Today's games simulated.";
        } else {
            if (response && Object.prototype.hasOwnProperty.call(response, "current_date")) {
                message = response.current_date ? `Advanced to ${response.current_date}` : "Season complete.";
            } else {
                message = "Advanced to next day.";
            }
        }
        showToast(message, "success");
        await loadLeagueState(currentLeagueId, { suppressToast: true });
        // Soft-refresh the league list without altering the current view
        await loadLeaguesList();
    } catch (error) {
        showToast(error.message || "Unable to update league day.", "error");
    } finally {
        simulateDay.inFlight = false;
        // Re-enable and restore label based on new state after loadLeagueState
        const awaitingNow = Boolean(currentLeagueState && currentLeagueState.awaiting_simulation);
        simulateBtn.disabled = false;
        simulateBtn.textContent = awaitingNow ? "Play today's games" : (currentLeagueState && currentLeagueState.current_date ? "Go to next day" : "Season complete");
    }
}
async function resetLeague() {
    if (!currentLeagueId) {
        showToast("Select a league first.", "error");
        return;
    }
    if (!confirm("This will reset the league to its original draft. Continue?")) {
        return;
    }
    try {
        await fetchJSON(`/leagues/${currentLeagueId}/reset`, { method: "POST" });
        showToast("League reset. Ready to simulate!", "success");
        await loadLeagueState(currentLeagueId, { suppressToast: true });
        await loadLeaguesList();
    } catch (error) {
        showToast(error.message, "error");
    }
}
async function saveScoringProfile(event) {
    event.preventDefault();
    const formData = new FormData(scoringForm);
    const sourceProfileKey = scoringSelect.value || activeProfileKey;
    const sourceProfile =
        (sourceProfileKey && scoringProfiles[sourceProfileKey]) || null;
    const defaultSuggestion = sourceProfile ? `${sourceProfile.name} Copy` : "Custom Points";
    const rawNameInput = window.prompt("Name this scoring preset:", defaultSuggestion);
    if (rawNameInput === null) {
        return;
    }
    const rawName = rawNameInput.trim();
    if (!rawName) {
        showToast("Preset name cannot be empty.", "error");
        return;
    }
    let key = rawName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    if (!key) {
        key = `profile_${Date.now()}`;
    }
    const name = rawName;
    const makeDefault = !!formData.get("make_default");
    const weights = {};
    weightsEditor.querySelectorAll("input[data-stat]").forEach((input) => {
        const stat = input.dataset.stat;
        const value = Number(input.value);
        if (Number.isFinite(value)) {
            weights[stat] = value;
        }
    });
    try {
        await fetchJSON("/settings/scoring", {
            method: "POST",
            body: JSON.stringify({
                key,
                name,
                weights,
                make_default: makeDefault,
            }),
        });
        activeProfileKey = key;
        showToast("Scoring preset saved.", "success");
        await loadScoringProfiles();
        if (currentLeagueId) {
            await loadLeagueState(currentLeagueId, { suppressToast: true });
        }
    } catch (error) {
        showToast(error.message, "error");
    }
}
// Event listeners
document.addEventListener("click", (event) => {
    const trigger = event.target.closest(".player-link");
    if (!trigger) {
        return;
    }
    event.preventDefault();
    const playerId = Number(trigger.dataset.playerId);
    if (!Number.isFinite(playerId) || playerId <= 0) {
        return;
    }
    const leagueId = trigger.dataset.leagueId || currentLeagueId;
    const explicitDate = trigger.dataset.gameDate || trigger.dataset.resultDate || "";
    const detailContainer = trigger.closest(".score-detail");
    const teamCard = trigger.closest(".team-card");
    const matchupCard = trigger.closest(".matchup-card");
    const derivedDate =
        explicitDate ||
        (detailContainer && detailContainer.dataset.boxscoreDate) ||
        (teamCard && teamCard.dataset.resultDate) ||
        (matchupCard && matchupCard.dataset.matchupDate) ||
        currentScoreboardDate ||
        "";
    openPlayerModal(playerId, { leagueId, date: derivedDate });
});
if (playerModal) {
    playerModal.addEventListener("click", (event) => {
        if (event.target.closest("[data-close-player-modal]")) {
            closePlayerModal();
            return;
        }
        const actionButton = event.target.closest("[data-player-action]");
        if (actionButton) {
            event.preventDefault();
            const action = actionButton.dataset.playerAction;
            const modalLeague = playerModal.dataset.leagueId || currentLeagueId;
            const modalDate = playerModal.dataset.playerDate || null;
            const playerId = Number(actionButton.dataset.playerId || playerModal.dataset.playerId || 0);
            if (!Number.isFinite(playerId) || playerId <= 0) {
                return;
            }
            if (action === "add") {
                const original = actionButton.textContent || "Add";
                actionButton.disabled = true;
                actionButton.textContent = "Adding…";
                addPlayerToRoster(playerId)
                    .then(async () => {
                        await loadPlayerModalContent(playerId, { leagueId: modalLeague, date: modalDate }, { suppressToast: true });
                        (playerModalClose || playerModal.querySelector(".player-modal__close"))?.focus();
                    })
                    .catch((error) => {
                        if (!error || !error.silent) {
                            showToast(error.message || "Unable to add player.", "error");
                        }
                    })
                    .finally(() => {
                        if (actionButton.isConnected) {
                            actionButton.disabled = false;
                            actionButton.textContent = original;
                        }
                    });
                return;
            }
            if (action === "drop") {
                const confirmed = confirm("Drop this player from your team?");
                if (!confirmed) {
                    return;
                }
                const original = actionButton.textContent || "Drop";
                actionButton.disabled = true;
                actionButton.textContent = "Dropping…";
                dropPlayerFromRoster(playerId)
                    .then(async () => {
                        await loadPlayerModalContent(playerId, { leagueId: modalLeague, date: modalDate }, { suppressToast: true });
                        (playerModalClose || playerModal.querySelector(".player-modal__close"))?.focus();
                    })
                    .catch((error) => {
                        if (!error || !error.silent) {
                            showToast(error.message || "Unable to drop player.", "error");
                        }
                    })
                    .finally(() => {
                        if (actionButton.isConnected) {
                            actionButton.disabled = false;
                            actionButton.textContent = original;
                        }
                    });
                return;
            }
            const actionLabel = actionButton.textContent.trim() || "Action";
            showToast(`${actionLabel} coming soon.`, "error");
        }
    });
}
if (playerModalClose) {
    playerModalClose.addEventListener("click", (event) => {
        event.preventDefault();
        closePlayerModal();
    });
}
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && playerModal && !playerModal.classList.contains("hidden")) {
        closePlayerModal();
    }
});
if (weekSelect) {
    weekSelect.addEventListener("change", (event) => {
        const nextIndex = Number(event.target.value);
        if (Number.isFinite(nextIndex)) {
            setActiveWeek(nextIndex);
        }
    });
}
function stepWeek(direction) {
    const weeks = (weekOverviewData.weeks || []).slice().sort((a, b) => Number(a.index) - Number(b.index));
    if (!weeks.length) {
        return;
    }
    const position = weeks.findIndex((week) => Number(week.index) === Number(activeWeekIndex));
    if (position === -1) {
        return;
    }
    const nextPosition = position + direction;
    if (nextPosition < 0 || nextPosition >= weeks.length) {
        return;
    }
    setActiveWeek(Number(weeks[nextPosition].index));
}
if (weekPrevBtn) {
    weekPrevBtn.addEventListener("click", () => {
        stepWeek(-1);
    });
}
if (weekNextBtn) {
    weekNextBtn.addEventListener("click", () => {
        stepWeek(1);
    });
}
function initPlayerCardTabs() {
    if (!playerModalBody) {
        return;
    }
    const card = playerModalBody.querySelector(".player-card");
    if (!card) {
        return;
    }
    const tabButtons = Array.from(card.querySelectorAll(".player-card__tab"));
    const panels = Array.from(card.querySelectorAll(".player-card__panel"));
    if (!tabButtons.length || !panels.length) {
        return;
    }
    const activate = (target) => {
        tabButtons.forEach((btn) => {
            const isActive = btn.dataset.tab === target;
            btn.classList.toggle("active", isActive);
            btn.setAttribute("aria-selected", String(isActive));
            btn.setAttribute("tabindex", isActive ? "0" : "-1");
        });
        panels.forEach((panel) => {
            const isActive = panel.dataset.panel === target;
            panel.classList.toggle("is-active", isActive);
            panel.setAttribute("aria-hidden", String(!isActive));
            if (isActive) {
                panel.removeAttribute("hidden");
            } else if (!panel.hasAttribute("hidden")) {
                panel.setAttribute("hidden", "");
            }
        });
    };
    tabButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
            activate(btn.dataset.tab);
        });
        btn.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activate(btn.dataset.tab);
            }
        });
    });
    activate("stats");
}
scoreboardDateInput.addEventListener("change", () => {
    if (scoreboardDateInput.disabled) return;
    playersPage = 1;
    loadScoreboard(scoreboardDateInput.value);
    loadPlayersPanel({ silent: true });
    loadRosterDaily({ silent: true });
});
simulateBtn.addEventListener("click", simulateDay);
resetBtn.addEventListener("click", resetLeague);
navMenuBtn.addEventListener("click", async () => {
    setLeagueUI(false);
    await loadLeaguesList();
});
scoringSelect.addEventListener("change", () => {
    activeProfileKey = scoringSelect.value;
    const selected = scoringProfiles[activeProfileKey];
    if (selected) {
        populateWeightsEditor(selected.weights, availableStats);
    }
    updateProfileActionsState();
});
scoringForm.addEventListener("submit", saveScoringProfile);
createLeagueBtn.addEventListener("click", createLeague);
if (deleteProfileBtn) {
    deleteProfileBtn.addEventListener("click", deleteScoringProfileAction);
}
if (autoplayBtn) {
    autoplayBtn.addEventListener("click", autoplaySeason);
}
async function suggestTeamName() {
    try {
        const exclude = [];
        const current = (teamNameInput.value || "").trim();
        if (current) exclude.push(current);
        const params = new URLSearchParams();
        params.set("count", "1");
        exclude.forEach((name) => params.append("exclude", name));
        const data = await fetchJSON(`/team_names?${params.toString()}`);
        const suggestion = (data.suggestions || [])[0];
        if (suggestion) {
            teamNameInput.value = suggestion;
            showToast("Suggested team name applied.", "success");
            teamNameInput.focus();
            teamNameInput.select();
        } else {
            showToast("No suggestions available.", "error");
        }
    } catch (error) {
        showToast(error.message || "Unable to suggest a name.", "error");
    }
}
if (suggestTeamNameBtn) {
    suggestTeamNameBtn.addEventListener("click", suggestTeamName);
}
if (deleteAllLeaguesBtn) {
    deleteAllLeaguesBtn.addEventListener("click", async () => {
        if (deleteAllLeaguesBtn.disabled) return;
        const confirmed = confirm("Delete ALL leagues? This cannot be undone.");
        if (!confirmed) return;
        const original = deleteAllLeaguesBtn.textContent;
        deleteAllLeaguesBtn.disabled = true;
        deleteAllLeaguesBtn.textContent = "Deleting...";
        try {
            const result = await fetchJSON("/leagues", { method: "DELETE" });
            const n = Number(result && result.deleted) || 0;
            showToast(`Deleted ${n} league${n === 1 ? "" : "s"}.`, "success");
            await loadLeaguesList();
        } catch (error) {
            showToast(error.message || "Unable to delete all leagues.", "error");
        } finally {
            deleteAllLeaguesBtn.textContent = original;
            deleteAllLeaguesBtn.disabled = !leaguesCache.length;
        }
    });
}
function formatPct(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "–";
    return `${num.toFixed(1).replace(/\.0$/, "")} %`;
}
function renderPlayersTable(payload) {
    if (!playersListEl) return;
    const rosterInfo = getUserRosterInfo();
    playersTotal = Number(payload?.count || 0);
    const rows = (payload.results || []).map((p) => {
        let addBtn;
        if (!p.available) {
            addBtn = `<span class="muted">${escapeHtml(p.fantasy_team || "Rostered")}</span>`;
        } else if (rosterInfo.full) {
            addBtn = `<button type="button" class="btn-add-player" data-player-id="${p.player_id}" disabled title="Roster full">Add</button>`;
        } else {
            addBtn = `<button type="button" class="btn-add-player" data-player-id="${p.player_id}">Add</button>`;
        }
        const nameBtn = `<button type="button" class="player-link" data-player-id="${p.player_id}" data-player-name="${escapeHtml(p.player_name)}" data-result-date="${escapeHtml(payload.date || scoreboardDateInput.value || "")}" data-source="players">${escapeHtml(p.player_name)}</button>`;
        return `
            <tr>
                <td>${nameBtn}</td>
                <td>${escapeHtml(p.team || "")}</td>
                <td>${formatNumber(p.GP, { decimals: 0 })}</td>
                <td>${formatFantasy(p.fantasy)}</td>
                <td>${formatNumber(p.MIN, { decimals: 1 })}</td>
                <td>${formatNumber(p.PTS, { decimals: 1 })}</td>
                <td>${formatNumber(p.REB, { decimals: 1 })}</td>
                <td>${formatNumber(p.AST, { decimals: 1 })}</td>
                <td>${formatNumber(p.STL, { decimals: 1 })}</td>
                <td>${formatNumber(p.BLK, { decimals: 1 })}</td>
                <td>${formatNumber(p.FGM, { decimals: 1 })}/${formatNumber(p.FGA, { decimals: 1 })}</td>
                <td>${formatPct(p.FG_PCT)}</td>
                <td>${formatNumber(p.FG3M, { decimals: 1 })}/${formatNumber(p.FG3A, { decimals: 1 })}</td>
                <td>${formatPct(p.FG3_PCT)}</td>
                <td>${formatNumber(p.FTM, { decimals: 1 })}/${formatNumber(p.FTA, { decimals: 1 })}</td>
                <td>${formatPct(p.FT_PCT)}</td>
                <td>${formatNumber(p.TOV, { decimals: 1 })}</td>
                <td>${formatNumber(p.PF, { decimals: 1 })}</td>
                <td class="action-cell">${addBtn}</td>
            </tr>
        `;
    }).join("");
    const headers = [
        { key: "name", label: "Player" },
        { key: "team", label: "Team" },
        { key: "gp", label: "GP" },
        { key: "fantasy", label: "Fan Pts" },
        { key: "min", label: "MIN" },
        { key: "pts", label: "PTS" },
        { key: "reb", label: "REB" },
        { key: "ast", label: "AST" },
        { key: "stl", label: "STL" },
        { key: "blk", label: "BLK" },
        { key: "fgm", label: "FG" },
        { key: "fg_pct", label: "FG%" },
        { key: "fg3m", label: "3PT" },
        { key: "fg3_pct", label: "3PT%" },
        { key: "ftm", label: "FT" },
        { key: "ft_pct", label: "FT%" },
        { key: "tov", label: "TO" },
        { key: "pf", label: "PF" },
        { key: "actions", label: "" },
    ];
    const totalColumns = headers.length;
    const thead = `
        <thead>
            <tr>
                ${headers.map((h) => {
                    if (!h.key || h.key === "name" || h.key === "team" || h.key === "actions") {
                        return `<th>${h.label}</th>`;
                    }
                    const isActive = playersSortKey === h.key;
                    const dir = isActive ? playersSortDir : "asc";
                    const arrow = isActive ? (playersSortDir === "asc" ? "▲" : "▼") : "";
                    return `<th class="sortable" data-sort="${h.key}" data-dir="${dir}">${h.label} ${arrow}</th>`;
                }).join("")}
            </tr>
        </thead>
    `;
    const tableBody = rows || `<tr class="empty"><td colspan="${totalColumns}">No players match the current filters.</td></tr>`;
    const totalPages = Math.max(1, Math.ceil(playersTotal / playersPageSize));
    const safePage = playersTotal === 0 ? 1 : Math.min(playersPage, totalPages);
    playersPage = safePage;
    const rangeStart = playersTotal === 0 ? 0 : (playersPage - 1) * playersPageSize + 1;
    const rangeEnd = playersTotal === 0 ? 0 : Math.min(playersTotal, playersPage * playersPageSize);
    const canPrev = playersPage > 1;
    const canNext = playersPage < totalPages && playersTotal > 0;
    const pageSizeOptions = PLAYER_PAGE_SIZES.map(
        (size) => `<option value="${size}"${size === playersPageSize ? " selected" : ""}>${size}</option>`
    ).join("");
    const infoText = playersTotal
        ? `Showing ${rangeStart}&ndash;${rangeEnd} of ${playersTotal}`
        : "No players to display";
    const paginationHtml = `
        <div class="players-pagination">
            <div class="players-pagination__info">${infoText}</div>
            <div class="players-pagination__controls">
                <label for="players-page-size">Rows per page</label>
                <select id="players-page-size">${pageSizeOptions}</select>
                <div class="players-pagination__nav">
                    <button type="button" class="players-pagination__btn players-pagination__prev"${canPrev ? "" : " disabled"}>Previous</button>
                    <span class="players-pagination__page">Page ${playersTotal ? playersPage : 0} of ${playersTotal ? totalPages : 0}</span>
                    <button type="button" class="players-pagination__btn players-pagination__next"${canNext ? "" : " disabled"}>Next</button>
                </div>
            </div>
        </div>
    `;
    playersListEl.innerHTML = `
        <div class="players-table-wrapper">
            <table>
                ${thead}
                <tbody>${tableBody}</tbody>
            </table>
        </div>
        ${paginationHtml}
    `;
    updateRosterStatus();
    // Sort handlers
    playersListEl.querySelectorAll("th.sortable").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sort;
            if (!key) return;
            if (playersSortKey === key) {
                playersSortDir = playersSortDir === "asc" ? "desc" : "asc";
            } else {
                playersSortKey = key;
                playersSortDir = th.dataset.dir || "asc";
            }
            playersPage = 1;
            loadPlayersPanel({ silent: true });
        });
    });
    // Add buttons
    playersListEl.querySelectorAll(".btn-add-player").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const playerId = Number(btn.dataset.playerId);
            if (!Number.isFinite(playerId)) return;
            try {
                btn.disabled = true;
                const original = btn.textContent || "Add";
                btn.textContent = "Adding…";
                await addPlayerToRoster(playerId);
            } catch (error) {
                if (!error || !error.silent) {
                    showToast(error.message || "Unable to add player.", "error");
                }
            } finally {
                if (btn.isConnected) {
                    btn.disabled = false;
                    btn.textContent = original;
                }
            }
        });
    });
    const pageSizeSelect = playersListEl.querySelector("#players-page-size");
    if (pageSizeSelect) {
        pageSizeSelect.addEventListener("change", () => {
            const nextSize = Number(pageSizeSelect.value) || playersPageSize;
            if (nextSize && nextSize !== playersPageSize) {
                playersPageSize = nextSize;
                playersPage = 1;
                loadPlayersPanel({ silent: true });
            }
        });
    }
    const prevBtn = playersListEl.querySelector(".players-pagination__prev");
    if (prevBtn) {
        prevBtn.addEventListener("click", () => {
            if (playersPage > 1) {
                playersPage -= 1;
                loadPlayersPanel({ silent: true });
            }
        });
    }
    const nextBtn = playersListEl.querySelector(".players-pagination__next");
    if (nextBtn) {
        nextBtn.addEventListener("click", () => {
            if (playersPage < totalPages && playersTotal > 0) {
                playersPage += 1;
                loadPlayersPanel({ silent: true });
            }
        });
    }
}
async function loadPlayersPanel(options = {}) {
    if (!playersPanel || !currentLeagueId) {
        return;
    }
    const silent = options.silent ?? false;
    if (!Number.isFinite(playersPage) || playersPage < 1) {
        playersPage = 1;
    }
    const dateParam = scoreboardDateInput.value || "";
    const params = new URLSearchParams();
    if (dateParam) params.set("date", dateParam);
    params.set("view", playersViewMode);
    params.set("filter", playersFilter);
    params.set("sort", playersSortKey);
    params.set("order", playersSortDir);
    const limit = playersPageSize;
    const offset = Math.max(0, (playersPage - 1) * playersPageSize);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (playersSearchTerm) params.set("search", playersSearchTerm);
    try {
        const data = await fetchJSON(`/leagues/${currentLeagueId}/players?${params.toString()}`);
        const total = Number(data?.count || 0);
        const totalPages = Math.max(1, Math.ceil(total / playersPageSize));
        if (total > 0 && playersPage > totalPages) {
            playersPage = totalPages;
            return loadPlayersPanel({ silent: true });
        }
        renderPlayersTable(data);
    } catch (error) {
        if (!silent) {
            showToast(error.message || "Unable to load players.", "error");
        }
        if (playersListEl) {
            playersListEl.innerHTML = `<p class="error">${escapeHtml(error.message || "Unable to load players.")}</p>`;
        }
    }
}

async function autoplaySeason() {
    if (!currentLeagueId) {
        showToast("Select a league first.", "error");
        return;
    }
    if (draftIsActive || (currentLeagueState?.draft_state && currentLeagueState.draft_state.status !== "completed")) {
        showToast("Finish the draft before autoplaying.", "error");
        return;
    }
    if (autoplaySeason.inFlight) {
        return;
    }
    autoplaySeason.inFlight = true;
    const original = autoplayBtn ? autoplayBtn.textContent : "Auto-Sim Season";
    if (autoplayBtn) {
        autoplayBtn.disabled = true;
        autoplayBtn.textContent = "Auto-simming…";
    }
    try {
        const response = await fetchJSON(`/leagues/${currentLeagueId}/autoplay`, { method: "POST" });
        const simulatedDays = Array.isArray(response?.simulated_days) ? response.simulated_days.length : 0;
        const message = simulatedDays ? `Auto-simmed ${simulatedDays} day${simulatedDays === 1 ? "" : "s"}.` : "Season auto-simmed.";
        showToast(message, "success");
        await loadLeagueState(currentLeagueId, { suppressToast: true, maintainWeekSelection: true });
        await loadLeaguesList();
    } catch (error) {
        showToast(error.message || "Unable to auto-sim season.", "error");
    } finally {
        autoplaySeason.inFlight = false;
        if (autoplayBtn) {
            autoplayBtn.textContent = original || "Auto-Sim Season";
            autoplayBtn.disabled = false;
        }
    }
}
function debounce(fn, delay = 300) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), delay);
    };
}
function renderRosterTeam(team) {
    if (!rosterTeamView) return;
    if (!team || !Array.isArray(team.players)) {
        rosterTeamView.innerHTML = `<p class="error">No data available.</p>`;
        return;
    }
    const players = team.players || [];
    const tableRows = players.map((p) => {
        const name = escapeHtml(p.player_name || "");
        const pid = Number(p.player_id);
        const dateIso = p.date || scoreboardDateInput.value || "";
        const nameBtn = Number.isFinite(pid) && pid
            ? `<button type=\"button\" class=\"player-link\" data-player-id=\"${pid}\" data-player-name=\"${name}\" data-result-date=\"${escapeHtml(dateIso)}\" data-source=\"roster\">${name}</button>`
            : name;
        const fantasy = formatFantasy(p.fantasy_points || 0);
        const opponent = escapeHtml(p.matchup || p.opponent || "");
        const timeResult = escapeHtml(p.time_result || p.result || p.time || p.status || "");
        const fgLine = `${formatNumber(p.FGM, { decimals: 1 })}-${formatNumber(p.FGA, { decimals: 1 })}`;
        const fgPct = Number(p.FGA) ? formatPct(p.FG_PCT) : "–";
        const threeLine = `${formatNumber(p.FG3M, { decimals: 1 })}-${formatNumber(p.FG3A, { decimals: 1 })}`;
        const threePct = Number(p.FG3A) ? formatPct(p.FG3_PCT) : "–";
        const ftLine = `${formatNumber(p.FTM, { decimals: 1 })}-${formatNumber(p.FTA, { decimals: 1 })}`;
        const ftPct = Number(p.FTA) ? formatPct(p.FT_PCT) : "–";
        const isDNP = !p.played || !p.MIN || Number(p.MIN) === 0;
        const displayName = isDNP ? `${nameBtn} <em>(DNP)</em>` : nameBtn;
        const rowClass = `player-row ${isDNP ? "did-not-play" : "played"}`;
        const dateLabel = formatDisplayDate(dateIso);
        return `
            <tr class="${rowClass}">
                <td>${displayName}</td>
                <td>${dateLabel}</td>
                <td>${opponent}</td>
                <td>${timeResult}</td>
                <td>${fantasy}</td>
                <td>${formatNumber(p.MIN, { decimals: 1 })}</td>
                <td>${formatNumber(p.PTS, { decimals: 1 })}</td>
                <td>${formatNumber(p.REB, { decimals: 1 })}</td>
                <td>${formatNumber(p.AST, { decimals: 1 })}</td>
                <td>${formatNumber(p.STL, { decimals: 1 })}</td>
                <td>${formatNumber(p.BLK, { decimals: 1 })}</td>
                <td>${fgLine}</td>
                <td>${fgPct}</td>
                <td>${threeLine}</td>
                <td>${threePct}</td>
                <td>${ftLine}</td>
                <td>${ftPct}</td>
                <td>${formatNumber(p.TOV, { decimals: 1 })}</td>
                <td>${formatNumber(p.PF, { decimals: 1 })}</td>
            </tr>
        `;
    }).join("");
    const table = `
        <section class=\"matchup-team-detail\">
            <h4>
                <span>${escapeHtml(team.name || "Team")}</span>
                <span>${formatFantasy(team.total || 0)} pts</span>
            </h4>
            <table>
                <thead>
                    <tr>
                        <th>Player</th>
                        <th>Date</th>
                        <th>Opponent</th>
                        <th>Time / Result</th>
                        <th>Fan Pts</th>
                        <th>MIN</th>
                        <th>PTS</th>
                        <th>REB</th>
                        <th>AST</th>
                        <th>STL</th>
                        <th>BLK</th>
                        <th>FG</th>
                        <th>FG%</th>
                        <th>3PT</th>
                        <th>3PT%</th>
                        <th>FT</th>
                        <th>FT%</th>
                        <th>TO</th>
                        <th>PF</th>
                    </tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
        </section>
    `;
    rosterTeamView.innerHTML = table;
}
async function loadRosterDaily(options = {}) {
    if (!currentLeagueId || !rosterPanel) return;
    const silent = options.silent ?? false;
    const team = rosterSelectedTeam || (currentLeagueState && currentLeagueState.user_team_name) || null;
    if (!team) {
        rosterPanel.classList.add("hidden");
        return;
    }
    const params = new URLSearchParams();
    params.set("team", team);
    const dateIso = scoreboardDateInput.value || "";
    if (dateIso) params.set("date", dateIso);
    try {
        const data = await fetchJSON(`/leagues/${currentLeagueId}/teams/daily?${params.toString()}`);
        rosterPanel.classList.remove("hidden");
        renderRosterTeam(data.team);
    } catch (error) {
        if (!silent) {
            showToast(error.message || "Unable to load roster.", "error");
        }
        rosterPanel.classList.remove("hidden");
        rosterTeamView.innerHTML = `<p class=\"error\">${escapeHtml(error.message || "No simulated games for this date.")}</p>`;
    }
}
function setupRosterPanel(state) {
    if (!rosterPanel || !rosterTeamSelect) return;
    const teams = Array.isArray(state.team_names) ? state.team_names : [];
    rosterTeamSelect.innerHTML = teams.map((t) => `<option value=\"${escapeHtml(t)}\">${escapeHtml(t)}</option>`).join("");
    rosterSelectedTeam = state.user_team_name || (teams[0] || null);
    if (rosterSelectedTeam) {
        rosterTeamSelect.value = rosterSelectedTeam;
    }
}
if (rosterTeamSelect) {
    rosterTeamSelect.addEventListener("change", () => {
        rosterSelectedTeam = rosterTeamSelect.value || null;
        loadRosterDaily({ silent: true });
    });
}
if (playersSearchInput) {
    playersSearchInput.addEventListener("input", debounce(() => {
        playersSearchTerm = playersSearchInput.value.trim();
        playersPage = 1;
        loadPlayersPanel({ silent: true });
    }, 250));
}
if (playersViewSelect) {
    playersViewSelect.addEventListener("change", () => {
        playersViewMode = playersViewSelect.value;
        playersPage = 1;
        loadPlayersPanel({ silent: true });
    });
}
if (playersFilterSelect) {
    playersFilterSelect.addEventListener("change", () => {
        playersFilter = playersFilterSelect.value;
        playersPage = 1;
        loadPlayersPanel({ silent: true });
    });
}
if (draftSearchInput) {
    draftSearchInput.addEventListener("input", debounce(() => {
        draftSearchTerm = draftSearchInput.value.trim();
        if (draftIsActive) {
            loadDraftPlayers({ reset: true });
        }
    }, 250));
}
if (draftViewSelect) {
    draftViewSelect.addEventListener("change", () => {
        const selected = draftViewSelect.value === "totals" ? "totals" : "averages";
        if (draftViewMode === selected) {
            return;
        }
        draftViewMode = selected;
        if (draftIsActive) {
            loadDraftSummaryOnly().catch((error) => console.error(error));
            loadDraftPlayers({ reset: true });
        }
    });
}
if (draftLoadMoreBtn) {
    draftLoadMoreBtn.addEventListener("click", () => {
        if (!draftIsActive || draftPlayersState.length >= draftPlayersTotal) {
            return;
        }
        loadDraftPlayers({ reset: false });
    });
}
if (draftAutoPickBtn) {
    draftAutoPickBtn.addEventListener("click", () => {
        if (draftIsActive) {
            draftAutopick();
        }
    });
}
if (draftAutoRestBtn) {
    draftAutoRestBtn.addEventListener("click", () => {
        if (draftIsActive) {
            draftAutopickRest();
        }
    });
}
if (draftCompleteBtn) {
    draftCompleteBtn.addEventListener("click", () => {
        if (draftIsActive) {
            draftComplete();
        }
    });
}
// Bootstrap
(async function init() {
    try {
        showSetupView();
        await loadScoringProfiles();
        await loadLeaguesList();
    } catch (error) {
        console.error(error);
        showToast(error.message || "Failed to initialise dashboard", "error");
    }
})();
function syncActiveWeekToDate(dateIso) {
    if (!dateIso || !weekOverviewData || !Array.isArray(weekOverviewData.weeks)) return;
    const dt = parseIsoDate(dateIso);
    if (!dt) return;
    const weeks = weekOverviewData.weeks;
    for (const week of weeks) {
        const start = parseIsoDate(week.start);
        const end = parseIsoDate(week.end);
        if (!start || !end) continue;
        if (dt >= start && dt <= end) {
            if (Number(week.index) !== Number(activeWeekIndex)) {
                activeWeekIndex = Number(week.index);
                updateWeekControls();
                renderMatchups();
            }
            break;
        }
    }
}
