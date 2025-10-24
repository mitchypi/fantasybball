from __future__ import annotations

from datetime import datetime, date
import uuid
from typing import Any, Dict, Optional

import pandas as pd
from fastapi import Body, FastAPI, HTTPException, Query, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from ..config import DATA_DIR, settings
from ..data_loader import (
    compute_fantasy_points,
    load_game_schedule,
    load_player_game_logs,
    player_season_averages,
)
from ..league import (
    delete_league_state,
    initialize_league,
    list_leagues,
    load_league_state,
    reset_league_state,
    save_league_state,
    simulate_day,
)
from ..schedule import daily_scoreboard, season_dates
from ..scoring import delete_scoring_profile, rename_scoring_profile, update_scoring_profile
from ..player_profile import build_player_profile_payload, build_team_lookup, load_player_images
from ..simulator import create_demo_teams, simulate_head_to_head

app = FastAPI(
    title="Fantasy Basketball Simulator API",
    version="0.1.0",
    description="Offline-first fantasy basketball simulator powered by cached 2024-25 balldontlie data.",
)

PLAYER_BASE: Optional[pd.DataFrame] = None
GAME_LOGS: Optional[pd.DataFrame] = None
SCHEDULE_BASE: Optional[pd.DataFrame] = None
PLAYER_IMAGES: Dict[str, str] = {}
TEAM_LOOKUP: Dict[str, str] = {}

BASE_DIR = DATA_DIR.parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


def _ensure_player_base() -> pd.DataFrame:
    if PLAYER_BASE is None:
        raise HTTPException(
            status_code=503,
            detail="Player game logs are not cached yet. Run `python scripts/download_player_stats.py --season 2024-25` first.",
        )
    return PLAYER_BASE


def _ensure_game_logs() -> pd.DataFrame:
    if GAME_LOGS is None:
        raise HTTPException(
            status_code=503,
            detail="Player game logs are not cached yet. Run `python scripts/download_player_stats.py --season 2024-25` first.",
        )
    return GAME_LOGS


def _ensure_schedule() -> pd.DataFrame:
    if SCHEDULE_BASE is None:
        raise HTTPException(
            status_code=503,
            detail="Game schedule is not cached yet. Run `python scripts/download_player_stats.py --season 2024-25` first.",
        )
    return SCHEDULE_BASE


def _find_history_entry(state, target_date: date) -> Optional[Dict[str, Any]]:
    iso_target = target_date.isoformat()
    for record in state.history:
        if record.get("date") == iso_target:
            return record
    return None


def _find_fantasy_team(state, player_id: int) -> Optional[str]:
    for team_name, roster in (state.rosters or {}).items():
        try:
            if player_id in roster:
                return team_name
        except TypeError:
            continue
    return None


@app.on_event("startup")
def load_cached_data() -> None:
    global PLAYER_BASE  # pylint: disable=global-statement
    global GAME_LOGS  # pylint: disable=global-statement
    global SCHEDULE_BASE  # pylint: disable=global-statement
    global PLAYER_IMAGES  # pylint: disable=global-statement
    global TEAM_LOOKUP  # pylint: disable=global-statement
    try:
        GAME_LOGS = load_player_game_logs()
    except FileNotFoundError as err:
        PLAYER_BASE = None
        GAME_LOGS = None
        print(f"[startup] Cached data missing: {err}")  # noqa: T201 (debug print)
    else:
        PLAYER_BASE = player_season_averages(GAME_LOGS)
        print(f"[startup] Loaded player averages for {len(PLAYER_BASE)} players.")  # noqa: T201
    try:
        SCHEDULE_BASE = load_game_schedule()
    except FileNotFoundError as err:
        SCHEDULE_BASE = None
        print(f"[startup] Game schedule missing: {err}")  # noqa: T201
        TEAM_LOOKUP = {}
    else:
        TEAM_LOOKUP = build_team_lookup(SCHEDULE_BASE)
    try:
        PLAYER_IMAGES = load_player_images()
    except Exception as err:  # noqa: BLE001
        PLAYER_IMAGES = {}
        print(f"[startup] Unable to load player images: {err}")  # noqa: T201


@app.get("/health")
def healthcheck() -> Dict[str, Any]:
    players_available = PLAYER_BASE is not None
    schedule_available = SCHEDULE_BASE is not None
    return {
        "status": "ok" if players_available and schedule_available else "warming_up",
        "players_cached": 0 if PLAYER_BASE is None else int(len(PLAYER_BASE)),
        "games_cached": 0 if SCHEDULE_BASE is None else int(len(SCHEDULE_BASE)),
        "leagues": len(list_leagues()),
        "season": settings.season,
    }


