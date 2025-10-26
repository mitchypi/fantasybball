from __future__ import annotations

from datetime import datetime, date
import uuid
from typing import Any, Dict, Optional, List, Tuple

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
    advance_league_day,
    build_week_overview,
    compute_head_to_head_standings,
    _load_team_name_pool,
    initialize_league,
    list_leagues,
    load_league_state,
    save_league_state,
    reset_league_state,
    simulate_day,
    draft_remaining_slots,
    draft_pick_player,
    draft_autodraft_current,
    draft_autodraft_rest,
    finalize_draft,
    remove_player_from_roster,
)
from ..schedule import daily_scoreboard, season_dates, format_period_label
from ..scoring import delete_scoring_profile, rename_scoring_profile, update_scoring_profile
from ..player_profile import build_player_profile_payload, build_team_lookup, load_player_images, _resolve_game_meta
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


def _league_effective_date(state) -> Optional[date]:
    if state.history:
        try:
            return datetime.fromisoformat(state.history[-1]["date"]).date()
        except Exception:  # noqa: BLE001
            return None
    return None


def _fantasy_team_lookup(state) -> Dict[int, str]:
    mapping: Dict[int, str] = {}
    for team_name, roster in (state.rosters or {}).items():
        for pid in roster or []:
            try:
                mapping[int(pid)] = team_name
            except Exception:  # noqa: BLE001
                continue
    return mapping


def _find_fantasy_team(state, player_id: int) -> Optional[str]:
    for team_name, roster in (state.rosters or {}).items():
        try:
            if player_id in roster:
                return team_name
        except TypeError:
            continue
    return None


_DRAFT_STATS: Tuple[str, ...] = ("PTS", "REB", "AST", "STL", "BLK")


def _draft_dataframe(state, view: str = "averages") -> pd.DataFrame:
    base_df = _ensure_player_base().copy()
    scoring_profile = settings.resolve_scoring_profile(state.scoring_profile_key)
    fantasy_df = compute_fantasy_points(base_df, scoring_profile.weights).copy()
    gp_series = pd.to_numeric(fantasy_df.get("GP", 0), errors="coerce").fillna(0.0)
    fantasy_df["GP"] = gp_series.astype(int)
    fantasy_df["FANTASY_POINTS_AVG"] = pd.to_numeric(fantasy_df["FANTASY_POINTS"], errors="coerce").fillna(0.0)
    fantasy_df["FANTASY_POINTS_TOTAL"] = fantasy_df["FANTASY_POINTS_AVG"] * gp_series

    for stat in _DRAFT_STATS:
        if stat in fantasy_df.columns:
            stat_avg = pd.to_numeric(fantasy_df[stat], errors="coerce").fillna(0.0)
        else:
            stat_avg = pd.Series(0.0, index=fantasy_df.index)
            fantasy_df[stat] = 0.0
        fantasy_df[f"{stat}_AVG"] = stat_avg
        fantasy_df[f"{stat}_TOTAL"] = stat_avg * gp_series

    if view == "totals":
        fantasy_df["FANTASY_POINTS"] = fantasy_df["FANTASY_POINTS_TOTAL"]
        for stat in _DRAFT_STATS:
            fantasy_df[stat] = fantasy_df[f"{stat}_TOTAL"]
        sort_key = "FANTASY_POINTS_TOTAL"
    else:
        fantasy_df["FANTASY_POINTS"] = fantasy_df["FANTASY_POINTS_AVG"]
        for stat in _DRAFT_STATS:
            fantasy_df[stat] = fantasy_df[f"{stat}_AVG"]
        sort_key = "FANTASY_POINTS_AVG"

    fantasy_df = fantasy_df.sort_values(sort_key, ascending=False)
    return fantasy_df


