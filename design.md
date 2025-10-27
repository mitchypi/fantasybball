# Fantasy Basketball Simulator (2024-25 Season Replay)

Replay the full 2024-25 NBA season with perfect information. This project pulls every player game log and final scoreboard from balldontlie once, stores it locally, and powers a Yahoo-style dashboard plus a FastAPI backend so you can manage every team in the league offline.

## Core ideas
- Offline-first cache: player game logs and game scores are saved to `data/` and reused for every simulation run.
- Multiple leagues: the menu dashboard lists every saved league; create as many "what-if" universes as you like and jump between them.
- Points league vs. 9-cat (or entirely custom): tune scoring presets in the setup view, save them for later, and apply them to future leagues.
- Single-player commissioner mode: auto-draft all teams, own every roster, and advance the fantasy calendar one day at a time.
- Web dashboard: monitor real NBA scoreboards, view fantasy box scores inline, tweak scoring formulas, and trigger simulations from the browser.
- Sportsbook mode: optionally cache The Odds API markets, build bet slips from the scoreboard, and let the simulator settle wagers alongside each NBA day.

## Project layout
```
fantasybball/
├── data/                      # Cached datasets + saved leagues
├── scripts/
│   ├── download_historical_odds.py  # Pull historical pre-game odds for the cached schedule
│   ├── download_odds.py             # Live odds snapshot for upcoming games
│   └── download_player_stats.py     # Balldontlie downloader (player logs + game scores)
├── src/
│   ├── api/
│   │   └── main.py            # FastAPI entry point + dashboard routes
│   ├── config.py              # Settings, scoring profiles, API key management
│   ├── data_loader.py         # Loaders/aggregations over cached data
│   ├── league.py              # League persistence, drafting, simulation
│   ├── betting.py             # Bet slips, odds helpers, settlement utilities
│   ├── models.py              # Pydantic domain models for teams and results
│   ├── player_profile.py      # League-aware player profile payload builder
│   ├── schedule.py            # Helpers for NBA schedule and scoreboards
│   ├── scoring.py             # Persistence for custom scoring profiles
│   └── simulator.py           # CLI demo (two-team head-to-head)
├── static/                    # Dashboard styles and JS
├── templates/                 # Jinja templates for the dashboard
├── requirements.txt
└── README.md
```

## Getting started
1. **Set up Python**
   ```
   py -m venv .venv
   .\.venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. **Configure your API keys (optional)**
   The repo defaults to the provided balldontlie key. To override it, set an environment variable before downloading:
   ```
   set BALLDONTLIE_API_KEY=your-key-here
   ```
   For gambling features, export your [The Odds API](https://the-odds-api.com/) key as well:
   ```
   set ODDS_API_KEY=your-odds-api-key
   ```

3. **Cache every 2024-25 game log and scoreboard locally**
   ```
   python scripts/download_player_stats.py --season 2024-25
   ```
   This walks every balldontlie `stats` and `games` page for the season, respects pagination, and writes `data/player_game_logs_202425.csv` plus `data/games_202425.csv`.
   > **Heads-up:** balldontlie only exposes completed seasons. If the requested season is missing you'll see a friendly error—try `2023-24` until the new data drops.

4. **(Optional) Cache sportsbook odds for the season**
   - For **historical seasons** (completed games):
     ```
     python scripts/download_historical_odds.py --season 2024-25 --bookmaker draftkings --overwrite
     ```
     This walks the Odds API historical endpoints day-by-day, matches events to every row in `data/games_202425.csv`, and saves the last pregame snapshot per game to `data/odds_202425.json`.
   - For **upcoming games** (today/tomorrow):
     ```
     python scripts/download_odds.py --season 2024-25 --bookmaker draftkings
     ```
   Set `ODDS_API_KEY` (or pass `--api-key`) with your [The Odds API](https://the-odds-api.com/) key before running either command. Both scripts share the same cache file, so re-run with `--overwrite` when you want a fresh pull.

5. **Run the FastAPI backend and dashboard**
   ```
   uvicorn src.api.main:app --reload
   ```
   - Visit `http://127.0.0.1:8000/dashboard` for the Yahoo-style control center. The menu lists every saved league and the setup form for creating a new one. Save scoring presets as needed, then press **Create League** to jump into a league. Use the **Menu** button in the header to return and switch between leagues.
   - Explore `http://127.0.0.1:8000/docs` for interactive API documentation.

