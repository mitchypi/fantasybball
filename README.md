# Fantasy Basketball Simulator (2024-25 Season Replay)

Replay the full 2024-25 NBA season with perfect information. This project pulls every player game log and final scoreboard from balldontlie once, stores it locally, and powers a Yahoo-style dashboard plus a FastAPI backend so you can manage every team in the league offline.

## Core ideas
- Offline-first cache: player game logs and game scores are saved to `data/` and reused for every simulation run.
- Multiple leagues: the menu dashboard lists every saved league; create as many "what-if" universes as you like and jump between them.
- Points league vs. 9-cat (or entirely custom): tune scoring presets in the setup view, save them for later, and apply them to future leagues.
- Single-player commissioner mode: auto-draft all teams, own every roster, and advance the fantasy calendar one day at a time.
- Web dashboard: monitor real NBA scoreboards, view fantasy box scores inline, tweak scoring formulas, and trigger simulations from the browser.

## Project layout
```
fantasybball/
├── data/                      # Cached datasets + saved leagues
├── scripts/
│   └── download_player_stats.py   # Balldontlie downloader (player logs + game scores)
├── src/
│   ├── api/
│   │   └── main.py            # FastAPI entry point + dashboard routes
│   ├── config.py              # Settings, scoring profiles, API key management
│   ├── data_loader.py         # Loaders/aggregations over cached data
│   ├── league.py              # League persistence, drafting, simulation
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

2. **Configure your API key (optional)**
   The repo defaults to the provided balldontlie key. To override it, set an environment variable before downloading:
   ```
   set BALLDONTLIE_API_KEY=your-key-here
   ```

3. **Cache every 2024-25 game log and scoreboard locally**
   ```
   python scripts/download_player_stats.py --season 2024-25
   ```
   This walks every balldontlie `stats` and `games` page for the season, respects pagination, and writes `data/player_game_logs_202425.csv` plus `data/games_202425.csv`.
   > **Heads-up:** balldontlie only exposes completed seasons. If the requested season is missing you'll see a friendly error—try `2023-24` until the new data drops.

4. **Run the FastAPI backend and dashboard**
   ```
   uvicorn src.api.main:app --reload
   ```
   - Visit `http://127.0.0.1:8000/dashboard` for the Yahoo-style control center. The menu lists every saved league and the setup form for creating a new one. Save scoring presets as needed, then press **Create League** to jump into a league. Use the **Menu** button in the header to return and switch between leagues.
   - Explore `http://127.0.0.1:8000/docs` for interactive API documentation.

5. **Try the command-line demo**
   ```
   python -m src.simulator
   ```
   The script drafts two sample teams from the cached data, scores them, and prints the winner.

## API surface
- `GET /dashboard` - interactive dashboard with scoreboard, fantasy results, and scoring editor.
- `GET /health` - readiness check and cache status.
- `GET /players` - cached season averages (filter by team, change scoring profile, adjust limit).
- `GET /leagues` - list cached leagues with metadata.
- `POST /leagues` - create a new league using the provided setup payload.
- `GET /leagues/{league_id}` - fetch the full state for a league.
- `POST /leagues/{league_id}/simulate` - advance one NBA day and compute fantasy totals for that league.
- `POST /leagues/{league_id}/reset` - rebuild the league using its original settings.
- `GET /games?league_id=...&date=YYYY-MM-DD` - NBA scoreboard for a simulated day (defaults to the league’s most recent completion).
- `GET /games/{game_id}/boxscore?league_id=...&date=YYYY-MM-DD` - detailed box score for a simulated game.
- `GET /settings/scoring` / `POST /settings/scoring` - list and update scoring profiles (points vs. nine-cat vs. custom).
- `GET /simulations/demo` - quick two-team exhibition using the current scoring mode.

## Next steps
- Persist richer league metadata (keeper rules, injuries, lineup lock) in a proper database (SQLite + SQLModel or Postgres).
- Expand the simulation engine to support weekly head-to-head matchups, playoffs, waiver wire moves, and trade validation.
- Layer in authentication or multi-league management if you want to share the dashboard across players.
- Add automated tests around scoring math, schedule traversal, and API endpoints (`pytest`, `httpx.AsyncClient`, `pytest-asyncio`).

## Data source
- [balldontlie](https://www.balldontlie.io/) – open NBA statistics API. This project caches responses locally so the web app never hits the network after the initial download.