def _player_payload(
    row: pd.Series,
    *,
    taken: bool = False,
    player_id: Optional[int] = None,
    view: str = "averages",
) -> Dict[str, Any]:
    data = row.to_dict()
    if player_id is None:
        player_id = data.get("PLAYER_ID")
    player_id = int(player_id)
    gp = int(data.get("GP", 0) or 0)

    fantasy_avg = float(data.get("FANTASY_POINTS_AVG", data.get("FANTASY_POINTS", 0.0)) or 0.0)
    fantasy_total = float(data.get("FANTASY_POINTS_TOTAL", fantasy_avg * gp) or 0.0)
    fantasy_value = fantasy_total if view == "totals" else fantasy_avg

    def stat_block(stat: str) -> Tuple[float, float, float]:
        avg = float(data.get(f"{stat}_AVG", data.get(stat, 0.0)) or 0.0)
        total = float(data.get(f"{stat}_TOTAL", avg * gp) or 0.0)
        display = total if view == "totals" else avg
        return display, avg, total

    pts, pts_avg, pts_total = stat_block("PTS")
    reb, reb_avg, reb_total = stat_block("REB")
    ast, ast_avg, ast_total = stat_block("AST")
    stl, stl_avg, stl_total = stat_block("STL")
    blk, blk_avg, blk_total = stat_block("BLK")
    return {
        "player_id": player_id,
        "player_name": data.get("PLAYER_NAME"),
        "team": data.get("TEAM_ABBREVIATION", ""),
        "fantasy_points": fantasy_value,
        "fantasy_points_avg": fantasy_avg,
        "fantasy_points_total": fantasy_total,
        "gp": gp,
        "pts": pts,
        "pts_avg": pts_avg,
        "pts_total": pts_total,
        "reb": reb,
        "reb_avg": reb_avg,
        "reb_total": reb_total,
        "ast": ast,
        "ast_avg": ast_avg,
        "ast_total": ast_total,
        "stl": stl,
        "stl_avg": stl_avg,
        "stl_total": stl_total,
        "blk": blk,
        "blk_avg": blk_avg,
        "blk_total": blk_total,
        "taken": taken,
    }


def _draft_summary_payload(state: Any, fantasy_df: pd.DataFrame, view: str = "averages") -> Dict[str, Any]:
    draft_state = state.draft_state or {}
    user_team = draft_state.get("user_team")
    remaining = draft_remaining_slots(state)
    roster_ids = [int(pid) for pid in state.rosters.get(user_team or "", [])]
    index = fantasy_df.set_index("PLAYER_ID")
    picks: List[Dict[str, Any]] = []
    for pid in roster_ids:
        if pid in index.index:
            picks.append(_player_payload(index.loc[pid], taken=True, player_id=pid, view=view))
        else:
            picks.append({"player_id": pid, "player_name": "Unknown", "team": "", "fantasy_points": 0.0, "taken": True})
    return {
        "status": draft_state.get("status"),
        "user_team": user_team,
        "roster_size": draft_state.get("roster_size"),
        "remaining_slots": remaining,
        "picks": picks,
        "can_complete": remaining == 0,
        "view": view,
    }


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
        current = state.current_date
        if current is not None:
            target_date = current
        elif state.history:
            target_date = datetime.fromisoformat(state.history[-1]["date"]).date()
        else:
            schedule_df = _ensure_schedule()
            target_date = season_dates(schedule_df=schedule_df)[0]

    history_entry = _find_history_entry(state, target_date)
    if history_entry:
        games = history_entry.get("nba_scoreboard", []) or []
        for game in games:
            game.setdefault("simulated", True)
            game.setdefault(
                "period_display",
                format_period_label(game.get("status"), game.get("period")),
            )
    else:
        schedule_df = _ensure_schedule()
        games = []
        for game in daily_scoreboard(target_date, schedule_df=schedule_df):
            entry = game.to_dict()
            entry.update(
                simulated=False,
                status="Not played yet",
                time="",
                winner=None,
            )
            entry["home_score"] = None
            entry["away_score"] = None
            entry["period"] = None
            entry["period_display"] = ""
            games.append(entry)

    return {
        "date": target_date.isoformat(),
        "games": games,
        "current_date": None if state.current_date is None else state.current_date.isoformat(),
        "awaiting_simulation": bool(state.awaiting_simulation and state.current_date == target_date),
    }


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
    normalized_name = league_name.strip().lower()
    existing_names = {
        str(entry.get("league_name", "")).strip().lower()
        for entry in list_leagues()
    }
    if normalized_name and normalized_name in existing_names:
        raise HTTPException(status_code=400, detail=f"A league named '{league_name}' already exists.")
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


@app.delete("/leagues")
def delete_all_leagues() -> Dict[str, Any]:
    leagues = list_leagues()
    deleted = 0
    errors: Dict[str, str] = {}
    for league in leagues:
        try:
            delete_league_state(str(league.get("id")))
            deleted += 1
        except Exception as err:  # noqa: BLE001
            errors[str(league.get("id"))] = str(err)
            continue
    return {"deleted": deleted, "errors": errors}


@app.get("/leagues/{league_id}")
def get_league_state_endpoint(league_id: str) -> Dict[str, Any]:
    state = load_league_state(league_id)
    return state.to_dict()


@app.get("/leagues/{league_id}/draft")
def get_draft_state_endpoint(
    league_id: str,
    view: str = Query("averages", pattern="^(averages|totals)$"),
) -> Dict[str, Any]:
    state = load_league_state(league_id)
    if not state.draft_state:
        raise HTTPException(status_code=404, detail="Draft is not configured for this league.")
    fantasy_df = _draft_dataframe(state, view=view)
    return _draft_summary_payload(state, fantasy_df, view=view)