## Drafting your team

- Creating a league with a user-controlled team now launches a draft room before the season begins. Use the player pool (season-long stats) to pick manually, or lean on **Autodraft Pick** / **Autodraft Rest** for a weighted best-available selection.
- Finish filling your roster and click **Finish Draft** to let the simulator auto-fill the remaining AI teams and unlock the season dashboard.
- Draft state enforces uniqueness across the league; you can revisit the draft summary any time via `GET /leagues/{league_id}/draft`.
- Once the draft is complete, manage your roster directly from the Players tab (Add free agents) or the player modal (Drop from your team). Those buttons call `/leagues/{id}/roster/add` and `/leagues/{id}/roster/drop` respectively.

6. **Try the command-line demo**
   ```
   python -m src.simulator
   ```
   The script drafts two sample teams from the cached data, scores them, and prints the winner.

## API Reference

All endpoints are served by the FastAPI app in `src/api/main.py`. Most endpoints return JSON. The dashboard HTML and static assets are served for convenience.

### UI and Health
- GET `/dashboard`
  - Returns the HTML dashboard (Jinja template) for interactive control.
- GET `/health`
  - Readiness and cache status.
  - Response: `{ status, players_cached, games_cached, leagues, season }`

### Players (global cache)
- GET `/players`
  - Query: `limit` (int, 1–200, default 25), `team` (abbr), `search` (substring), `scoring` (profile key)
  - Returns top players by fantasy points under the selected scoring profile: `{ scoring_profile, count, results[] }`
- GET `/players/{player_id}/profile`
  - Query: `league_id` (optional, to contextualize fantasy team membership), `date` (YYYY-MM-DD, optional; clamps to latest simulated date for the league), `scoring` (optional override)
  - Returns enriched profile with rolling summaries and game logs contextualized by scoring and date.

### Simulations (quick demo)
- GET `/simulations/demo`
  - Query: `team_size` (2–15, default 8), `scoring` (profile key)
  - Returns two auto-drafted teams and totals under the chosen scoring.

### Leagues
- GET `/leagues`
  - Returns `{ leagues: [{ id, league_name, team_count, roster_size, scoring_profile, scoring_profile_key, latest_completed_date, created_at }] }`
- POST `/leagues`
  - Body: `{ league_name?, team_count?, roster_size?, scoring_profile?, user_team_name?, team_names?[], playoffs?{ enabled?, teams?, weeks?[], reseed?, consolation? } }`
  - Creates a new league, auto-drafts all teams, and persists to `data/leagues/{id}.json`.
  - Rejects duplicate league names (case-insensitive) to prevent collisions.
  - Returns `{ league_id, state }` (see Data Model for state shape)
- GET `/playoffs/options`
  - Query: `team_count` (2–30)
  - Returns valid playoff presets for the season calendar (team counts, week ranges, round counts).
- GET `/leagues/{league_id}/playoffs/config`
  - Returns the saved playoff configuration plus the valid options for that league’s calendar.
- PATCH `/leagues/{league_id}/playoffs/config`
  - Body: `{ enabled?, teams?, weeks?[], reseed?, consolation? }`
  - Updates playoff settings while the league is still in the regular season.
- POST `/leagues/{league_id}/playoffs/simulate`
  - Simulates day-by-day until the configured playoff window begins (fails if playoffs are disabled or already started).
- GET `/leagues/{league_id}/playoffs`
  - Returns the current playoff bracket (or preview if playoffs have not begun yet). Once the finals complete the payload includes `placements` (champion, runner-up, remaining finishers) and `finalized_at` (ISO date).
- GET `/leagues/{league_id}`
  - Returns the full serialized state for the league.
- GET `/leagues/{league_id}/draft`
  - Query: `view` (`averages|totals`, default `averages`) — controls whether fantasy/stat values are per-game or season totals.
  - Returns draft status, roster progress, and the user team’s current picks. 404s once the draft is complete.
