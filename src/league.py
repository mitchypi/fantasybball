from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional

import pandas as pd

from .config import DATA_DIR, settings
from .data_loader import compute_fantasy_points, load_player_game_logs, player_season_averages
from .schedule import daily_scoreboard, season_dates

LEAGUE_DIR = DATA_DIR / "leagues"


def _ensure_league_dir() -> None:
    LEAGUE_DIR.mkdir(parents=True, exist_ok=True)


def league_path(league_id: str) -> Path:
    _ensure_league_dir()
    return LEAGUE_DIR / f"{league_id}.json"


@dataclass
class TeamResult:
    team: str
    total: float
    players: List[Dict[str, object]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, object]:
        return {
            "team": self.team,
            "total": self.total,
            "players": self.players,
        }


@dataclass
class LeagueState:
    league_id: str
    league_name: str
    user_team_name: Optional[str]
    team_count: int
    roster_size: int
    scoring_profile_key: str
    scoring_profile: str
    team_names: List[str]
    calendar: List[date]
    current_index: int
    rosters: Dict[str, List[int]]
    history: List[Dict[str, object]] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())

    @property
    def current_date(self) -> Optional[date]:
        if 0 <= self.current_index < len(self.calendar):
            return self.calendar[self.current_index]
        return None

    def to_dict(self) -> Dict[str, object]:
        return {
            "league_id": self.league_id,
            "league_name": self.league_name,
            "user_team_name": self.user_team_name,
            "team_count": self.team_count,
            "roster_size": self.roster_size,
            "team_names": self.team_names,
            "scoring_profile_key": self.scoring_profile_key,
            "scoring_profile": self.scoring_profile,
            "created_at": self.created_at,
            "calendar": [d.isoformat() for d in self.calendar],
            "current_index": self.current_index,
            "current_date": None if self.current_date is None else self.current_date.isoformat(),
            "latest_completed_date": self.history[-1]["date"] if self.history else None,
            "rosters": self.rosters,
            "history": self.history,
        }

    @classmethod
    def from_dict(cls, raw: Dict[str, object]) -> "LeagueState":
        calendar = [date.fromisoformat(item) for item in raw.get("calendar", [])]
        return cls(
            league_id=str(raw.get("league_id")),
            league_name=str(raw.get("league_name")),
            user_team_name=raw.get("user_team_name"),
            team_count=int(raw.get("team_count", 0)),
            roster_size=int(raw.get("roster_size", 0)),
            scoring_profile_key=str(raw.get("scoring_profile_key", settings.default_scoring_profile)),
            scoring_profile=str(raw.get("scoring_profile", "")),
            team_names=list(raw.get("team_names", [])),
            calendar=calendar,
            current_index=int(raw.get("current_index", 0)),
            rosters={team: list(players) for team, players in (raw.get("rosters") or {}).items()},
            history=[dict(item) for item in raw.get("history", [])],
            created_at=str(raw.get("created_at", datetime.utcnow().isoformat())),
        )


def _auto_draft_teams(
    player_stats: pd.DataFrame,
    team_names: Iterable[str],
    roster_size: int,
    scoring_weights: Dict[str, float],
) -> Dict[str, List[int]]:
    fantasy_df = compute_fantasy_points(player_stats, scoring_weights)
    fantasy_df = fantasy_df.sort_values("FANTASY_POINTS", ascending=False)
    rosters: Dict[str, List[int]] = {team: [] for team in team_names}
    players_iter = fantasy_df.itertuples(index=False)

    while True:
        assigned_any = False
        for team in team_names:
            if len(rosters[team]) >= roster_size:
                continue
            try:
                row = next(players_iter)
            except StopIteration:
                return rosters
            rosters[team].append(int(getattr(row, "PLAYER_ID")))
            assigned_any = True
        if not assigned_any:
            break
    return rosters


def _build_team_names(requested: Optional[List[str]], team_count: int) -> List[str]:
    names = [name.strip() for name in (requested or []) if name and name.strip()]
    next_index = 1
    while len(names) < team_count:
        candidate = f"Team {next_index}"
        next_index += 1
        if candidate not in names:
            names.append(candidate)
    return names[:team_count]


def _build_initial_state(
    league_id: str,
    league_name: str,
    user_team_name: Optional[str],
    team_count: int,
    roster_size: int,
    scoring_profile_key: str,
    game_logs: Optional[pd.DataFrame] = None,
) -> LeagueState:
    scoring = settings.resolve_scoring_profile(scoring_profile_key)
    if game_logs is None:
        game_logs = load_player_game_logs()
    player_stats = player_season_averages(game_logs)

    team_names = _build_team_names([user_team_name] if user_team_name else None, team_count)
    rosters = _auto_draft_teams(player_stats, team_names, roster_size, scoring.weights)
    calendar = list(season_dates())
    return LeagueState(
        league_id=league_id,
        league_name=league_name,
        user_team_name=user_team_name,
        team_count=team_count,
        roster_size=roster_size,
        scoring_profile_key=scoring_profile_key,
        scoring_profile=scoring.name,
        team_names=team_names,
        calendar=calendar,
        current_index=0,
        rosters=rosters,
    )