@app.get("/players")
def list_players(
    limit: int = Query(25, ge=1, le=200),
    team: Optional[str] = Query(None, description="Filter by team abbreviation (e.g. BOS, LAL)."),
    search: Optional[str] = Query(None, description="Case-insensitive substring match on player name."),
    scoring: Optional[str] = Query(None, description="Scoring profile key (defaults to settings default)."),
) -> Dict[str, Any]:
    base_df = _ensure_player_base()
    scoring_profile = settings.resolve_scoring_profile(scoring)
    fantasy_df = compute_fantasy_points(base_df, scoring_profile.weights)

    if team:
        fantasy_df = fantasy_df[fantasy_df["TEAM_ABBREVIATION"].str.upper() == team.upper()]
    if search:
        fantasy_df = fantasy_df[fantasy_df["PLAYER_NAME"].str.contains(search, case=False, na=False)]

    fantasy_df = fantasy_df.sort_values("FANTASY_POINTS", ascending=False)
    limited = fantasy_df.head(limit)
    return {
        "scoring_profile": scoring_profile.name,
        "count": int(len(fantasy_df)),
        "results": limited.to_dict(orient="records"),
    }


@app.get("/simulations/demo")
def demo_simulation(
    team_size: int = Query(8, ge=2, le=15),
    scoring: Optional[str] = Query(None, description="Scoring profile key."),
) -> Dict[str, Any]:
    base_df = _ensure_player_base()
    scoring_profile = settings.resolve_scoring_profile(scoring)
    draft = create_demo_teams(base_df, team_size=team_size, scoring_name=scoring)
    result = simulate_head_to_head((draft.team_a, draft.team_b), scoring_name=scoring)
    return {
        "scoring_profile": result.scoring_profile,
        "teams": [
            {
                "name": draft.team_a.name,
                "players": [
                    {
                        "player_id": player.player_id,
                        "player_name": player.player_name,
                        "team": player.team_abbreviation,
                        "fantasy_points": player.fantasy_points(scoring_profile.weights),
                    }
                    for player in draft.team_a.players
                ],
            },
            {
                "name": draft.team_b.name,
                "players": [
                    {
                        "player_id": player.player_id,
                        "player_name": player.player_name,
                        "team": player.team_abbreviation,
                        "fantasy_points": player.fantasy_points(scoring_profile.weights),
                    }
                    for player in draft.team_b.players
                ],
            },
        ],
        "totals": result.team_totals,
        "winner": result.winning_team(),
    }


@app.get("/players/{player_id}/profile")
def get_player_profile(
    player_id: int,
    league_id: Optional[str] = Query(
        None, description="Optional league identifier to contextualize fantasy data."
    ),
    date_query: Optional[str] = Query(
        None, alias="date", description="Limit stats to games on or before this YYYY-MM-DD date."
    ),
    scoring: Optional[str] = Query(
        None, description="Override scoring profile key (defaults to league or global default)."
    ),
) -> Dict[str, Any]:
    game_logs = _ensure_game_logs()
    schedule_df = _ensure_schedule()

    requested_date: Optional[date] = None
    if date_query:
        try:
            requested_date = datetime.fromisoformat(date_query).date()
        except ValueError as err:
            raise HTTPException(status_code=400, detail="Invalid date format; expected YYYY-MM-DD.") from err

    scoring_profile_key = scoring
    scoring_profile = None
    scoring_name: Optional[str] = None
    scoring_weights: Dict[str, float] = {}
    target_date: Optional[date] = requested_date
    fantasy_team_name: Optional[str] = None
    state = None

    if league_id:
        try:
            state = load_league_state(league_id)
        except FileNotFoundError as err:
            raise HTTPException(status_code=404, detail=str(err)) from err

        scoring_profile_key = scoring_profile_key or state.scoring_profile_key
        scoring_profile = settings.resolve_scoring_profile(scoring_profile_key)
        if scoring and scoring != state.scoring_profile_key:
            scoring_name = scoring_profile.name
        else:
            scoring_name = state.scoring_profile

        scoring_weights = scoring_profile.weights
        latest_completed = state.history[-1]["date"] if state.history else None
        if latest_completed:
            latest_date = datetime.fromisoformat(latest_completed).date()
            target_date = min(requested_date, latest_date) if requested_date else latest_date
        elif requested_date is None:
            # No games have been simulated yet; nothing to show.
            raise HTTPException(status_code=404, detail="No simulated games yet for this league.")

        fantasy_team_name = _find_fantasy_team(state, player_id)
    else:
        scoring_profile = settings.resolve_scoring_profile(scoring_profile_key)
        scoring_name = scoring_profile.name
        scoring_weights = scoring_profile.weights

    if scoring_profile is None:
        scoring_profile = settings.resolve_scoring_profile(scoring_profile_key)
        scoring_name = scoring_profile.name
        scoring_weights = scoring_profile.weights

    images = PLAYER_IMAGES or load_player_images()
    team_lookup = TEAM_LOOKUP or build_team_lookup(schedule_df)

    try:
        payload = build_player_profile_payload(
            player_id,
            game_logs=game_logs,
            schedule_df=schedule_df,
            scoring_name=scoring_name,
            scoring_weights=scoring_weights,
            target_date=target_date,
            player_images=images,
            team_lookup=team_lookup,
            fantasy_team_name=fantasy_team_name,
        )
    except ValueError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err

    if state is not None:
        payload.setdefault("player", {})["user_team"] = state.user_team_name
    payload["league_id"] = league_id
    return payload