- GET `/leagues/{league_id}/draft/players`
  - Query: `limit` (1–200, default 25), `offset`, `search`, `view` (`averages|totals`, default `averages`)
  - Returns the sorted draft pool with `taken` flags for unavailable players plus remaining slot counts. Payload always includes both per-game and total fields so the UI can toggle without re-drafting.
- POST `/leagues/{league_id}/draft/pick`
  - Body: `{ player_id }`
  - Query: `view` (`averages|totals`, default `averages`) to match the draft board display in the response.
  - Assigns the specified player to the user team (honors roster size and taken checks).
- POST `/leagues/{league_id}/draft/autopick`
  - Query: `view` (`averages|totals`, default `averages`) to shape the payload for the active display.
  - Auto-selects the best available player for the next pick (user or CPU based on turn).
- POST `/leagues/{league_id}/draft/autopick/rest`
  - Query: `view` (`averages|totals`, default `averages`) to align the summary payload.
  - Auto-drafts the remaining slots for every team using the current scoring profile.
- POST `/leagues/{league_id}/draft/complete`
  - Query: `view` (`averages|totals`, default `averages`) to return the completion summary in the chosen format.
  - Finalizes the draft and unlocks the regular season flow.
- DELETE `/leagues/{league_id}` (204)
  - Deletes a single league file.
- DELETE `/leagues`
  - Deletes all leagues. Returns `{ deleted, errors }` with any failures keyed by id.
- POST `/leagues/{league_id}/simulate`
  - Body: `{ scoring_profile? }` (optional override for the simulation day)
  - Simulates the current NBA day for the league, computes fantasy totals, appends to history. Returns the day record.
- POST `/leagues/{league_id}/advance`
  - Advances the league’s current date. Requires that the current day has been simulated first.
- POST `/leagues/{league_id}/autoplay`
  - Simulates and advances every remaining day until the season ends (draft must be finished first).
- POST `/leagues/{league_id}/reset`
  - Rebuilds the league using its original settings (re-drafts based on current scoring).
- GET `/leagues/{league_id}/weeks`
  - Returns a week-by-week overview (Monday–Sunday windows; Week 1 is season start to its first Sunday) and head-to-head standings.
- GET `/leagues/{league_id}/players`
  - Query: `date` (YYYY-MM-DD, optional), `view` (`totals|averages`, default `totals`), `filter` (`all|available|unavailable`), `search`, `sort` (stat key), `order` (`asc|desc`), `limit` (<=1000), `offset`
  - Lists players through the latest simulated date (or clamped to given date) with fantasy totals/averages under the league scoring. Flags availability based on fantasy rosters.
- GET `/leagues/{league_id}/teams/daily`
  - Query: `team` (defaults to user team), `date` (YYYY-MM-DD; defaults to latest simulated)
  - Returns per-player daily fantasy breakdown and team total for that date.
- POST `/leagues/{league_id}/roster/add`
  - Body: `{ player_id }`
  - Adds a player to the user team if roster space permits and player is available. Returns updated counts.
- POST `/leagues/{league_id}/roster/drop`
  - Body: `{ player_id }`
  - Removes a player from the user roster and updates the persisted league state.
- GET `/leagues/{league_id}/bankroll`
  - Returns `{ bankroll: { available, pending_stake, pending_potential, pending_count, settled_count } }` for the league's betting wallet.
- GET `/leagues/{league_id}/bets`
  - Query: `status` (`pending|settled`, optional)
  - Lists bet slips for the league, grouped into pending and settled collections.
- POST `/leagues/{league_id}/bets`
  - Body: `{ stake, kind: "single"|"parlay", legs: [{ game_id, market, selection, price, point? }] }`
  - Debits the bankroll, records a new slip (validates against cached odds when available), and returns the refreshed pending list plus bankroll summary.

### Games and Box Scores
- GET `/games`
  - Query: `league_id` (required), `date` (YYYY-MM-DD, optional)
  - Returns NBA scoreboard for the given or effective date with `simulated` flags and (when present) `bet_results` summarising slips settled on that day.
