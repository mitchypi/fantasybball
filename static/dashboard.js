const scoreboardList = document.getElementById("scoreboard-list");
const scoreboardDateInput = document.getElementById("scoreboard-date");
const simulateBtn = document.getElementById("simulate-day");
const resetBtn = document.getElementById("reset-league");
const leagueDateEl = document.getElementById("league-date");
const leagueScoringEl = document.getElementById("league-scoring");
const fantasyResultsEl = document.getElementById("fantasy-results");
const scoringSelect = document.getElementById("scoring-select");
const weightsEditor = document.getElementById("weights-editor");
const scoringForm = document.getElementById("scoring-form");
const leagueNameInput = document.getElementById("league-name");
const renameProfileBtn = document.getElementById("rename-profile");
const deleteProfileBtn = document.getElementById("delete-profile");
const teamCountInput = document.getElementById("team-count");
const rosterSizeInput = document.getElementById("roster-size");
const teamNameInput = document.getElementById("team-name");
const createLeagueBtn = document.getElementById("create-league");
const setupPanel = document.getElementById("setup-panel");
const leaguePanels = document.getElementById("league-panels");
const leagueListEl = document.getElementById("league-list");
const navMenuBtn = document.getElementById("nav-menu");
const toast = document.getElementById("toast");
const playerModal = document.getElementById("player-modal");
const playerModalBody = document.getElementById("player-modal-body");
const playerModalClose = playerModal ? playerModal.querySelector(".player-modal__close") : null;

let scoringProfiles = {};
let availableStats = [];
let activeProfileKey = "";
let currentScoreboardDate = "";
let activeGameId = null;
let leagueInitialized = false;
let currentLeagueId = null;
let leaguesCache = [];
let lastFocusedElement = null;
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
    { key: "3PT", label: "3PT" },
    { key: "FT", label: "FT" },
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
    { key: "3PT", label: "3PT" },
    { key: "FT", label: "FT" },
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

