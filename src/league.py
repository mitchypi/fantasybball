from __future__ import annotations

import json
import random
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pandas as pd

from .config import DATA_DIR, settings, ScoringProfile
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
    weeks: List[Dict[str, object]] = field(default_factory=list)
    weekly_results: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    history: List[Dict[str, object]] = field(default_factory=list)
    awaiting_simulation: bool = True
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    draft_state: Optional[Dict[str, Any]] = None

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
            "weeks": self.weeks,
            "weekly_results": self.weekly_results,
            "history": self.history,
            "awaiting_simulation": self.awaiting_simulation,
            "draft_state": self.draft_state,
        }

    @classmethod
    def from_dict(cls, raw: Dict[str, object]) -> "LeagueState":
        calendar = [date.fromisoformat(item) for item in raw.get("calendar", [])]
        state = cls(
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
            weeks=[dict(item) for item in raw.get("weeks", [])],
            weekly_results={str(key): dict(value) for key, value in (raw.get("weekly_results") or {}).items()},
            history=[dict(item) for item in raw.get("history", [])],
            created_at=str(raw.get("created_at", datetime.utcnow().isoformat())),
            draft_state=dict(raw.get("draft_state") or {}) or None,
        )
        awaiting = raw.get("awaiting_simulation")
        if awaiting is None:
            awaiting = True
        state.awaiting_simulation = bool(awaiting)
        if state.current_date is None:
            state.awaiting_simulation = False
        base_weeks, base_weekly_results = _initialize_week_structures(state.calendar, state.team_names)
        state.weeks = base_weeks
        state.weekly_results = base_weekly_results
        ordered_history = sorted(state.history, key=lambda record: record.get("date") or "")
        for record in ordered_history:
            iso_date = record.get("date")
            if not iso_date:
                continue
            try:
                record_date = datetime.fromisoformat(str(iso_date)).date()
            except (TypeError, ValueError):
                continue
            week = _find_week_for_date(state.weeks, record_date)
            if not week:
                continue
            results_payload = record.get("team_results") or []
            team_results: List[TeamResult] = []
            for entry in results_payload:
                team_name = entry.get("team")
                if not team_name:
                    continue
                team_results.append(
                    TeamResult(
                        team=str(team_name),
                        total=float(entry.get("total", 0.0)),
                        players=list(entry.get("players") or []),
                    )
                )
            if team_results:
                _update_weekly_totals(state, week, team_results, record_date)
                if record.get("week_index") is None:
                    record["week_index"] = week.get("index")
        return state


def _auto_draft_teams(
    player_stats: pd.DataFrame,
    team_names: Iterable[str],
    roster_size: int,
    scoring_weights: Dict[str, float],
    *,
    existing_rosters: Optional[Dict[str, List[int]]] = None,
    ordered_player_ids: Optional[List[int]] = None,
) -> Dict[str, List[int]]:
    fantasy_df = compute_fantasy_points(player_stats, scoring_weights)
    fantasy_df = fantasy_df.sort_values("FANTASY_POINTS", ascending=False)
    candidate_ids: List[int]
    if ordered_player_ids:
        candidate_ids = [int(pid) for pid in ordered_player_ids]
    else:
        candidate_ids = [int(getattr(row, "PLAYER_ID")) for row in fantasy_df.itertuples(index=False)]

    rosters: Dict[str, List[int]] = {
        team: list(existing_rosters.get(team, [])) if existing_rosters else []
        for team in team_names
    }
    taken: set[int] = set()
    for roster in rosters.values():
        for pid in roster:
            taken.add(int(pid))

    index = 0
    team_list = list(team_names)
    while True:
        assigned_any = False
        for team in team_list:
            roster = rosters.setdefault(team, [])
            if len(roster) >= roster_size:
                continue
            while index < len(candidate_ids) and candidate_ids[index] in taken:
                index += 1
            if index >= len(candidate_ids):
                return rosters
            pid = candidate_ids[index]
            index += 1
            roster.append(pid)
            taken.add(pid)
            assigned_any = True
        if not assigned_any:
            break
    return rosters