@app.get("/leagues/{league_id}/draft/players")
def list_draft_players(
    league_id: str,
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    search: Optional[str] = Query(None, description="Case-insensitive substring match on player name"),
    view: str = Query("averages", pattern="^(averages|totals)$"),
) -> Dict[str, Any]:
    state = load_league_state(league_id)
    if not state.draft_state:
        raise HTTPException(status_code=404, detail="Draft is not configured for this league.")
    fantasy_df = _draft_dataframe(state, view=view)
    filtered_df = fantasy_df
    if search:
        filtered_df = filtered_df[filtered_df["PLAYER_NAME"].str.contains(search, case=False, na=False)]
    total_count = int(len(filtered_df))
    display_df = filtered_df
    if offset:
        display_df = display_df.iloc[offset:]
    if limit:
        display_df = display_df.iloc[:limit]
    draft_state = state.draft_state or {}
    taken_ids = {int(pid) for pid in draft_state.get("taken_ids", [])}
    for roster in (state.rosters or {}).values():
        for pid in roster or []:
            taken_ids.add(int(pid))
    results: List[Dict[str, Any]] = []
    for record in display_df.itertuples(index=False):
        data_series = pd.Series(record._asdict())
        pid = int(data_series.get("PLAYER_ID"))
        results.append(_player_payload(data_series, taken=pid in taken_ids, view=view))
    summary = _draft_summary_payload(state, fantasy_df, view=view)
    return {
        "count": total_count,
        "results": results,
        "remaining_slots": summary["remaining_slots"],
        "can_complete": summary["can_complete"],
        "view": view,
    }


@app.post("/leagues/{league_id}/draft/pick")
def draft_pick_endpoint(
    league_id: str,
    payload: Dict[str, Any],
    view: str = Query("averages", pattern="^(averages|totals)$"),
) -> Dict[str, Any]:
    state = load_league_state(league_id)
    if not state.draft_state:
        raise HTTPException(status_code=404, detail="Draft is not configured for this league.")
    player_id = payload.get("player_id")
    try:
        player_id = int(player_id)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Missing or invalid 'player_id'.") from err
    try:
        draft_pick_player(state, player_id)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    fantasy_df = _draft_dataframe(state, view=view)
    index = fantasy_df.set_index("PLAYER_ID")
    player_payload = (
        _player_payload(index.loc[player_id], taken=True, player_id=player_id, view=view)
        if player_id in index.index
        else {"player_id": player_id}
    )
    return {
        "draft": _draft_summary_payload(state, fantasy_df, view=view),
        "player": player_payload,
    }


@app.post("/leagues/{league_id}/draft/autopick")
def draft_autopick_endpoint(
    league_id: str,
    view: str = Query("averages", pattern="^(averages|totals)$"),
) -> Dict[str, Any]:
    state = load_league_state(league_id)
    if not state.draft_state:
        raise HTTPException(status_code=404, detail="Draft is not configured for this league.")
    try:
        player_id = draft_autodraft_current(state)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    fantasy_df = _draft_dataframe(state, view=view)
    index = fantasy_df.set_index("PLAYER_ID")
    player_payload = (
        _player_payload(index.loc[player_id], taken=True, player_id=player_id, view=view)
        if player_id in index.index
        else {"player_id": player_id}
    )
    return {
        "draft": _draft_summary_payload(state, fantasy_df, view=view),
        "player": player_payload,
    }


@app.post("/leagues/{league_id}/draft/autopick/rest")
def draft_autopick_rest_endpoint(
    league_id: str,
    view: str = Query("averages", pattern="^(averages|totals)$"),
) -> Dict[str, Any]:
    state = load_league_state(league_id)
    if not state.draft_state:
        raise HTTPException(status_code=404, detail="Draft is not configured for this league.")
    try:
        draft_autodraft_rest(state, _ensure_player_base())
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    fantasy_df = _draft_dataframe(state, view=view)
    return {
        "draft": _draft_summary_payload(state, fantasy_df, view=view),
    }


@app.post("/leagues/{league_id}/draft/complete")
def draft_complete_endpoint(
    league_id: str,
    view: str = Query("averages", pattern="^(averages|totals)$"),
) -> Dict[str, Any]:
    state = load_league_state(league_id)
    if not state.draft_state:
        raise HTTPException(status_code=404, detail="Draft is not configured for this league.")
    try:
        finalize_draft(state, _ensure_player_base())
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    fantasy_df = _draft_dataframe(state, view=view)
    return {
        "draft": _draft_summary_payload(state, fantasy_df, view=view),
    }


