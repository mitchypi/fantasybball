# Fantasy Replay – Quickstart Guide

A slim guide to get the Fantasy Basketball simulator running right after cloning the repository. These steps cover installing dependencies and launching the FastAPI backend plus the dashboard

## Prerequisites

- Python 3.10+ (the project is regularly tested on Python 3.11/3.12).
- `pip` available on your PATH.
- Git (for cloning).

Optional but recommended:
- A Python virtual environment manager (`venv`, `virtualenv`, `conda`, etc.).

## 1. Clone the repository

```bash
git clone git@github.com:mitchypi/fantasybball.git
cd fantasybball
```

## 2. Create & activate a virtual environment (recommended)

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate
```

If you prefer global installs, you can skip the virtual environment steps and use `python -m pip` directly.

## 3. Install dependencies

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

The dependencies include FastAPI, Uvicorn, Pandas, and other utilities required for the simulator and dashboard.

## 4. Run the FastAPI app

Start the development server with hot-reload enabled:

```bash
uvicorn src.api.main:app --reload
```

Uvicorn will listen on <http://127.0.0.1:8000> by default. The `--reload` flag lets the server restart automatically when you modify Python files.

## 5. Open the dashboard

- Visit <http://127.0.0.1:8000/dashboard> in your browser.
- The interface loads the league setup screen where you can create leagues, run drafts, simulate days, and manage bets.

Even without preloaded data, you can explore the UI and API endpoints. If you later want full historical stats, run the data download scripts documented in `design.md` or the project wiki.

## 6. Explore the API

Interactive docs are available at <http://127.0.0.1:8000/docs>. Useful checks:

- `GET /health` – confirms caches, season info, and league counts.
- `GET /leagues` – lists saved leagues once you create them from the dashboard.

## 7. Useful environment variables (optional)

Set these before launching Uvicorn if you want to override defaults:

| Variable | Purpose | Default |
| --- | --- | --- |
| `BALLDONTLIE_API_KEY` | API key for balldontlie requests | Bundled demo key |
| `ODDS_API_KEY` | Odds API key for sportsbook features | empty (betting uses cached odds if available) |
| `ODDS_BOOKMAKER` | Preferred bookmaker key | `draftkings` |

Example (Windows PowerShell):

```powershell
$env:ODDS_API_KEY="your-key"
uvicorn src.api.main:app --reload
```

## 8. Stopping the server

Press `Ctrl+C` in the terminal running Uvicorn. If you created a virtual environment, deactivate it with:

```bash
deactivate
```

---

That’s it! With these steps you can clone, install, and run the Fantasy Replay project in a few minutes. For deeper architecture notes, feature roadmaps, or data pipeline instructions, see `design.md` and `todo.md`.