- GET `/games/{game_id}/boxscore`
  - Query: `league_id` (required), `date` (YYYY-MM-DD, optional)
  - Returns per-team player lines and stat totals for that simulated game.

### Scoring Profiles
- GET `/settings/scoring`
  - Returns `{ default, profiles: { key: { name, weights } } }` (merged with any persisted `data/scoring_profiles.json`).
- POST `/settings/scoring`
  - Body: `{ key, name, weights{...}, make_default? }`
  - Creates or updates a scoring profile (weights are uppercased and merged with sensible defaults). Persists to `data/scoring_profiles.json`.
- PATCH `/settings/scoring/{key}`
  - Body: `{ name }` — Renames a profile.
- DELETE `/settings/scoring/{key}` (204)
  - Deletes a profile; if it was default, re-points to a fallback.

### Utilities
- GET `/team_names`
  - Query: `count` (1–50, default 10), `exclude` (repeatable)
  - Returns random team name suggestions sourced from `data/fantasy_team_names.csv`.

### Common Errors
- 400: invalid inputs (e.g., bad date format, roster full, unknown scoring key)
- 404: missing league, game not found for date, no simulated games yet
- 503: cache not ready — run the downloader script first

## Data Model

This section summarizes the primary JSON shapes the API returns. Exact fields may include additional computed stats; consider these stable keys.

### League State
Emitted by `GET /leagues/{league_id}` and after mutations such as advance/reset.

```jsonc
{
  "league_id": "a1b2c3",
  "league_name": "New League",
  "user_team_name": "Know-It-Alls",          // optional
  "team_count": 12,
  "roster_size": 13,
  "team_names": ["Know-It-Alls", "Time Travelers", "…"],
  "scoring_profile_key": "points_league",
  "scoring_profile": "Points league (balanced)",
  "created_at": "2024-10-22T12:34:56Z",
  "calendar": ["2024-10-22", "2024-10-23", "…"],
  "current_index": 0,
  "current_date": "2024-10-22",
  "latest_completed_date": null,
  "rosters": { "Know-It-Alls": [201939, 203999, "…"], "…": [ ] },
  "weeks": [
    { "index": 1, "name": "Week 1", "start": "2024-10-22", "end": "2024-10-27", "status": "not_started", "matchups": [ { "id": "week1-matchup0", "teams": [{"name":"…"},{"name":"…"}] } ] }
  ],
  "weekly_results": { "week1-matchup0": { /* rolling totals, players, daily totals */ } },
  "history": [
    {
      "date": "2024-10-22",
      "scoring_profile": "Points league (balanced)",
      "week_index": 1,
      "team_results": [ { "team": "Know-It-Alls", "total": 123.4, "players": [ { "player_id": 201939, "fantasy_points": 40.5, "played": true, "team": "GSW", "player_name": "Stephen Curry" } ] } ],
      "nba_scoreboard": [ { "game_id": 123, "home_team": "GSW", "away_team": "LAL", "status": "Final", "home_score": 110, "away_score": 104, "date": "2024-10-22", "simulated": true } ]
    }
  ],
  "awaiting_simulation": true,
  "phase": "regular",
  "playoffs_config": { "enabled": false, "teams": null, "weeks": [], "reseed": false, "consolation": false },
  "playoffs": null
}
```

When playoffs have finished, `phase` is `"finished"`, `playoffs` contains the completed bracket, and simulation/advance endpoints return an error if called.

### Week Overview and Standings
Emitted by `GET /leagues/{league_id}/weeks`.

```jsonc
{
  "current_week_index": 1,
  "weeks": [
    {
      "index": 1,
      "name": "Week 1",
      "start": "2024-10-22",
      "end": "2024-10-27",
      "status": "in_progress|completed|not_started",
      "matchups": [
        {
          "id": "week1-matchup0",
          "status": "in_progress",
          "teams": [
            { "name": "Know-It-Alls", "total": 321.0, "players": [ { "player_id": 201939, "fantasy_points": 120.4, "games_played": 3 } ], "daily_totals": [ { "date": "2024-10-22", "total": 100.5 } ] },
            { "name": "Time Travelers", "total": 287.5, "players": [ /* … */ ], "daily_totals": [ /* … */ ] }
          ],
          "days": ["2024-10-22", "2024-10-23"],
          "leader": "Know-It-Alls"
        }
      ]
    }
  ],
  "standings": [ { "team": "Know-It-Alls", "wins": 1, "losses": 0, "ties": 0, "points_for": 321.0, "points_against": 287.5 } ]
}
```