@app.get("/team_names")
def suggest_team_names(
    count: int = Query(10, ge=1, le=50, description="Number of suggestions to return"),
    exclude: Optional[List[str]] = Query(None, description="Names to exclude (case-insensitive)"),
) -> Dict[str, Any]:
    pool = _load_team_name_pool()
    if not pool:
        return {"suggestions": []}
    excluded = {str(name).strip().lower() for name in (exclude or []) if str(name).strip()}
    available = [name for name in pool if name.strip().lower() not in excluded]
    if not available:
        available = pool[:]
    random.shuffle(available)
    return {"suggestions": available[:count]}


@app.get("/leagues/{league_id}/weeks")
def get_league_weeks(league_id: str) -> Dict[str, Any]:
    state = load_league_state(league_id)
    overview = build_week_overview(state)
    standings = compute_head_to_head_standings(state)
    return {
        "league_id": league_id,
        **overview,
        "standings": standings,
    }


@app.get("/leagues/{league_id}/players")
def list_league_players(
    league_id: str,
    date_query: Optional[str] = Query(None, alias="date", description="Limit to games on/before this date (YYYY-MM-DD)"),
    view: str = Query("totals", pattern="^(totals|averages)$", description="Show totals or per-game averages"),
    filter_by: str = Query("all", alias="filter", pattern="^(all|available|unavailable)$"),
    search: Optional[str] = Query(None, description="Case-insensitive substring match on player name"),
    sort: str = Query("fantasy", description="Sort key (e.g., fantasy, gp, min, pts, reb, ast, stl, blk, fgm, fga, fg_pct, fg3m, fg3a, fg3_pct, ftm, fta, ft_pct, tov, pf)"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    limit: int = Query(250, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> Dict[str, Any]:
    if GAME_LOGS is None:
        raise HTTPException(status_code=503, detail="Cached data not ready. Run the data download script first.")
    try:
        state = load_league_state(league_id)
    except FileNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err

    scoring_profile = settings.resolve_scoring_profile(state.scoring_profile_key)

    target_date: Optional[date] = None
    if date_query:
        try:
            target_date = datetime.fromisoformat(date_query).date()
        except ValueError as err:
            raise HTTPException(status_code=400, detail="Invalid date format; expected YYYY-MM-DD.") from err
    latest = _league_effective_date(state)
    # Gate by latest simulated date: if nothing simulated yet, return empty list even if a date is requested
    if latest is None:
        return {
            "date": target_date.isoformat() if target_date else None,
            "view": view,
            "sort": sort,
            "order": order,
            "filter": filter_by,
            "count": 0,
            "results": [],
            "scoring_profile": scoring_profile.name,
        }
    # Clamp to latest simulated day
    target_date = min(target_date, latest) if target_date else latest

    # Slice logs up to date
    day_mask = GAME_LOGS["GAME_DATE"].dt.date <= target_date
    logs = GAME_LOGS.loc[day_mask].copy()
    # Ensure MINUTES is numeric for GP/played computation
    if "MINUTES" in logs.columns:
        logs["MINUTES"] = pd.to_numeric(logs["MINUTES"], errors="coerce").fillna(0.0)
    if search:
        logs = logs[logs["PLAYER_NAME"].str.contains(search, case=False, na=False)]

    # Fantasy points per game
    logs = compute_fantasy_points(logs, scoring_profile.weights)
    played_mask = logs.get("MINUTES", 0) > 0

    group_keys = ["PLAYER_ID", "PLAYER_NAME"]
    numeric_sum_cols = [
        col
        for col in [
            "MINUTES",
            "PTS",
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
            "PF",
            "FANTASY_POINTS",
        ]
        if col in logs.columns
    ]

    # Totals over all games (zeros won't affect totals if DNPs are present)
    totals = logs.groupby(group_keys)[numeric_sum_cols].sum(numeric_only=True).reset_index()
    # Games played excluding DNP (0 minutes)
    gp = logs.loc[played_mask].groupby(group_keys).size().reset_index(name="GP")
    totals = totals.merge(gp, on=group_keys, how="left")
    totals.rename(columns={"GP": "TOTAL_GP"}, inplace=True)

    # Team as most common
    team_mode = (
        logs.groupby(group_keys)["TEAM_ABBREVIATION"].agg(lambda s: s.dropna().mode().iloc[0] if not s.dropna().empty else "").reset_index()
        if "TEAM_ABBREVIATION" in logs.columns
        else None
    )
    if team_mode is not None:
        totals = totals.merge(team_mode, on=group_keys, how="left")
    else:
        totals["TEAM_ABBREVIATION"] = ""

    # Derived percentages
    def pct(made: pd.Series, att: pd.Series) -> pd.Series:  # type: ignore[name-defined]
        with pd.option_context("mode.use_inf_as_na", True):
            return ((made / att).fillna(0.0) * 100.0).round(1)

    if {"FGM", "FGA"}.issubset(totals.columns):
        totals["FG_PCT"] = pct(totals["FGM"], totals["FGA"])
    else:
        totals["FG_PCT"] = 0.0
    if {"FG3M", "FG3A"}.issubset(totals.columns):
        totals["FG3_PCT"] = pct(totals["FG3M"], totals["FG3A"])
    else:
        totals["FG3_PCT"] = 0.0
    if {"FTM", "FTA"}.issubset(totals.columns):
        totals["FT_PCT"] = pct(totals["FTM"], totals["FTA"])
    else:
        totals["FT_PCT"] = 0.0

    # Averages over games played (exclude DNPs for averages)
    if view == "averages":
        if logs.loc[played_mask].empty:
            # No played games yet
            totals[numeric_sum_cols] = 0.0
            totals["GP"] = 0
        else:
            avg_group = logs.loc[played_mask].groupby(group_keys)
            averages = avg_group[numeric_sum_cols].mean(numeric_only=True).reset_index()
            totals = totals.drop(columns=[col for col in numeric_sum_cols if col in totals.columns], errors="ignore").merge(
                averages, on=group_keys, how="left"
            )
            gp = avg_group.size().reset_index(name="GP")
            totals = totals.merge(gp, on=group_keys, how="left")

        # Recalculate percentages as averages of rates, or recompute on averages
        if {"FGM", "FGA"}.issubset(totals.columns):
            totals["FG_PCT"] = pct(totals["FGM"], totals["FGA"])
        if {"FG3M", "FG3A"}.issubset(totals.columns):
            totals["FG3_PCT"] = pct(totals["FG3M"], totals["FG3A"])
        if {"FTM", "FTA"}.issubset(totals.columns):
            totals["FT_PCT"] = pct(totals["FTM"], totals["FTA"])

    # Fantasy team membership
    team_by_player = _fantasy_team_lookup(state)
    # Ensure GP is correct:
    # - In averages view, a 'GP' column was merged from played games (MINUTES>0)
    # - In totals view, use the TOTAL_GP we computed earlier
    if "GP" in totals.columns:
        gp_series = totals["GP"]
    else:
        gp_series = totals.get("TOTAL_GP", pd.Series(0, index=totals.index))
    totals["GP"] = gp_series.fillna(0).astype(int)
    totals["fantasy_team"] = totals["PLAYER_ID"].map(lambda pid: team_by_player.get(int(pid)))
    totals["available"] = totals["fantasy_team"].isna()
    totals.drop(columns=["TOTAL_GP"], inplace=True, errors="ignore")

    # Sorting
    sort_map = {
        "fantasy": "FANTASY_POINTS",
        "gp": "GP",
        "min": "MINUTES",
        "pts": "PTS",
        "reb": "REB",
        "ast": "AST",
        "stl": "STL",
        "blk": "BLK",
        "fgm": "FGM",
        "fga": "FGA",
        "fg_pct": "FG_PCT",
        "fg3m": "FG3M",
        "fg3a": "FG3A",
        "fg3_pct": "FG3_PCT",
        "ftm": "FTM",
        "fta": "FTA",
        "ft_pct": "FT_PCT",
        "tov": "TOV",
        "pf": "PF",
    }
    sort_key = sort_map.get(sort.lower(), "FANTASY_POINTS")
    ascending = order == "asc"

    # Filter availability
    if filter_by == "available":
        totals = totals[totals["available"]]
    elif filter_by == "unavailable":
        totals = totals[~totals["available"]]

    if sort_key in totals.columns:
        totals = totals.sort_values(sort_key, ascending=ascending)

    count_total = int(len(totals))
    if offset:
        totals = totals.iloc[offset:]
    if limit:
        totals = totals.iloc[:limit]

    # Serialize
    result = []
    for row in totals.to_dict(orient="records"):
        result.append(
            {
                "player_id": int(row.get("PLAYER_ID")),
                "player_name": row.get("PLAYER_NAME"),
                "team": row.get("TEAM_ABBREVIATION", ""),
                "fantasy": float(row.get("FANTASY_POINTS", 0.0) or 0.0),
                "GP": int(row.get("GP", 0) or 0),
                "MIN": float(row.get("MINUTES", 0.0) or 0.0),
                "PTS": float(row.get("PTS", 0.0) or 0.0),
                "REB": float(row.get("REB", 0.0) or 0.0),
                "AST": float(row.get("AST", 0.0) or 0.0),
                "STL": float(row.get("STL", 0.0) or 0.0),
                "BLK": float(row.get("BLK", 0.0) or 0.0),
                "FGM": float(row.get("FGM", 0.0) or 0.0),
                "FGA": float(row.get("FGA", 0.0) or 0.0),
                "FG_PCT": float(row.get("FG_PCT", 0.0) or 0.0),
                "FG3M": float(row.get("FG3M", 0.0) or 0.0),
                "FG3A": float(row.get("FG3A", 0.0) or 0.0),
                "FG3_PCT": float(row.get("FG3_PCT", 0.0) or 0.0),
                "FTM": float(row.get("FTM", 0.0) or 0.0),
                "FTA": float(row.get("FTA", 0.0) or 0.0),
                "FT_PCT": float(row.get("FT_PCT", 0.0) or 0.0),
                "TOV": float(row.get("TOV", 0.0) or 0.0),
                "PF": float(row.get("PF", 0.0) or 0.0),
                "fantasy_team": row.get("fantasy_team"),
                "available": bool(row.get("available", False)),
            }
        )

    return {
        "date": target_date.isoformat(),
        "view": view,
        "sort": sort,
        "order": order,
        "filter": filter_by,
        "count": count_total,
        "results": result,
        "scoring_profile": scoring_profile.name,
    }


@app.get("/leagues/{league_id}/teams/daily")
def get_team_daily_breakdown(
    league_id: str,
    team: Optional[str] = Query(None, description="Team name (defaults to user team)"),
    date_query: Optional[str] = Query(None, alias="date", description="Date in YYYY-MM-DD format"),
) -> Dict[str, Any]:
    try:
        state = load_league_state(league_id)
    except FileNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err

    # Resolve date to latest simulated if not specified
    if date_query:
        try:
            target_date = datetime.fromisoformat(date_query).date()
        except ValueError as err:
            raise HTTPException(status_code=400, detail="Invalid date format; expected YYYY-MM-DD.") from err
    else:
        latest = state.history[-1]["date"] if state.history else None
        if not latest:
            raise HTTPException(status_code=404, detail="No simulated games yet for this league.")
        target_date = datetime.fromisoformat(latest).date()

    history_entry = _find_history_entry(state, target_date)
    if history_entry is None:
        raise HTTPException(status_code=404, detail="No simulated games for that date.")

    team_name = team or state.user_team_name
    if not team_name:
        raise HTTPException(status_code=400, detail="Missing team parameter and no user team configured.")
    if team_name not in state.team_names:
        raise HTTPException(status_code=404, detail="Unknown team name for this league.")
    if GAME_LOGS is None:
        raise HTTPException(status_code=503, detail="Cached data not ready. Run the data download script first.")

    scoring = settings.resolve_scoring_profile(state.scoring_profile_key)
    roster_ids = [int(pid) for pid in state.rosters.get(team_name, [])]

    day_logs = GAME_LOGS[GAME_LOGS["GAME_DATE"].dt.date == target_date]
    if roster_ids:
        day_logs = day_logs[day_logs["PLAYER_ID"].isin(roster_ids)]
    else:
        day_logs = day_logs.iloc[0:0]

    if not day_logs.empty:
        day_logs = compute_fantasy_points(day_logs.copy(), scoring.weights)
        if not pd.api.types.is_datetime64_any_dtype(day_logs["GAME_DATE"]):
            day_logs.loc[:, "GAME_DATE"] = pd.to_datetime(day_logs["GAME_DATE"])
    else:
        day_logs = pd.DataFrame(columns=GAME_LOGS.columns)

    base_lookup: Dict[int, Dict[str, str]] = {}
    if PLAYER_BASE is not None:
        subset = PLAYER_BASE[PLAYER_BASE["PLAYER_ID"].isin(roster_ids)]
        for row in subset.itertuples(index=False):
            base_lookup[int(row.PLAYER_ID)] = {
                "name": getattr(row, "PLAYER_NAME", None),
                "team": getattr(row, "TEAM_ABBREVIATION", None),
            }

    schedule_lookup: Dict[str, Dict[str, Any]] = {}
    if SCHEDULE_BASE is not None:
        schedule_mask = SCHEDULE_BASE["GAME_DATE"].dt.date == target_date
        for sched in SCHEDULE_BASE.loc[schedule_mask].itertuples(index=False):
            game_id = getattr(sched, "GAME_ID")
            home_abbr = str(getattr(sched, "HOME_TEAM_ABBREVIATION", "") or "").upper()
            visitor_abbr = str(getattr(sched, "VISITOR_TEAM_ABBREVIATION", "") or "").upper()
            if home_abbr:
                schedule_lookup[home_abbr] = _resolve_game_meta(pd.Series({"GAME_ID": game_id, "IS_HOME": True}), SCHEDULE_BASE)
            if visitor_abbr:
                schedule_lookup[visitor_abbr] = _resolve_game_meta(pd.Series({"GAME_ID": game_id, "IS_HOME": False}), SCHEDULE_BASE)

    players_out: List[Dict[str, Any]] = []
    team_total = 0.0

    for pid in roster_ids:
        pid = int(pid)
        player_rows = day_logs[day_logs["PLAYER_ID"] == pid]
        base_meta = base_lookup.get(pid, {})
        player_name = base_meta.get("name")
        team_abbr = base_meta.get("team")

        if not player_rows.empty:
            row = player_rows.iloc[0]
            if not player_name:
                player_name = str(row.get("PLAYER_NAME"))
            if not team_abbr:
                team_abbr = str(row.get("TEAM_ABBREVIATION", ""))
            minutes = float(row.get("MINUTES", 0.0) or 0.0)
            fantasy_points = float(row.get("FANTASY_POINTS", 0.0) or 0.0)
            team_total += fantasy_points
            meta = _resolve_game_meta(row, SCHEDULE_BASE) if SCHEDULE_BASE is not None else {"matchup": "", "result": "", "time": "", "status": ""}
            players_out.append(
                {
                    "player_id": pid,
                    "player_name": player_name,
                    "team": team_abbr,
                    "date": row.get("GAME_DATE").date().isoformat(),
                    "matchup": meta.get("matchup", ""),
                    "result": meta.get("result", ""),
                    "time": meta.get("time", ""),
                    "status": meta.get("status", ""),
                    "time_result": meta.get("result") or meta.get("time") or meta.get("status") or "",
                    "fantasy_points": fantasy_points,
                    "played": bool(minutes > 0),
                    "MIN": minutes,
                    "PTS": float(row.get("PTS", 0.0) or 0.0),
                    "REB": float(row.get("REB", 0.0) or 0.0),
                    "AST": float(row.get("AST", 0.0) or 0.0),
                    "STL": float(row.get("STL", 0.0) or 0.0),
                    "BLK": float(row.get("BLK", 0.0) or 0.0),
                    "FGM": float(row.get("FGM", 0.0) or 0.0),
                    "FGA": float(row.get("FGA", 0.0) or 0.0),
                    "FG_PCT": round(float(row.get("FG_PCT", 0.0) or 0.0) * 100, 3),
                    "FG3M": float(row.get("FG3M", 0.0) or 0.0),
                    "FG3A": float(row.get("FG3A", 0.0) or 0.0),
                    "FG3_PCT": round(float(row.get("FG3_PCT", 0.0) or 0.0) * 100, 3),
                    "FTM": float(row.get("FTM", 0.0) or 0.0),
                    "FTA": float(row.get("FTA", 0.0) or 0.0),
                    "FT_PCT": round(float(row.get("FT_PCT", 0.0) or 0.0) * 100, 3),
                    "TOV": float(row.get("TOV", row.get("TO", 0.0)) or 0.0),
                    "PF": float(row.get("PF", 0.0) or 0.0),
                }
            )
        else:
            meta = schedule_lookup.get((team_abbr or "").upper(), {"matchup": "", "result": "", "time": "", "status": ""})
            players_out.append(
                {
                    "player_id": pid,
                    "player_name": player_name,
                    "team": team_abbr,
                    "date": target_date.isoformat(),
                    "matchup": meta.get("matchup", ""),
                    "result": meta.get("result", ""),
                    "time": meta.get("time", ""),
                    "status": meta.get("status", ""),
                    "time_result": meta.get("result") or meta.get("time") or meta.get("status") or "",
                    "fantasy_points": 0.0,
                    "played": False,
                    "MIN": 0.0,
                    "PTS": 0.0,
                    "REB": 0.0,
                    "AST": 0.0,
                    "STL": 0.0,
                    "BLK": 0.0,
                    "FGM": 0.0,
                    "FGA": 0.0,
                    "FG_PCT": 0.0,
                    "FG3M": 0.0,
                    "FG3A": 0.0,
                    "FG3_PCT": 0.0,
                    "FTM": 0.0,
                    "FTA": 0.0,
                    "FT_PCT": 0.0,
                    "TOV": 0.0,
                    "PF": 0.0,
                }
            )

    players_out.sort(key=lambda p: float(p.get("fantasy_points", 0.0) or 0.0), reverse=True)

    history_total = next(
        (float(entry.get("total", 0.0)) for entry in history_entry.get("team_results", []) if entry.get("team") == team_name),
        None,
    )
    if history_total is not None:
        team_total = history_total

    return {
        "league_id": league_id,
        "date": target_date.isoformat(),
        "team": {
            "name": team_name,
            "total": round(team_total, 2),
            "players": players_out,
        },
    }


@app.post("/leagues/{league_id}/simulate")
def simulate_league_day(league_id: str, scoring_profile: Optional[str] = Body(None, embed=True)) -> Dict[str, Any]:
    state = load_league_state(league_id)
    if GAME_LOGS is None or PLAYER_BASE is None or SCHEDULE_BASE is None:
        raise HTTPException(status_code=503, detail="Cached data not ready. Run the data download script first.")
    try:
        result = simulate_day(
            state,
            game_logs=GAME_LOGS,
            player_stats=PLAYER_BASE,
            scoring_profile_key=scoring_profile,
            schedule_df=SCHEDULE_BASE,
        )
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return result


@app.post("/leagues/{league_id}/advance")
def advance_league_day_endpoint(league_id: str) -> Dict[str, Any]:
    state = load_league_state(league_id)
    try:
        advance_league_day(state)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return state.to_dict()


@app.post("/leagues/{league_id}/autoplay")
def autoplay_league(league_id: str) -> Dict[str, Any]:
    state = load_league_state(league_id)
    if GAME_LOGS is None or PLAYER_BASE is None or SCHEDULE_BASE is None:
        raise HTTPException(status_code=503, detail="Cached data not ready. Run the data download script first.")
    if state.draft_state and state.draft_state.get("status") != "completed":
        raise HTTPException(status_code=400, detail="Finish the draft before autoplaying the season.")
    simulated_days: List[str] = []
    while True:
        try:
            if state.awaiting_simulation:
                result = simulate_day(
                    state,
                    game_logs=GAME_LOGS,
                    player_stats=PLAYER_BASE,
                    scoring_profile_key=None,
                    schedule_df=SCHEDULE_BASE,
                )
                simulated_days.append(str(result.get("date")))
            advance_league_day(state)
        except ValueError:
            break
        if not state.awaiting_simulation and state.current_date is None:
            break
    save_league_state(state)
    return {
        "league_id": league_id,
        "current_date": None if state.current_date is None else state.current_date.isoformat(),
        "awaiting_simulation": state.awaiting_simulation,
        "history_count": len(state.history),
        "simulated_days": [day for day in simulated_days if day],
    }


@app.post("/leagues/{league_id}/reset")
def reset_league_endpoint(league_id: str) -> Dict[str, Any]:
    state = load_league_state(league_id)
    reset_league_state(state, GAME_LOGS)
    return state.to_dict()


@app.post("/leagues/{league_id}/roster/add")
def add_player_to_roster(
    league_id: str,
    payload: Dict[str, Any] = Body(..., example={"player_id": 2544}),
) -> Dict[str, Any]:
    try:
        state = load_league_state(league_id)
    except FileNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    if not state.user_team_name:
        raise HTTPException(status_code=400, detail="This league does not have a user team configured.")
    player_id = payload.get("player_id")
    try:
        player_id = int(player_id)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Missing or invalid 'player_id'.") from err

    # Check availability
    for team_name, roster in state.rosters.items():
        if player_id in roster:
            raise HTTPException(status_code=400, detail=f"Player is already on team '{team_name}'.")

    # Check space
    user_team = state.user_team_name
    roster = state.rosters.get(user_team, [])
    if len(roster) >= state.roster_size:
        raise HTTPException(status_code=400, detail="Your roster is full.")

    roster.append(player_id)
    state.rosters[user_team] = roster
    save_league_state(state)
    return {
        "league_id": league_id,
        "team": user_team,
        "roster_size": state.roster_size,
        "roster_count": len(state.rosters[user_team]),
        "added": player_id,
        "roster": state.rosters[user_team],
    }


@app.post("/leagues/{league_id}/roster/drop")
def drop_player_from_roster(
    league_id: str,
    payload: Dict[str, Any] = Body(..., example={"player_id": 2544}),
) -> Dict[str, Any]:
    try:
        state = load_league_state(league_id)
    except FileNotFoundError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    if not state.user_team_name:
        raise HTTPException(status_code=400, detail="This league does not have a user team configured.")
    player_id = payload.get("player_id")
    try:
        player_id = int(player_id)
    except Exception as err:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Missing or invalid 'player_id'.") from err
    try:
        remove_player_from_roster(state, player_id)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return {
        "league_id": league_id,
        "team": state.user_team_name,
        "roster_size": state.roster_size,
        "roster_count": len(state.rosters.get(state.user_team_name, []) or []),
        "removed": player_id,
        "roster": state.rosters.get(state.user_team_name, []),
    }


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