def _initialize_draft_state(
    player_stats: pd.DataFrame,
    scoring_profile: ScoringProfile,
    *,
    roster_size: int,
    user_team: str,
) -> Dict[str, Any]:
    fantasy_df = compute_fantasy_points(player_stats, scoring_profile.weights)
    fantasy_df = fantasy_df.sort_values("FANTASY_POINTS", ascending=False)
    ordered_ids = [int(getattr(row, "PLAYER_ID")) for row in fantasy_df.itertuples(index=False)]
    return {
        "status": "pending",
        "roster_size": int(roster_size),
        "user_team": user_team,
        "user_picks": [],
        "taken_ids": [],
        "ordered_ids": ordered_ids,
    }


def _load_team_name_pool() -> List[str]:
    path = DATA_DIR / "fantasy_team_names.csv"
    pool: List[str] = []
    if not path.exists():
        return pool
    try:
        # Avoid heavy dependencies; parse simple CSV with header line.
        with path.open("r", encoding="utf-8") as handle:
            header_skipped = False
            for raw in handle:
                line = (raw or "").strip()
                if not line:
                    continue
                if not header_skipped:
                    # Skip header row if present (e.g., "Team Name").
                    header_skipped = True
                    if line.lower().replace(",", "").strip() in {"team name", "name"}:
                        continue
                    # If first line isn't a header treat it as a team name.
                pool.append(line.split(",")[0].strip())
    except Exception:
        return []
    # Deduplicate while preserving order
    seen = set()
    unique: List[str] = []
    for name in pool:
        key = name.strip().lower()
        if key and key not in seen:
            seen.add(key)
            unique.append(name.strip())
    return unique


def _build_team_names(requested: Optional[List[str]], team_count: int) -> List[str]:
    # Start with any explicitly requested names (e.g., user team) and fill the
    # rest from the CSV pool. Fallback to "Team N" only if necessary.
    names: List[str] = []
    used = set()
    for name in (requested or []):
        if not name:
            continue
        cleaned = name.strip()
        key = cleaned.lower()
        if cleaned and key not in used:
            names.append(cleaned)
            used.add(key)

    pool = _load_team_name_pool()
    for candidate in pool:
        if len(names) >= team_count:
            break
        key = candidate.strip().lower()
        if key and key not in used:
            names.append(candidate.strip())
            used.add(key)

    # Final fallback if the CSV did not have enough unique names
    next_index = 1
    while len(names) < team_count:
        candidate = f"Team {next_index}"
        next_index += 1
        key = candidate.lower()
        if key not in used:
            names.append(candidate)
            used.add(key)

    return names[:team_count]


def _week_monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _compute_week_ranges(calendar: List[date]) -> List[Dict[str, date]]:
    """Compute week boundaries as:
    - Week 1: from the season's first game date to its Sunday (inclusive)
    - Subsequent weeks: Monday to Sunday windows

    This ensures a Tuesday season start (e.g., 2024-10-22) yields
    Week 1: Tue Oct 22 – Sun Oct 27
    Week 2: Mon Oct 28 – Sun Nov 3, etc.
    """
    if not calendar:
        return []

    ranges: List[Dict[str, date]] = []
    first_date = min(calendar)
    last_date = max(calendar)

    first_monday = _week_monday(first_date)
    first_sunday = first_monday + timedelta(days=6)

    # Week 1 starts at the first actual game date, not on Monday
    ranges.append({
        "start": first_date,
        "end": first_sunday,
        "monday": first_monday,
    })

    # Build subsequent full Monday–Sunday weeks until we cover the season's last date
    week_monday = first_monday + timedelta(days=7)
    while week_monday <= last_date:
        week_sunday = week_monday + timedelta(days=6)
        ranges.append({
            "start": week_monday,
            "end": week_sunday,
            "monday": week_monday,
        })
        week_monday = week_monday + timedelta(days=7)

    return ranges