### Player Profile
Emitted by `GET /players/{player_id}/profile`.

```jsonc
{
  "player": {
    "id": 201939,
    "name": "Stephen Curry",
    "positions": ["PG"],
    "team_abbreviation": "GSW",
    "team_name": "Golden State Warriors",
    "image_url": "https://…",
    "fantasy_team": "Know-It-Alls",         // if in the league
    "season_rank": 5,                         // among all players through target date
    "season_fantasy_avg": 42.1,
    "scoring_profile": "Points league (balanced)"
  },
  "summary": [
    { "label": "Today", "games_played": 1, "fantasy_points_total": 45.0, "stats": { "PTS": 30, "REB": 5, "AST": 8, "…": 0 } },
    { "label": "Last 7 Days (avg)", "games_played": 3, "fantasy_points_avg": 41.2, "stats": { /* averages */ } },
    { "label": "Last 14 Days (avg)", /* … */ }
  ],
  "game_log": [ { "game_id": 123, "date": "2024-10-22", "fantasy_points": 45.0, "stats": { /* box line */ }, "matchup": "vs LAL", "result": "W 110-104" } ],
  "target_date": "2024-11-01",
  "league_id": "a1b2c3"
}
```

### League Players Listing
Emitted by `GET /leagues/{league_id}/players`.

```jsonc
{
  "date": "2024-10-25",
  "view": "totals",
  "sort": "fantasy",
  "order": "desc",
  "filter": "available",
  "count": 250,
  "scoring_profile": "Points league (balanced)",
  "results": [
    { "player_id": 201939, "player_name": "Stephen Curry", "team": "GSW", "fantasy": 123.4, "GP": 3, "MIN": 102, "PTS": 93, "REB": 12, "AST": 27, "STL": 6, "BLK": 0, "FGM": 30, "FGA": 65, "FG_PCT": 46.2, "FG3M": 15, "FG3A": 40, "FG3_PCT": 37.5, "FTM": 18, "FTA": 19, "FT_PCT": 94.7, "TOV": 10, "PF": 5, "fantasy_team": "Know-It-Alls", "available": false }
  ]
}
```

### Team Daily Breakdown
Emitted by `GET /leagues/{league_id}/teams/daily`.

```jsonc
{
  "league_id": "a1b2c3",
  "date": "2024-10-25",
  "team": {
    "name": "Know-It-Alls",
    "total": 140.5,
    "players": [ { "player_id": 201939, "player_name": "Stephen Curry", "team": "GSW", "date": "2024-10-25", "matchup": "@ LAL", "time_result": "Final", "fantasy_points": 45.0, "played": true, "PTS": 30, "REB": 5, "AST": 8, "…": 0 } ]
  }
}
```

### Games and Box Score
Emitted by `GET /games` and `GET /games/{game_id}/boxscore`.

```jsonc
// /games
{ "date": "2024-10-22", "games": [ { "game_id": 123, "home_team": "GSW", "away_team": "LAL", "status": "Final", "home_score": 110, "away_score": 104, "period": 4, "time": "Final", "winner": "GSW", "simulated": true } ], "current_date": "2024-10-22", "awaiting_simulation": false }

// /games/{game_id}/boxscore
{ "date": "2024-10-22", "league_id": "a1b2c3", "game_id": 123, "simulated": true, "scoreboard": { /* same as above */ }, "home_team": { "abbreviation": "GSW", "name": "Golden State Warriors", "players": [ { "player_id": 201939, "player_name": "Stephen Curry", "PTS": 30, "REB": 5, "AST": 8, "STL": 2, "BLK": 0, "FGM": 10, "FGA": 20, "FG3M": 5, "FG3A": 12, "FTM": 5, "FTA": 5, "TOV": 3, "MINUTES": 34 } ], "totals": { /* team totals */ } }, "away_team": { /* same shape */ } }
```