def initialize_league(
    league_name: str,
    team_count: int,
    roster_size: int,
    scoring_profile_key: str,
    user_team_name: Optional[str] = None,
    team_names: Optional[List[str]] = None,
    league_id: Optional[str] = None,
) -> LeagueState:
    league_id = league_id or uuid.uuid4().hex
    game_logs = load_player_game_logs()
    state = _build_initial_state(
        league_id=league_id,
        league_name=league_name,
        user_team_name=user_team_name,
        team_count=team_count,
        roster_size=roster_size,
        scoring_profile_key=scoring_profile_key,
        game_logs=game_logs,
    )
    if team_names:
        state.team_names = _build_team_names(team_names, team_count)
        scoring = settings.resolve_scoring_profile(scoring_profile_key)
        player_stats = player_season_averages(game_logs)
        state.rosters = _auto_draft_teams(player_stats, state.team_names, roster_size, scoring.weights)
    save_league_state(state)
    return state


def save_league_state(state: LeagueState) -> None:
    path = league_path(state.league_id)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(state.to_dict(), handle, indent=2)


def load_league_state(league_id: str) -> LeagueState:
    path = league_path(league_id)
    if not path.exists():
        raise FileNotFoundError(f"Unknown league id '{league_id}'")
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return LeagueState.from_dict(payload)


def list_leagues() -> List[Dict[str, object]]:
    _ensure_league_dir()
    leagues: List[Dict[str, object]] = []
    for path in LEAGUE_DIR.glob("*.json"):
        try:
            state = load_league_state(path.stem)
        except Exception:
            continue
        leagues.append(
            {
                "id": state.league_id,
                "league_name": state.league_name,
                "team_count": state.team_count,
                "roster_size": state.roster_size,
                "scoring_profile": state.scoring_profile,
                "scoring_profile_key": state.scoring_profile_key,
                "latest_completed_date": state.history[-1]["date"] if state.history else None,
                "created_at": state.created_at,
            }
        )
    leagues.sort(key=lambda entry: entry["created_at"])
    return leagues


def _player_lookup(player_stats: pd.DataFrame) -> Dict[int, Dict[str, object]]:
    lookup: Dict[int, Dict[str, object]] = {}
    for row in player_stats.itertuples(index=False):
        lookup[int(getattr(row, "PLAYER_ID"))] = {
            "player_name": getattr(row, "PLAYER_NAME"),
            "team": getattr(row, "TEAM_ABBREVIATION", ""),
        }
    return lookup


def simulate_day(
    state: LeagueState,
    game_logs: pd.DataFrame,
    player_stats: pd.DataFrame,
    scoring_profile_key: Optional[str] = None,
    schedule_df: pd.DataFrame | None = None,
) -> Dict[str, object]:
    current_date = state.current_date
    if current_date is None:
        raise ValueError("The season simulation has already completed.")

    scoring_profile_key = scoring_profile_key or state.scoring_profile_key
    scoring = settings.resolve_scoring_profile(scoring_profile_key)
    day_logs = game_logs[game_logs["GAME_DATE"].dt.date == current_date]
    fantasy_logs = compute_fantasy_points(day_logs, scoring.weights)
    lookup = _player_lookup(player_stats)
    team_results: List[TeamResult] = []

    for team, player_ids in state.rosters.items():
        if not player_ids:
            team_results.append(TeamResult(team=team, total=0.0, players=[]))
            continue
        team_df = fantasy_logs[fantasy_logs["PLAYER_ID"].isin(player_ids)]
        contributions = []
        total = 0.0

        player_scores = {int(row.PLAYER_ID): float(getattr(row, "FANTASY_POINTS", 0.0)) for row in team_df.itertuples(index=False)}

        for player_id in player_ids:
            meta = lookup.get(player_id, {})
            fantasy_points = player_scores.get(player_id, 0.0)
            total += fantasy_points
            contributions.append(
                {
                    "player_id": player_id,
                    "player_name": meta.get("player_name"),
                    "team": meta.get("team"),
                    "fantasy_points": fantasy_points,
                    "played": player_id in player_scores,
                }
            )

        team_results.append(TeamResult(team=team, total=total, players=contributions))

    team_results.sort(key=lambda item: item.total, reverse=True)
    scoreboard = []
    for game in daily_scoreboard(current_date, schedule_df=schedule_df):
        entry = game.to_dict()
        entry["simulated"] = True
        scoreboard.append(entry)

    day_record = {
        "date": current_date.isoformat(),
        "scoring_profile": scoring.name,
        "team_results": [result.to_dict() for result in team_results],
        "nba_scoreboard": scoreboard,
    }

    state.history.append(day_record)
    state.current_index += 1
    save_league_state(state)
    return day_record


def reset_league_state(state: LeagueState, game_logs: Optional[pd.DataFrame] = None) -> LeagueState:
    if game_logs is None:
        game_logs = load_player_game_logs()
    player_stats = player_season_averages(game_logs)
    scoring = settings.resolve_scoring_profile(state.scoring_profile_key)
    state.calendar = list(season_dates())
    state.current_index = 0
    state.history = []
    state.rosters = _auto_draft_teams(player_stats, state.team_names, state.roster_size, scoring.weights)
    save_league_state(state)
    return state