def _round_robin_pairs(team_names: List[str]) -> List[List[Tuple[str, str]]]:
    teams = list(team_names)
    if not teams:
        return []
    if len(teams) % 2 != 0:
        teams.append("BYE")
    team_count = len(teams)
    if team_count <= 1:
        return []

    rounds = team_count - 1
    schedule: List[List[Tuple[str, str]]] = []
    for _ in range(rounds):
        pairings: List[Tuple[str, str]] = []
        for index in range(team_count // 2):
            home = teams[index]
            away = teams[team_count - 1 - index]
            if home != "BYE" and away != "BYE":
                pairings.append((home, away))
        schedule.append(pairings)
        rotation = [teams[0], teams[-1], *teams[1:-1]]
        teams = rotation
    return schedule


def _build_weekly_pairings(team_names: List[str], week_count: int) -> List[List[Tuple[str, str]]]:
    base_schedule = _round_robin_pairs(team_names)
    if not base_schedule:
        return [[] for _ in range(max(0, week_count))]

    pairings: List[List[Tuple[str, str]]] = []
    base_length = len(base_schedule)
    for week_index in range(week_count):
        base_pairing = list(base_schedule[week_index % base_length])
        if base_length > 0 and (week_index // base_length) % 2 == 1:
            base_pairing = [(away, home) for home, away in base_pairing]
        pairings.append(base_pairing)
    return pairings


def _initialize_week_structures(calendar: List[date], team_names: List[str]) -> Tuple[List[Dict[str, object]], Dict[str, Dict[str, Any]]]:
    week_ranges = _compute_week_ranges(calendar)
    weekly_pairings = _build_weekly_pairings(team_names, len(week_ranges))
    weekly_results: Dict[str, Dict[str, Any]] = {}
    weeks: List[Dict[str, object]] = []

    for index, (week_range, pairings) in enumerate(zip(week_ranges, weekly_pairings), start=1):
        start_date = week_range["start"]
        end_date = week_range["end"]
        matchups: List[Dict[str, object]] = []
        for matchup_idx, (team_a, team_b) in enumerate(pairings):
            matchup_id = f"week{index}-matchup{matchup_idx}"
            matchups.append(
                {
                    "id": matchup_id,
                    "teams": [
                        {"name": team_a},
                        {"name": team_b},
                    ],
                }
            )
            weekly_results[matchup_id] = {
                "matchup_id": matchup_id,
                "week_index": index,
                "teams": {
                    team_a: {
                        "team": team_a,
                        "total": 0.0,
                        "players": {},
                        "daily_totals": {},
                    },
                    team_b: {
                        "team": team_b,
                        "total": 0.0,
                        "players": {},
                        "daily_totals": {},
                    },
                },
                "days": [],
            }
        weeks.append(
            {
                "index": index,
                "name": f"Week {index}",
                "start": start_date.isoformat(),
                "end": end_date.isoformat(),
                "matchups": matchups,
            }
        )

    return weeks, weekly_results


def _find_week_for_date(weeks: List[Dict[str, object]], target_date: date) -> Optional[Dict[str, object]]:
    for week in weeks:
        try:
            start = date.fromisoformat(str(week.get("start")))
            end = date.fromisoformat(str(week.get("end")))
        except (TypeError, ValueError):
            continue
        if start <= target_date <= end:
            return week
    if weeks:
        last_week = weeks[-1]
        try:
            end = date.fromisoformat(str(last_week.get("end")))
        except (TypeError, ValueError):
            return None
        if target_date > end:
            return last_week
    return None


def _ensure_matchup_entry(state: LeagueState, matchup: Dict[str, object], week_index: int) -> Dict[str, Any]:
    matchup_id = str(matchup.get("id"))
    if matchup_id in state.weekly_results:
        return state.weekly_results[matchup_id]

    teams = matchup.get("teams") or []
    team_entries: Dict[str, Dict[str, Any]] = {}
    for team_info in teams:
        name = str(team_info.get("name"))
        if not name:
            continue
        team_entries[name] = {
            "team": name,
            "total": 0.0,
            "players": {},
            "daily_totals": {},
        }
    entry = {
        "matchup_id": matchup_id,
        "week_index": week_index,
        "teams": team_entries,
        "days": [],
    }
    state.weekly_results[matchup_id] = entry
    return entry


def _update_weekly_totals(state: LeagueState, week: Dict[str, object], team_results: List[TeamResult], current_date: date) -> None:
    if not week:
        return
    iso_date = current_date.isoformat()
    matchups = week.get("matchups") or []
    for result in team_results:
        target_matchup = None
        for matchup in matchups:
            teams = matchup.get("teams") or []
            if any(team.get("name") == result.team for team in teams):
                target_matchup = matchup
                break
        if target_matchup is None:
            continue
        entry = _ensure_matchup_entry(state, target_matchup, int(week.get("index", 0) or 0))
        team_entry = entry["teams"].setdefault(
            result.team,
            {
                "team": result.team,
                "total": 0.0,
                "players": {},
                "daily_totals": {},
            },
        )
        team_entry["total"] = float(team_entry.get("total", 0.0)) + float(result.total)
        daily_totals = team_entry.setdefault("daily_totals", {})
        daily_totals[iso_date] = float(daily_totals.get(iso_date, 0.0)) + float(result.total)

        players_map: Dict[str, Dict[str, Any]] = team_entry.setdefault("players", {})
        for player in result.players:
            player_id = str(player.get("player_id"))
            if not player_id:
                continue
            record = players_map.setdefault(
                player_id,
                {
                    "player_id": player.get("player_id"),
                    "player_name": player.get("player_name"),
                    "team": player.get("team"),
                    "fantasy_points": 0.0,
                    "games_played": 0,
                },
            )
            record["fantasy_points"] = float(record.get("fantasy_points", 0.0)) + float(player.get("fantasy_points", 0.0) or 0.0)
            if player.get("played"):
                record["games_played"] = int(record.get("games_played", 0)) + 1

        days = entry.setdefault("days", [])
        if iso_date not in days:
            days.append(iso_date)


def _latest_simulated_date(state: LeagueState) -> Optional[date]:
    if not state.history:
        return None
    for record in reversed(state.history):
        iso_date = record.get("date")
        if not iso_date:
            continue
        try:
            return datetime.fromisoformat(str(iso_date)).date()
        except (TypeError, ValueError):
            continue
    return None


def _week_status(week: Dict[str, object], latest_date: Optional[date]) -> str:
    if latest_date is None:
        return "not_started"
    try:
        start = date.fromisoformat(str(week.get("start")))
        end = date.fromisoformat(str(week.get("end")))
    except (TypeError, ValueError):
        return "not_started"
    if latest_date < start:
        return "not_started"
    if latest_date > end:
        return "completed"
    return "in_progress"


def build_week_overview(state: LeagueState) -> Dict[str, Any]:
    latest_date = _latest_simulated_date(state)
    reference_date = state.current_date or latest_date
    current_week_index: Optional[int] = None

    for week in state.weeks:
        try:
            start = date.fromisoformat(str(week.get("start")))
            end = date.fromisoformat(str(week.get("end")))
        except (TypeError, ValueError):
            continue
        if reference_date and start <= reference_date <= end:
            current_week_index = int(week.get("index", 0) or 0)
            break
    if current_week_index is None and state.weeks:
        current_week_index = int(state.weeks[0].get("index", 0) or 0)

    weeks_payload: List[Dict[str, Any]] = []
    for week in state.weeks:
        status = _week_status(week, latest_date)
        matchups_payload: List[Dict[str, Any]] = []
        for matchup in week.get("matchups") or []:
            matchup_id = str(matchup.get("id"))
            entry = state.weekly_results.get(matchup_id, {})
            teams_payload: List[Dict[str, Any]] = []
            for team_meta in matchup.get("teams") or []:
                team_name = str(team_meta.get("name") or "")
                team_stats = (entry.get("teams") or {}).get(team_name, {})
                players_map = team_stats.get("players") or {}
                players_list = sorted(
                    [
                        {
                            "player_id": value.get("player_id"),
                            "player_name": value.get("player_name"),
                            "team": value.get("team"),
                            "fantasy_points": float(value.get("fantasy_points", 0.0)),
                            "games_played": int(value.get("games_played", 0)),
                        }
                        for value in players_map.values()
                    ],
                    key=lambda item: item["fantasy_points"],
                    reverse=True,
                )
                daily_totals = team_stats.get("daily_totals") or {}
                teams_payload.append(
                    {
                        "name": team_name,
                        "total": float(team_stats.get("total", 0.0)),
                        "players": players_list,
                        "daily_totals": [
                            {
                                "date": iso,
                                "total": float(total),
                            }
                            for iso, total in sorted(daily_totals.items())
                        ],
                    }
                )
            matchup_days = sorted(entry.get("days") or [])
            matchup_status = "not_started"
            if matchup_days:
                matchup_status = "completed" if status == "completed" else "in_progress"

            leader = None
            if len(teams_payload) == 2:
                if teams_payload[0]["total"] > teams_payload[1]["total"]:
                    leader = teams_payload[0]["name"]
                elif teams_payload[1]["total"] > teams_payload[0]["total"]:
                    leader = teams_payload[1]["name"]

            matchups_payload.append(
                {
                    "id": matchup_id,
                    "status": matchup_status,
                    "teams": teams_payload,
                    "days": matchup_days,
                    "leader": leader,
                }
            )
        weeks_payload.append(
            {
                "index": int(week.get("index", 0) or 0),
                "name": week.get("name"),
                "start": week.get("start"),
                "end": week.get("end"),
                "status": status,
                "matchups": matchups_payload,
            }
        )

    return {
        "current_week_index": current_week_index,
        "weeks": weeks_payload,
    }


def compute_head_to_head_standings(state: LeagueState) -> List[Dict[str, Any]]:
    latest_date = _latest_simulated_date(state)
    records: Dict[str, Dict[str, Any]] = {}
    for team_name in state.team_names:
        records[team_name] = {
            "team": team_name,
            "wins": 0,
            "losses": 0,
            "ties": 0,
            "points_for": 0.0,
            "points_against": 0.0,
        }

    for week in state.weeks:
        status = _week_status(week, latest_date)
        if status == "not_started":
            continue
        for matchup in week.get("matchups") or []:
            entry = state.weekly_results.get(str(matchup.get("id")), {})
            teams = matchup.get("teams") or []
            if len(teams) < 2:
                continue
            team_a = str(teams[0].get("name") or "")
            team_b = str(teams[1].get("name") or "")
            if not team_a or not team_b:
                continue
            stats = entry.get("teams") or {}
            stats_a = stats.get(team_a, {})
            stats_b = stats.get(team_b, {})
            total_a = float(stats_a.get("total", 0.0))
            total_b = float(stats_b.get("total", 0.0))

            record_a = records.setdefault(
                team_a,
                {
                    "team": team_a,
                    "wins": 0,
                    "losses": 0,
                    "ties": 0,
                    "points_for": 0.0,
                    "points_against": 0.0,
                },
            )
            record_b = records.setdefault(
                team_b,
                {
                    "team": team_b,
                    "wins": 0,
                    "losses": 0,
                    "ties": 0,
                    "points_for": 0.0,
                    "points_against": 0.0,
                },
            )

            record_a["points_for"] += total_a
            record_a["points_against"] += total_b
            record_b["points_for"] += total_b
            record_b["points_against"] += total_a

            if status != "completed":
                continue
            if total_a > total_b:
                record_a["wins"] += 1
                record_b["losses"] += 1
            elif total_b > total_a:
                record_b["wins"] += 1
                record_a["losses"] += 1
            else:
                record_a["ties"] += 1
                record_b["ties"] += 1

    standings: List[Dict[str, Any]] = []
    for team_name, record in records.items():
        games_played = record["wins"] + record["losses"] + record["ties"]
        win_pct = (record["wins"] + 0.5 * record["ties"]) / games_played if games_played else 0.0
        standings.append(
            {
                "team": team_name,
                "wins": record["wins"],
                "losses": record["losses"],
                "ties": record["ties"],
                "games_played": games_played,
                "win_pct": round(win_pct, 3),
                "points_for": round(record["points_for"], 1),
                "points_against": round(record["points_against"], 1),
                "point_diff": round(record["points_for"] - record["points_against"], 1),
            }
        )

    standings.sort(
        key=lambda item: (
            -item["win_pct"],
            -item["wins"],
            -item["point_diff"],
            -item["points_for"],
            item["team"],
        )
    )
    for index, row in enumerate(standings, start=1):
        row["rank"] = index
    return standings


def _build_initial_state(
    league_id: str,
    league_name: str,
    user_team_name: Optional[str],
    team_count: int,
    roster_size: int,
    scoring_profile_key: str,
    game_logs: Optional[pd.DataFrame] = None,
    team_names: Optional[List[str]] = None,
) -> LeagueState:
    scoring = settings.resolve_scoring_profile(scoring_profile_key)
    if game_logs is None:
        game_logs = load_player_game_logs()
    player_stats = player_season_averages(game_logs)

    prepared_names = _build_team_names(
        team_names if team_names else ([user_team_name] if user_team_name else None),
        team_count,
    )
    draft_state: Optional[Dict[str, Any]] = None
    if user_team_name:
        rosters = {team: [] for team in prepared_names}
        draft_state = _initialize_draft_state(
            player_stats,
            scoring,
            roster_size=roster_size,
            user_team=user_team_name,
        )
    else:
        rosters = _auto_draft_teams(
            player_stats,
            prepared_names,
            roster_size,
            scoring.weights,
        )
    calendar = list(season_dates())
    weeks, weekly_results = _initialize_week_structures(calendar, prepared_names)
    return LeagueState(
        league_id=league_id,
        league_name=league_name,
        user_team_name=user_team_name,
        team_count=team_count,
        roster_size=roster_size,
        scoring_profile_key=scoring_profile_key,
        scoring_profile=scoring.name,
        team_names=prepared_names,
        calendar=calendar,
        current_index=0,
        rosters=rosters,
        weeks=weeks,
        weekly_results=weekly_results,
        draft_state=draft_state,
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
        team_names=team_names,
    )
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
            with path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except Exception:
            continue
        league_id = str(raw.get("league_id") or path.stem)
        league_name = str(raw.get("league_name") or "League")
        team_count = int(raw.get("team_count", 0) or 0)
        roster_size = int(raw.get("roster_size", 0) or 0)
        scoring_profile = str(raw.get("scoring_profile") or "")
        scoring_profile_key = str(raw.get("scoring_profile_key") or settings.default_scoring_profile)
        history = list(raw.get("history", []) or [])
        latest_completed_date = history[-1].get("date") if history else None
        created_at = str(raw.get("created_at") or datetime.utcnow().isoformat())
        leagues.append(
            {
                "id": league_id,
                "league_name": league_name,
                "team_count": team_count,
                "roster_size": roster_size,
                "scoring_profile": scoring_profile,
                "scoring_profile_key": scoring_profile_key,
                "latest_completed_date": latest_completed_date,
                "created_at": created_at,
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


def draft_is_active(state: LeagueState) -> bool:
    draft_state = state.draft_state or {}
    return bool(draft_state) and draft_state.get("status") != "completed"


def draft_remaining_slots(state: LeagueState) -> int:
    if not draft_is_active(state):
        return 0
    draft_state = state.draft_state or {}
    user_team = draft_state.get("user_team")
    roster_size = int(draft_state.get("roster_size", 0))
    roster = state.rosters.get(user_team or "", [])
    return max(roster_size - len(roster), 0)


def draft_available_player_ids(state: LeagueState) -> List[int]:
    draft_state = state.draft_state or {}
    ordered = draft_state.get("ordered_ids") or []
    taken = {int(pid) for pid in draft_state.get("taken_ids", [])}
    user_picks = draft_state.get("user_picks", []) or []
    taken.update(int(pid) for pid in user_picks)
    # Include players already on any roster in case draft_state is stale
    for roster in (state.rosters or {}).values():
        for pid in roster or []:
            taken.add(int(pid))
    return [int(pid) for pid in ordered if int(pid) not in taken]


def draft_pick_player(state: LeagueState, player_id: int) -> None:
    if not draft_is_active(state):
        raise ValueError("Draft is not currently active for this league.")
    draft_state = dict(state.draft_state or {})
    user_team = draft_state.get("user_team")
    if not user_team:
        raise ValueError("Draft configuration is missing the user team.")
    roster_size = int(draft_state.get("roster_size", 0))
    roster = state.rosters.setdefault(user_team, [])
    if len(roster) >= roster_size:
        raise ValueError("Roster is already full.")
    pid = int(player_id)
    taken = {int(item) for item in draft_state.get("taken_ids", [])}
    taken.update(int(item) for item in draft_state.get("user_picks", []))
    for roster_list in state.rosters.values():
        for existing in roster_list:
            taken.add(int(existing))
    if pid in taken:
        raise ValueError("Player has already been drafted.")
    roster.append(pid)
    draft_state.setdefault("user_picks", []).append(pid)
    draft_state.setdefault("taken_ids", []).append(pid)
    state.draft_state = draft_state
    save_league_state(state)


def draft_autodraft_current(state: LeagueState) -> int:
    available = draft_available_player_ids(state)
    if not available:
        raise ValueError("No players available to draft.")
    pool_size = min(5, len(available))
    pool = available[:pool_size]
    weights = [1.0 / (index + 1) for index in range(pool_size)]
    pid = int(random.choices(pool, weights=weights, k=1)[0])
    draft_pick_player(state, pid)
    return pid


def draft_autodraft_rest(state: LeagueState, player_stats: pd.DataFrame) -> None:
    while draft_remaining_slots(state) > 0:
        draft_autodraft_current(state)
    finalize_draft(state, player_stats)


def finalize_draft(state: LeagueState, player_stats: pd.DataFrame) -> None:
    if not draft_is_active(state):
        return
    draft_state = dict(state.draft_state or {})
    user_team = draft_state.get("user_team")
    if not user_team:
        raise ValueError("Draft configuration missing user team assignment.")
    roster_size = int(draft_state.get("roster_size", 0))
    roster = state.rosters.get(user_team, [])
    if len(roster) < roster_size:
        raise ValueError("Fill your roster before completing the draft.")
    scoring = settings.resolve_scoring_profile(state.scoring_profile_key)
    updated_rosters = _auto_draft_teams(
        player_stats,
        state.team_names,
        roster_size,
        scoring.weights,
        existing_rosters=state.rosters,
        ordered_player_ids=draft_state.get("ordered_ids"),
    )
    state.rosters = {team: [int(pid) for pid in players] for team, players in updated_rosters.items()}
    taken: List[int] = []
    for roster_players in state.rosters.values():
        taken.extend(int(pid) for pid in roster_players)
    state.draft_state = {
        "status": "completed",
        "completed_at": datetime.utcnow().isoformat(),
        "user_team": user_team,
        "user_picks": draft_state.get("user_picks", []),
        "taken_ids": taken,
    }
    save_league_state(state)


def remove_player_from_roster(state: LeagueState, player_id: int) -> None:
    if not state.user_team_name:
        raise ValueError("This league does not have a user team configured.")
    user_team = state.user_team_name
    roster = state.rosters.get(user_team, []) or []
    pid = int(player_id)
    if pid not in {int(item) for item in roster}:
        raise ValueError("Player is not on your roster.")
    state.rosters[user_team] = [int(item) for item in roster if int(item) != pid]
    save_league_state(state)


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
    if draft_is_active(state):
        raise ValueError("Complete the draft before simulating games.")
    if not state.awaiting_simulation:
        raise ValueError("Today's games have already been simulated.")

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

    week = _find_week_for_date(state.weeks, current_date)
    if week:
        _update_weekly_totals(state, week, team_results, current_date)

    scoreboard = []
    for game in daily_scoreboard(current_date, schedule_df=schedule_df):
        entry = game.to_dict()
        entry["simulated"] = True
        scoreboard.append(entry)

    day_record = {
        "date": current_date.isoformat(),
        "scoring_profile": scoring.name,
        "week_index": int(week.get("index", 0)) if week else None,
        "team_results": [result.to_dict() for result in team_results],
        "nba_scoreboard": scoreboard,
    }

    iso_date = current_date.isoformat()
    state.history = [record for record in state.history if record.get("date") != iso_date]
    state.history.append(day_record)
    state.awaiting_simulation = False
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
    state.awaiting_simulation = True
    state.weeks, state.weekly_results = _initialize_week_structures(state.calendar, state.team_names)
    if state.user_team_name:
        state.rosters = {team: [] for team in state.team_names}
        state.draft_state = _initialize_draft_state(
            player_stats,
            scoring,
            roster_size=state.roster_size,
            user_team=state.user_team_name,
        )
    else:
        state.rosters = _auto_draft_teams(
            player_stats,
            state.team_names,
            state.roster_size,
            scoring.weights,
        )
        state.draft_state = None
    save_league_state(state)
    return state


def delete_league_state(league_id: str) -> None:
    path = league_path(league_id)
    if not path.exists():
        raise FileNotFoundError(f"Unknown league id '{league_id}'")
    path.unlink()


def advance_league_day(state: LeagueState) -> LeagueState:
    if draft_is_active(state):
        raise ValueError("Complete the draft before advancing the season.")
    if state.awaiting_simulation and state.current_date is not None:
        raise ValueError("Play today's games before advancing to the next day.")
    if state.current_date is None:
        state.awaiting_simulation = False
        save_league_state(state)
        return state
    if state.current_index >= len(state.calendar) - 1:
        state.current_index = len(state.calendar)
        state.awaiting_simulation = False
    else:
        state.current_index += 1
        state.awaiting_simulation = True
    save_league_state(state)
    return state