### Scoring Profiles
Emitted by `GET /settings/scoring`.

```jsonc
{ "default": "points_league", "profiles": { "points_league": { "name": "Points league (balanced)", "weights": { "PTS": 1.0, "AST": 1.5, "STL": 3.0, "BLK": 3.0, "FGA": -0.45, "FTA": -0.75, "TO": -1.0, "DD": 3.0, "TD": 5.0, "…": 0.0 } }, "nine_cat": { "name": "Nine category rotisserie", "weights": { /* … */ } } } }
```

## Architecture & Design

- FastAPI backend (`src/api/main.py`)
  - Stateless API over cached CSVs with lightweight JSON persistence per league.
  - Jinja2 templates and static files power a single-page style dashboard at `/dashboard`.
- Data loading (`src/data_loader.py`)
  - Reads `data/player_game_logs_*.csv` and `data/games_*.csv`, normalizes aliases (e.g., `FG3M`→`3PM`, `MINUTES`→`MPG`), and computes per-player averages.
  - Adds derived flags for double-doubles/triple-doubles.
- League engine (`src/league.py`)
  - JSON persistence to `data/leagues/{id}.json` with an explicit calendar of season dates and weekly Monday–Sunday windows (Week 1 starts on season tip-off).
  - Auto-drafting assigns top fantasy scorers round-robin to requested team names or suggested names.
  - Simulating a day computes team totals from per-game fantasy points and stores an NBA scoreboard snapshot for that date.
  - Weekly results aggregate daily contributions and expose standings for head-to-head.
- Scoring profiles (`src/config.py`, `src/scoring.py`)
  - Built-in presets: `points_league`, `nine_cat`. Profiles are merged and persisted to `data/scoring_profiles.json` on change.
  - Unknown weights are uppercased and defaulted to `0.0` unless specified.
- Schedule helpers (`src/schedule.py`)
  - Produces daily scoreboards and normalized `GameSummary` rows.
- Player profile (`src/player_profile.py`)
  - Builds a rich, date-aware player view with rolling windows (day/7/14/30/season), matchup metadata, and league context.
- Domain models (`src/models.py`)
  - Pydantic wrappers for season stats, fantasy teams, and simulation summaries shared by the API and CLI demo.

### Persistence Model
- Leagues are stored one-per-file under `data/leagues/` and include rosters, history, weekly structures, and results. This makes the app offline-first and easy to back up or share.
- Scoring presets are saved to `data/scoring_profiles.json` and merged into in-memory settings on startup.

### Pre-requisites and Limits
- You must run the downloader once per season before using most endpoints: `python scripts/download_player_stats.py --season 2024-25`.
- The API clamps query dates to the latest simulated date within a league where appropriate.
- Large CSVs are processed with pandas; most responses are filtered and paginated to keep results snappy.

## Development Notes
- Run locally: `uvicorn src.api.main:app --reload` and visit `/docs` for interactive OpenAPI.
- Formatting/testing are not enforced; suggested stack: `ruff`, `black`, `pytest`, `httpx`.
- Known limitations:
  - Roster management is still lightweight (add/drop only; trades and waivers remain TODO).
  - Error 503 indicates missing caches; 400/404 communicate invalid input or not-found resources.

## Next steps
- Persist richer league metadata (keeper rules, injuries, lineup lock) in a proper database (SQLite + SQLModel or Postgres).
- Expand the simulation engine to support weekly head-to-head matchups, playoffs, waiver wire moves, and trade validation.
- Layer in authentication or multi-league management if you want to share the dashboard across players.
- Add automated tests around scoring math, schedule traversal, and API endpoints (`pytest`, `httpx.AsyncClient`, `pytest-asyncio`).

## Data source
- [balldontlie](https://www.balldontlie.io/) – open NBA statistics API. This project caches responses locally so the web app never hits the network after the initial download.