@app.get("/games")
def list_games(
    league_id: str = Query(..., description="League identifier"),
    date_query: Optional[str] = Query(
        None, alias="date", description="Target date in YYYY-MM-DD format (defaults to league current date)."
    ),
) -> Dict[str, Any]:
    try:
        state = load_league_state(league_id)
    except FileNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err

    if date_query:
        target_date = datetime.fromisoformat(date_query).date()
    else:
        if state.history:
            target_date = datetime.fromisoformat(state.history[-1]["date"]).date()
        else:
            schedule_df = _ensure_schedule()
            target_date = season_dates(schedule_df=schedule_df)[0]

    history_entry = _find_history_entry(state, target_date)
    games = history_entry.get("nba_scoreboard", []) if history_entry else []
    return {"date": target_date.isoformat(), "games": games}


@app.get("/settings/scoring")
def get_scoring_profiles() -> Dict[str, Any]:
    return {
        "default": settings.default_scoring_profile,
        "profiles": {
            key: {
                "name": profile.name,
                "weights": profile.weights,
            }
            for key, profile in settings.scoring_profiles.items()
        },
    }


@app.get("/leagues")
def list_leagues_endpoint() -> Dict[str, Any]:
    return {"leagues": list_leagues()}


@app.post("/leagues")
def create_league_endpoint(payload: Dict[str, Any]) -> Dict[str, Any]:
    league_name = (payload.get("league_name") or "New League").strip() or "New League"
    team_count = int(payload.get("team_count", 12))
    roster_size = int(payload.get("roster_size", 13))
    scoring_profile_key = payload.get("scoring_profile") or settings.default_scoring_profile
    user_team_name = payload.get("user_team_name") or None
    team_names = payload.get("team_names") or []
    if isinstance(team_names, str):
        team_names = [team_names]
    state = initialize_league(
        league_name=league_name,
        team_count=team_count,
        roster_size=roster_size,
        scoring_profile_key=scoring_profile_key,
        user_team_name=user_team_name,
        team_names=team_names,
    )
    return {"league_id": state.league_id, "state": state.to_dict()}


@app.delete("/leagues/{league_id}", status_code=204)
def delete_league_endpoint(league_id: str) -> Response:
    try:
        delete_league_state(league_id)
    except FileNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    return Response(status_code=204)


@app.get("/leagues/{league_id}")
def get_league_state_endpoint(league_id: str) -> Dict[str, Any]:
    state = load_league_state(league_id)
    return state.to_dict()


@app.post("/leagues/{league_id}/simulate")
def simulate_league_day(league_id: str, scoring_profile: Optional[str] = Body(None, embed=True)) -> Dict[str, Any]:
    state = load_league_state(league_id)
    if GAME_LOGS is None or PLAYER_BASE is None or SCHEDULE_BASE is None:
        raise HTTPException(status_code=503, detail="Cached data not ready. Run the data download script first.")
    result = simulate_day(
        state,
        game_logs=GAME_LOGS,
        player_stats=PLAYER_BASE,
        scoring_profile_key=scoring_profile,
        schedule_df=SCHEDULE_BASE,
    )
    save_league_state(state)
    return result


@app.post("/leagues/{league_id}/reset")
def reset_league_endpoint(league_id: str) -> Dict[str, Any]:
    state = load_league_state(league_id)
    reset_league_state(state, GAME_LOGS)
    return state.to_dict()


