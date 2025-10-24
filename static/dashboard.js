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
const teamCountInput = document.getElementById("team-count");
const rosterSizeInput = document.getElementById("roster-size");
const teamNameInput = document.getElementById("team-name");
const createLeagueBtn = document.getElementById("create-league");
const setupPanel = document.getElementById("setup-panel");
const leaguePanels = document.getElementById("league-panels");
const leagueListEl = document.getElementById("league-list");
const navMenuBtn = document.getElementById("nav-menu");
const toast = document.getElementById("toast");

let scoringProfiles = {};
let availableStats = [];
let activeProfileKey = "";
let currentScoreboardDate = "";
let activeGameId = null;
let leagueInitialized = false;
let currentLeagueId = null;
let leaguesCache = [];
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
    return response.json();
}

function showToast(message, type = "success") {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    setTimeout(() => toast.classList.add("hidden"), 4000);
    requestAnimationFrame(() => toast.classList.remove("hidden"));
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
        const rows = team.players
            .map(
                (player) => `
                <tr>
                    <td>${player.player_name}</td>
                    <td>${player.MINUTES?.toFixed ? player.MINUTES.toFixed(1) : player.MINUTES ?? ""}</td>
                    <td>${player.PTS}</td>
                    <td>${player.REB ?? (player.OREB + player.DREB)}</td>
                    <td>${player.AST}</td>
                    <td>${player.STL}</td>
                    <td>${player.BLK}</td>
                    <td>${player.FGM}-${player.FGA}</td>
                    <td>${player.FG3M}-${player.FG3A}</td>
                    <td>${player.FTM}-${player.FTA}</td>
                    <td>${player.TOV}</td>
                </tr>
            `
            )
            .join("");
        const totals = team.totals;
        return `
            <div class="boxscore-team">
                <h3>${team.name} (${team.abbreviation})</h3>
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
                            <th>${totals.MINUTES?.toFixed ? totals.MINUTES.toFixed(1) : totals.MINUTES || ""}</th>
                            <th>${totals.PTS}</th>
                            <th>${totals.REB ?? (totals.OREB + totals.DREB)}</th>
                            <th>${totals.AST}</th>
                            <th>${totals.STL}</th>
                            <th>${totals.BLK}</th>
                            <th>${totals.FGM}-${totals.FGA}</th>
                            <th>${totals.FG3M}-${totals.FG3A}</th>
                            <th>${totals.FTM}-${totals.FTA}</th>
                            <th>${totals.TOV}</th>
                        </tr>
                    </tfoot>
                </table>
            </div>
        `;
    };

    detail.innerHTML = `
        <div class="boxscore-header">
            <div>
                <strong>${away.name} ${scoreboard.away_score}</strong>
                @
                <strong>${home.name} ${scoreboard.home_score}</strong>
            </div>
            <span>${boxscore.date}</span>
        </div>
        <div class="score-detail-inner">
            ${renderTeamTable(away)}
            ${renderTeamTable(home)}
        </div>
    `;
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

    result.team_results.forEach((team) => {
        const card = document.createElement("article");
        card.className = "team-card";

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
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>Player</th>
                        <th>Team</th>
                        <th>Fantasy</th>
                    </tr>
                </thead>
                <tbody>
                    ${team.players
                        .map(
                            (player) => `
                                <tr class="player-row ${player.played ? "played" : "did-not-play"}">
                                    <td>${player.player_name}</td>
                                    <td>${player.team}</td>
                                    <td>${player.fantasy_points.toFixed(1)}</td>
                                </tr>
                            `
                        )
                        .join("")}
                </tbody>
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
        ].join(" � " );
        info.innerHTML = `<strong>${league.league_name}</strong><span>${details}</span>`;
        const openButton = document.createElement("button");
        openButton.type = "button";
        openButton.textContent = "Play";
        openButton.addEventListener("click", () => enterLeague(league.id));
        li.append(info, openButton);
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
    scoringSelect.innerHTML = "";
    Object.entries(data.profiles).forEach(([key, profile]) => {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = profile.name;
        if (data.default === key) {
            option.selected = true;
            activeProfileKey = key;
        }
        scoringSelect.appendChild(option);
    });
    const activeKey = activeProfileKey || scoringSelect.value;
    if (activeKey && scoringProfiles[activeKey]) {
        populateWeightsEditor(scoringProfiles[activeKey].weights, availableStats);
        document.getElementById("scoring-key").value = `${activeKey}_copy`;
        document.getElementById("scoring-name").value = `${scoringProfiles[activeKey].name} (Custom)`;
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
            league_name: document.getElementById("scoring-name").value.trim() || "New League",
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
    const key = formData.get("key");
    const name = formData.get("name");
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
});
scoringForm.addEventListener("submit", saveScoringProfile);
createLeagueBtn.addEventListener("click", createLeague);

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