function formatShotLine(stats, key, hasData) {
    const config = SHOT_COLUMNS[key];
    if (!config || !stats || !hasData) {
        return "–";
    }
    const made = Number(stats[config.made] ?? 0);
    const attempts = Number(stats[config.attempts] ?? 0);
    if (!Number.isFinite(made) || !Number.isFinite(attempts)) {
        return "–";
    }
    if (made === 0 && attempts === 0) {
        return "0-0";
    }
    const madeText = formatNumber(made, { decimals: 1 }).replace(/\.0$/, "");
    const attemptsText = formatNumber(attempts, { decimals: 1 }).replace(/\.0$/, "");
    const pctValue = Number(stats[config.percent] ?? 0);
    const pctText = Number.isFinite(pctValue) && pctValue > 0 ? `${pctValue.toFixed(1).replace(/\.0+$/, "")}%` : "";
    return pctText ? `${madeText}-${attemptsText} (${pctText})` : `${madeText}-${attemptsText}`;
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
                formatShotLine(stats, "FG", hasGames),
                formatShotLine(stats, "3PT", hasGames),
                formatShotLine(stats, "FT", hasGames),
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
                formatShotLine(stats, "FG", played),
                formatShotLine(stats, "3PT", played),
                formatShotLine(stats, "FT", played),
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
    const scoringLine = player.scoring_profile ? `Scoring profile: ${escapeHtml(player.scoring_profile)}` : "";
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
        `Team name: ${fantasyTeam}`,
    ];
    if (scoringLine) {
        metaLines.push(scoringLine);
    }
    if (fantasyAverage) {
        metaLines.push(escapeHtml(fantasyAverage));
    }
    const actions = [];
    if (!player.fantasy_team) {
        actions.push({ key: "add", label: "Add" });
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
        .map(
            (action) =>
                `<button type="button" class="player-card__action" data-player-action="${action.key}" data-player-id="${player.id}">${escapeHtml(action.label)}</button>`,
        )
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
                        Stats Snapshot
                    </button>
                    <button type="button" class="player-card__tab" role="tab" id="player-tab-log" data-tab="log" aria-controls="player-panel-log" aria-selected="false">
                        Game Log
                    </button>
                </nav>
                <div class="player-card__panels">
                    <section class="player-card__panel player-card__section is-active" role="tabpanel" id="player-panel-stats" data-panel="stats" aria-labelledby="player-tab-stats">
                        <h3>Stats Snapshot</h3>
                        ${summaryTable}
                    </section>
                    <section class="player-card__panel player-card__section" role="tabpanel" id="player-panel-log" data-panel="log" aria-labelledby="player-tab-log" aria-hidden="true">
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

async function openPlayerModal(playerId, { leagueId = currentLeagueId, date = null } = {}) {
    if (!playerModal || !playerModalBody || !playerId) {
        return;
    }
    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add("modal-open");
    playerModal.classList.remove("hidden");
    playerModal.setAttribute("aria-hidden", "false");
    playerModalBody.innerHTML = '<div class="player-card__loading">Loading player…</div>';

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
    } catch (error) {
        const message = error.message || "Unable to load player.";
        playerModalBody.innerHTML = `<p class="player-card__empty error">${escapeHtml(message)}</p>`;
        showToast(message, "error");
    }
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
                <div class="${game.status.toLowerCase().includes("final") ? "status-final" : "status-upcoming"}">${game.status}</div>
                <div>${game.time || ""}</div>
                <div>${game.period ? `Period: ${game.period}` : ""}</div>
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
                        <td>${fmt(player.MINUTES, 1)}</td>
                        <td>${fmt(player.PTS)}</td>
                        <td>${rebounds}</td>
                        <td>${fmt(player.AST)}</td>
                        <td>${fmt(player.STL)}</td>
                        <td>${fmt(player.BLK)}</td>
                        <td>${fmt(player.FGM)}-${fmt(player.FGA)}</td>
                        <td>${fmt(player.FG3M)}-${fmt(player.FG3A)}</td>
                        <td>${fmt(player.FTM)}-${fmt(player.FTA)}</td>
                        <td>${fmt(player.TOV)}</td>
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
                            <th>${fmt(totals.MINUTES, 1)}</th>
                            <th>${fmt(totals.PTS)}</th>
                            <th>${totals.REB !== undefined ? fmt(totals.REB) : fmt((totals.OREB || 0) + (totals.DREB || 0))}</th>
                            <th>${fmt(totals.AST)}</th>
                            <th>${fmt(totals.STL)}</th>
                            <th>${fmt(totals.BLK)}</th>
                            <th>${fmt(totals.FGM)}-${fmt(totals.FGA)}</th>
                            <th>${fmt(totals.FG3M)}-${fmt(totals.FG3A)}</th>
                            <th>${fmt(totals.FTM)}-${fmt(totals.FTA)}</th>
                            <th>${fmt(totals.TOV)}</th>
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

function renderFantasyResults(result) {
    fantasyResultsEl.innerHTML = "";
    if (!result || !result.team_results || !result.team_results.length) {
        fantasyResultsEl.innerHTML = "<p>No simulation results yet. Run a simulation day to see fantasy totals.</p>";
        return;
    }
    const resultDate = result.date || "";

    result.team_results.forEach((team) => {
        const card = document.createElement("article");
        card.className = "team-card";
        card.dataset.resultDate = resultDate;

        const summary = document.createElement("div");
        summary.className = "team-summary";
        summary.innerHTML = `
            <h3>${team.team}</h3>
            <span>${team.total.toFixed(1)} pts</span>
        `;
        summary.setAttribute("role", "button");
        summary.setAttribute("tabindex", "0");

        const detail = document.createElement("div");
        detail.className = "team-detail";

        if (team.players && team.players.length) {
            const table = document.createElement("table");
            const rows = team.players
                .map((player) => {
                    const name = escapeHtml(player.player_name || "");
                    const playerId = Number(player.player_id);
                    const playerButton =
                        Number.isFinite(playerId) && playerId
                            ? `<button type="button" class="player-link" data-player-id="${playerId}" data-player-name="${name}" data-result-date="${escapeHtml(resultDate)}" data-source="fantasy">${name}</button>`
                            : name;
                    const teamLabel = escapeHtml(player.team || "");
                    const fantasy = Number.isFinite(Number(player.fantasy_points))
                        ? Number(player.fantasy_points).toFixed(1)
                        : "0.0";
                    const rowClass = `player-row ${player.played ? "played" : "did-not-play"}`;
                    return `
                        <tr class="${rowClass}">
                            <td>${playerButton}</td>
                            <td>${teamLabel}</td>
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
                        <th>Fantasy</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            `;
            detail.appendChild(table);
        } else {
            const empty = document.createElement("p");
            empty.textContent = "No players appeared today.";
            detail.appendChild(empty);
        }

        const toggle = () => {
            card.classList.toggle("active");
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

function renderLeagueState(state) {
    if (!state) {
        leagueDateEl.textContent = "—";
        leagueScoringEl.textContent = "—";
        fantasyResultsEl.innerHTML = "<p>Create a league to begin your season replay.</p>";
        simulateBtn.disabled = true;
        return;
    }

    const nextDate = state.current_date || "Season Complete";
    const latestCompleted = state.latest_completed_date ? ` (Last: ${state.latest_completed_date})` : "";
    leagueDateEl.textContent = `${nextDate}${latestCompleted}`;
    leagueScoringEl.textContent = state.scoring_profile;
    simulateBtn.disabled = !state.current_date;

    const latest = state.history && state.history.length ? state.history[state.history.length - 1] : null;
    renderFantasyResults(latest);
}

function showSetupView() {
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
        fantasyResultsEl.innerHTML = "<p>Create a league to begin your season replay.</p>";
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
        openButton.addEventListener("click", () => enterLeague(league.id));

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.textContent = "Delete";
        deleteButton.classList.add("danger");
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
        if (currentLeagueId && !leaguesCache.some((league) => league.id === currentLeagueId)) {
            currentLeagueId = null;
            leagueInitialized = false;
            showSetupView();
        }
        renderLeagueList(leaguesCache);
    } catch (error) {
        renderLeagueList([]);
        showToast(error.message || "Unable to load leagues.", "error");
    }
}

async function enterLeague(leagueId) {
    try {
        currentLeagueId = leagueId;
        await loadLeagueState(leagueId, { suppressToast: false });
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
    if (renameProfileBtn) {
        renameProfileBtn.disabled = !hasActive;
    }
    if (deleteProfileBtn) {
        deleteProfileBtn.disabled = !hasActive || totalProfiles <= 1;
    }
}

async function renameScoringProfilePrompt() {
    if (!activeProfileKey || !scoringProfiles[activeProfileKey]) {
        showToast("Select a scoring profile first.", "error");
        return;
    }
    const current = scoringProfiles[activeProfileKey];
    const response = window.prompt("Rename scoring profile:", current.name);
    if (response === null) {
        return;
    }
    const trimmed = response.trim();
    if (!trimmed) {
        showToast("Profile name cannot be empty.", "error");
        return;
    }
    if (trimmed === current.name) {
        return;
    }
    try {
        await fetchJSON(`/settings/scoring/${activeProfileKey}`, {
            method: "PATCH",
            body: JSON.stringify({ name: trimmed }),
        });
        showToast("Scoring profile renamed.", "success");
        await loadScoringProfiles();
    } catch (error) {
        showToast(error.message || "Unable to rename profile.", "error");
    }
}

async function deleteScoringProfileAction() {
    if (!activeProfileKey || !scoringProfiles[activeProfileKey]) {
        showToast("Select a scoring profile first.", "error");
        return;
    }
    if (Object.keys(scoringProfiles).length <= 1) {
        showToast("At least one scoring profile must remain.", "error");
        return;
    }
    const profile = scoringProfiles[activeProfileKey];
    const confirmed = window.confirm(`Delete scoring profile "${profile.name}"?`);
    if (!confirmed) {
        return;
    }
    if (renameProfileBtn) renameProfileBtn.disabled = true;
    if (deleteProfileBtn) deleteProfileBtn.disabled = true;
    try {
        await fetchJSON(`/settings/scoring/${activeProfileKey}`, { method: "DELETE" });
        showToast("Scoring profile deleted.", "success");
        activeProfileKey = "";
        await loadScoringProfiles();
    } catch (error) {
        showToast(error.message || "Unable to delete profile.", "error");
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
        setLeagueUI(true);
        currentLeagueId = leagueId;
        navMenuBtn.classList.remove("hidden");
        renderLeagueState(state);
        if (state.latest_completed_date) {
            scoreboardDateInput.value = state.latest_completed_date;
            await loadScoreboard(state.latest_completed_date);
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

    const teamNames = [];
    const used = new Set();
    if (userTeamName) {
        teamNames.push(userTeamName);
        used.add(userTeamName.toLowerCase());
    }
    for (let i = 1; teamNames.length < teamCount; i += 1) {
        const candidate = `Team ${i}`;
        if (!used.has(candidate.toLowerCase())) {
            teamNames.push(candidate);
            used.add(candidate.toLowerCase());
        }
    }

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
    if (!currentLeagueId) {
        showToast("Select a league first.", "error");
        return;
    }
    try {
        const result = await fetchJSON(`/leagues/${currentLeagueId}/simulate`, { method: "POST", body: JSON.stringify({}) });
        showToast(`Simulated ${result.date}`, "success");
        await loadLeagueState(currentLeagueId, { suppressToast: true });
        await loadLeaguesList();
    } catch (error) {
        showToast(error.message, "error");
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
    const rawNameInput = window.prompt("Name this scoring profile:", defaultSuggestion);
    if (rawNameInput === null) {
        return;
    }
    const rawName = rawNameInput.trim();
    if (!rawName) {
        showToast("Profile name cannot be empty.", "error");
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
        showToast("Scoring profile saved.", "success");
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
    const derivedDate =
        explicitDate ||
        (detailContainer && detailContainer.dataset.boxscoreDate) ||
        (teamCard && teamCard.dataset.resultDate) ||
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
    loadScoreboard(scoreboardDateInput.value);
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
if (renameProfileBtn) {
    renameProfileBtn.addEventListener("click", renameScoringProfilePrompt);
}
if (deleteProfileBtn) {
    deleteProfileBtn.addEventListener("click", deleteScoringProfileAction);
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