@app.get("/games/{game_id}/boxscore")
def get_game_boxscore(
    game_id: int,
    league_id: str = Query(..., description="League identifier"),
    date_query: Optional[str] = Query(None, alias="date", description="Date in YYYY-MM-DD format."),
) -> Dict[str, Any]:
    try:
        state = load_league_state(league_id)
    except FileNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err

    if not state.history:
        raise HTTPException(status_code=404, detail="No simulated games available yet.")

    if date_query:
        target_date = datetime.fromisoformat(date_query).date()
    else:
        target_date = datetime.fromisoformat(state.history[-1]["date"]).date()

    history_entry = _find_history_entry(state, target_date)
    if history_entry is None:
        raise HTTPException(status_code=404, detail="No simulated games for that date.")

    scoreboard_entry = next((game for game in history_entry.get("nba_scoreboard", []) if int(game.get("game_id")) == game_id), None)
    if scoreboard_entry is None:
        raise HTTPException(status_code=404, detail="Game not found for that date.")

    game_logs = _ensure_game_logs()
    schedule_df = _ensure_schedule()
    try:
        schedule_row = schedule_df.loc[schedule_df["GAME_ID"] == game_id].iloc[0]
    except IndexError as err:
        raise HTTPException(status_code=404, detail="Game metadata missing from schedule.") from err

    day_logs = game_logs[
        (game_logs["GAME_DATE"].dt.date == target_date)
        & (game_logs["GAME_ID"] == game_id)
    ]
    if day_logs.empty:
        raise HTTPException(status_code=404, detail="Box score data unavailable for this game.")

    home_abbr = schedule_row.get("HOME_TEAM_ABBREVIATION") or scoreboard_entry.get("home_team")
    away_abbr = schedule_row.get("VISITOR_TEAM_ABBREVIATION") or scoreboard_entry.get("away_team")
    home_full = schedule_row.get("HOME_TEAM_FULL_NAME", home_abbr)
    away_full = schedule_row.get("VISITOR_TEAM_FULL_NAME", away_abbr)

    stat_fields = [
        "PTS",
        "OREB",
        "DREB",
        "REB",
        "AST",
        "STL",
        "BLK",
        "FGM",
        "FGA",
        "FG3M",
        "FG3A",
        "FTM",
        "FTA",
        "TOV",
        "MINUTES",
    ]

    def _serialize_players(team_abbr: str) -> Dict[str, Any]:
        team_logs = day_logs[day_logs["TEAM_ABBREVIATION"] == team_abbr].copy()
        if team_logs.empty:
            return {"players": [], "totals": {field: 0 for field in stat_fields}}
        players = []
        for row in team_logs.to_dict(orient="records"):
            players.append(
                {
                    "player_id": int(row.get("PLAYER_ID")),
                    "player_name": row.get("PLAYER_NAME"),
                    **{field: float(row.get(field, 0.0)) for field in stat_fields},
                }
            )
        players.sort(key=lambda item: item["PTS"], reverse=True)
        totals = {field: float(team_logs[field].sum()) if field in team_logs.columns else 0.0 for field in stat_fields}
        return {"players": players, "totals": totals}

    return {
        "date": target_date.isoformat(),
        "league_id": league_id,
        "game_id": int(game_id),
        "simulated": True,
        "scoreboard": scoreboard_entry,
        "home_team": {
            "abbreviation": home_abbr,
            "name": home_full,
            **_serialize_players(home_abbr),
        },
        "away_team": {
            "abbreviation": away_abbr,
            "name": away_full,
            **_serialize_players(away_abbr),
        },
    }


@app.post("/settings/scoring")
def create_or_update_scoring_profile(
    payload: Dict[str, Any] = Body(
        ...,
        example={
            "key": "custom_points",
            "name": "Custom Points",
            "weights": {"PTS": 1.0, "REB": 1.2, "AST": 1.5},
            "make_default": True,
        },
    ),
) -> Dict[str, Any]:
    key = payload.get("key")
    if not key:
        raise HTTPException(status_code=400, detail="Missing 'key' in request body.")
    name = payload.get("name") or key
    weights = payload.get("weights") or {}
    if not weights:
        raise HTTPException(status_code=400, detail="Weights payload cannot be empty.")

    make_default = bool(payload.get("make_default", False))
    profile = update_scoring_profile(key, name, weights, make_default=make_default)
    return {
        "key": key,
        "name": profile.name,
        "weights": profile.weights,
        "default": make_default or settings.default_scoring_profile == key,
    }


@app.patch("/settings/scoring/{key}")
def rename_scoring_profile_endpoint(key: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    new_name = payload.get("name")
    if not new_name or not str(new_name).strip():
        raise HTTPException(status_code=400, detail="Missing or empty 'name' in request body.")
    try:
        profile = rename_scoring_profile(key, str(new_name).strip())
    except KeyError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return {
        "key": key,
        "name": profile.name,
        "weights": profile.weights,
        "default": settings.default_scoring_profile == key,
    }


@app.delete("/settings/scoring/{key}", status_code=204)
def delete_scoring_profile_endpoint(key: str) -> Response:
    try:
        delete_scoring_profile(key)
    except KeyError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return Response(status_code=204)


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "season": settings.season,
        },
    )
