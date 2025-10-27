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
class PlayoffConfig:
    enabled: bool = False
    teams: Optional[int] = None
    week_indices: List[int] = field(default_factory=list)
    reseed: bool = False
    consolation: bool = False

    @property
    def rounds(self) -> int:
        return len(self.week_indices)

    @property
    def is_enabled(self) -> bool:
        return bool(self.enabled and self.teams and self.week_indices)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "teams": self.teams,
            "weeks": self.week_indices,
            "reseed": self.reseed,
            "consolation": self.consolation,
        }

    @classmethod
    def from_dict(cls, payload: Optional[Dict[str, Any]]) -> "PlayoffConfig":
        if not payload:
            return cls()
        teams_value = payload.get("teams")
        try:
            teams = int(teams_value) if teams_value not in (None, "", "null") else None
        except (TypeError, ValueError):
            teams = None
        return cls(
            enabled=bool(payload.get("enabled", False)),
            teams=teams,
            week_indices=[int(week) for week in payload.get("weeks", []) if str(week).strip()],
            reseed=bool(payload.get("reseed", False)),
            consolation=bool(payload.get("consolation", False)),
        )


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
    phase: str = "regular"
    playoffs_config: PlayoffConfig = field(default_factory=PlayoffConfig)
    playoffs: Optional[Dict[str, Any]] = None

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
            "phase": self.phase,
            "playoffs": self.playoffs,
            "playoffs_config": self.playoffs_config.to_dict(),
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
            phase=str(raw.get("phase", "regular")),
            playoffs_config=PlayoffConfig.from_dict(raw.get("playoffs_config")),
            playoffs=dict(raw.get("playoffs") or {}) or None,
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
        try:
            state.playoffs_config = validate_playoff_config(state.team_count, state.weeks, state.playoffs_config.to_dict())
        except ValueError:
            state.playoffs_config = PlayoffConfig()
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


VALID_PLAYOFF_TEAM_COUNTS: Tuple[int, ...] = (4, 6, 8)
PLAYOFF_ROUNDS_REQUIRED: Dict[int, int] = {4: 2, 6: 3, 8: 3}


def _required_playoff_rounds(team_count: int) -> int:
    try:
        return PLAYOFF_ROUNDS_REQUIRED[team_count]
    except KeyError as exc:
        raise ValueError(f"Unsupported playoff team count: {team_count}") from exc


def _format_week_indices_label(indices: List[int]) -> str:
    parts = [str(index) for index in indices]
    if not parts:
        return ""
    if len(parts) == 1:
        return f"Week {parts[0]}"
    if len(parts) == 2:
        return f"Week {parts[0]} and {parts[1]}"
    return "Week " + ", ".join(parts[:-1]) + f" and {parts[-1]}"


def _normalize_team_name(name: Optional[str]) -> str:
    return str(name or "").strip().lower()


def _format_end_date_label(end_iso: Optional[str]) -> str:
    if not end_iso:
        return ""
    try:
        end_dt = date.fromisoformat(str(end_iso))
    except ValueError:
        return ""
    return end_dt.strftime("%b %d").replace(" 0", " ").strip()


def _playoff_week_options(weeks: List[Dict[str, object]], rounds: int) -> List[Dict[str, Any]]:
    options: List[Dict[str, Any]] = []
    if not weeks or rounds <= 0:
        return options
    total_weeks = len(weeks)
    for start in range(1, total_weeks - rounds + 2):
        indices = list(range(start, start + rounds))
        start_week = weeks[start - 1]
        end_week = weeks[indices[-1] - 1]
        label_core = _format_week_indices_label(indices).replace("Week Week", "Week")
        end_label = _format_end_date_label(end_week.get("end"))
        label = f"{label_core} (ends {end_label})" if end_label else label_core
        options.append(
            {
                "weeks": indices,
                "start_week": indices[0],
                "end_week": indices[-1],
                "start_date": start_week.get("start"),
                "end_date": end_week.get("end"),
                "label": label,
            }
        )
    return options


def compute_playoff_options(team_count: int, weeks: List[Dict[str, object]]) -> Dict[str, Any]:
    available_counts = [count for count in VALID_PLAYOFF_TEAM_COUNTS if count <= team_count]
    payload: Dict[str, Any] = {
        "team_count": team_count,
        "total_weeks": len(weeks),
        "options": [],
    }
    for count in available_counts:
        rounds = _required_playoff_rounds(count)
        week_options = _playoff_week_options(weeks, rounds)
        payload["options"].append(
            {
                "teams": count,
                "rounds": rounds,
                "weeks": week_options,
            }
        )
    return payload


def validate_playoff_config(
    team_count: int,
    weeks: List[Dict[str, object]],
    raw_config: Optional[Dict[str, Any]],
) -> PlayoffConfig:
    if not raw_config:
        return PlayoffConfig()
    config = PlayoffConfig.from_dict(raw_config)
    if not config.enabled:
        return PlayoffConfig()
    if config.teams is None:
        raise ValueError("Playoff configuration is missing the number of teams.")
    if config.teams not in VALID_PLAYOFF_TEAM_COUNTS:
        raise ValueError(f"Playoffs support {', '.join(str(c) for c in VALID_PLAYOFF_TEAM_COUNTS)} teams.")
    if config.teams > team_count:
        raise ValueError("Playoff team count cannot exceed total teams in the league.")

    rounds_required = _required_playoff_rounds(config.teams)
    if len(config.week_indices) != rounds_required:
        raise ValueError(f"{config.teams}-team playoffs require {rounds_required} weeks.")

    if not config.week_indices:
        raise ValueError("Playoff weeks must be specified when playoffs are enabled.")

    sorted_weeks = sorted(int(week) for week in config.week_indices)
    first_week = sorted_weeks[0]
    expected_sequence = list(range(first_week, first_week + len(sorted_weeks)))
    if sorted_weeks != expected_sequence:
        raise ValueError("Playoff weeks must be contiguous.")

    max_week_index = len(weeks)
    if sorted_weeks[-1] > max_week_index:
        raise ValueError("Playoff weeks extend beyond the season calendar.")

    valid_indices = {int(week.get("index")) for week in weeks}
    for week in sorted_weeks:
        if week not in valid_indices:
            raise ValueError(f"Week {week} is not available in the season calendar.")

    config.week_indices = sorted_weeks
    return config


def playoff_options_for_team_count(
    team_count: int,
    calendar: Optional[List[date]] = None,
) -> Dict[str, Any]:
    calendar = calendar or list(season_dates())
    week_ranges = _compute_week_ranges(calendar)
    weeks = [
        {
            "index": idx,
            "start": rng["start"].isoformat(),
            "end": rng["end"].isoformat(),
        }
        for idx, rng in enumerate(week_ranges, start=1)
    ]
    return compute_playoff_options(team_count, weeks)


def _round_label(round_index: int, total_rounds: int, playoff_teams: int) -> str:
    if total_rounds <= 1:
        return "Final"
    if total_rounds == 2:
        return "Semifinals" if round_index == 1 else "Final"
    if total_rounds == 3:
        if playoff_teams == 6:
            labels = ["First Round", "Semifinals", "Final"]
        else:
            labels = ["Quarterfinals", "Semifinals", "Final"]
        return labels[round_index - 1]
    return f"Round {round_index}"


def _round_definitions(team_count: int, reseed: bool) -> List[Dict[str, Any]]:
    reseed_note = "Matchups in this round are subject to reseeding." if reseed else None
    if team_count == 4:
        return [
            {
                "pairs": [
                    (("seed", 1), ("seed", 4)),
                    (("seed", 2), ("seed", 3)),
                ]
            },
            {
                "pairs": [
                    (("winner", "R1M1"), ("winner", "R1M2")),
                ]
            },
        ]
    if team_count == 6:
        return [
            {
                "pairs": [
                    (("seed", 3), ("seed", 6)),
                    (("seed", 4), ("seed", 5)),
                ]
            },
            {
                "pairs": [
                    (("seed", 1), ("winner", "R1M2")),
                    (("seed", 2), ("winner", "R1M1")),
                ],
                "note": reseed_note,
            },
            {
                "pairs": [
                    (("winner", "R2M1"), ("winner", "R2M2")),
                ]
            },
        ]
    if team_count == 8:
        return [
            {
                "pairs": [
                    (("seed", 1), ("seed", 8)),
                    (("seed", 4), ("seed", 5)),
                    (("seed", 3), ("seed", 6)),
                    (("seed", 2), ("seed", 7)),
                ]
            },
            {
                "pairs": [
                    (("winner", "R1M1"), ("winner", "R1M2")),
                    (("winner", "R1M3"), ("winner", "R1M4")),
                ],
                "note": reseed_note,
            },
            {
                "pairs": [
                    (("winner", "R2M1"), ("winner", "R2M2")),
                ]
            },
        ]
    raise ValueError(f"Unsupported playoff team count: {team_count}")


def _source_descriptor(source: Tuple[str, Any]) -> Dict[str, Any]:
    kind, value = source
    return {"type": kind, "value": value}


def _seed_summary(seed_lookup: Dict[int, Dict[str, Any]], seed: int) -> Optional[Dict[str, Any]]:
    entry = seed_lookup.get(seed)
    if not entry:
        return None
    return {
        "seed": seed,
        "team": entry.get("team"),
        "wins": entry.get("wins"),
        "losses": entry.get("losses"),
        "ties": entry.get("ties"),
        "win_pct": entry.get("win_pct"),
        "points_for": entry.get("points_for"),
        "points_against": entry.get("points_against"),
    }


def _build_match_description(seed_lookup: Dict[int, Dict[str, Any]], sources: Dict[str, Dict[str, Any]]) -> str:
    def label(source: Dict[str, Any]) -> str:
        stype = source.get("type")
        value = source.get("value")
        if stype == "seed":
            seed_num = int(value)
            team = seed_lookup.get(seed_num, {}).get("team")
            if team:
                return f"Seed {seed_num} ({team})"
            return f"Seed {seed_num}"
        if stype == "winner":
            return f"Winner of {value}"
        return str(value)

    home = label(sources.get("home", {}))
    away = label(sources.get("away", {}))
    return f"{home} vs {away}"


def _prepare_playoff_preview_components(state: LeagueState) -> Tuple[
    List[Dict[str, Any]],
    List[Dict[str, Any]],
    Dict[str, Any],
    List[Dict[str, Any]],
]:
    config = state.playoffs_config
    if not config.is_enabled:
        raise ValueError("Playoffs are not enabled for this league.")
    if not config.week_indices:
        raise ValueError("Playoff configuration is missing scheduled weeks.")

    start_week = min(config.week_indices)
    standings_cutoff = start_week - 1 if start_week > 0 else None
    standings = compute_head_to_head_standings(state, through_week=standings_cutoff)
    if len(standings) < (config.teams or 0):
        raise ValueError("Not enough teams available to seed the playoffs.")

    seeds: List[Dict[str, Any]] = []
    for index, record in enumerate(standings[: config.teams], start=1):
        seed_entry = dict(record)
        seed_entry["seed"] = index
        seeds.append(seed_entry)
    seed_lookup = {entry["seed"]: entry for entry in seeds}

    round_definitions = _round_definitions(config.teams or 0, config.reseed)
    total_rounds = len(round_definitions)
    rounds_output: List[Dict[str, Any]] = []

    for round_index, round_definition in enumerate(round_definitions, start=1):
        week_idx = config.week_indices[min(round_index - 1, len(config.week_indices) - 1)]
        matchups_output: List[Dict[str, Any]] = []
        for match_idx, pair in enumerate(round_definition.get("pairs", []), start=1):
            match_id = f"R{round_index}M{match_idx}"
            source_home = _source_descriptor(pair[0])
            source_away = _source_descriptor(pair[1])
            match_entry: Dict[str, Any] = {
                "id": match_id,
                "status": "scheduled",
                "sources": {
                    "home": source_home,
                    "away": source_away,
                },
                "description": _build_match_description(seed_lookup, {"home": source_home, "away": source_away}),
            }
            if source_home.get("type") == "seed":
                seed_num = int(source_home["value"])
                match_entry["home_seed"] = seed_num
                match_entry["home"] = _seed_summary(seed_lookup, seed_num)
            if source_away.get("type") == "seed":
                seed_num = int(source_away["value"])
                match_entry["away_seed"] = seed_num
                match_entry["away"] = _seed_summary(seed_lookup, seed_num)
            if config.reseed and round_index > 1:
                match_entry["reseed"] = True
            note = round_definition.get("note")
            if note and round_index > 1:
                match_entry["note"] = note
            matchups_output.append(match_entry)
        rounds_output.append(
            {
                "index": round_index,
                "name": _round_label(round_index, total_rounds, config.teams or 0),
                "week_index": week_idx,
                "matchups": matchups_output,
                "note": round_definition.get("note"),
            }
        )

    latest_playoff_week_idx = max(config.week_indices)
    metadata = {
        "start_week": start_week,
        "end_week": latest_playoff_week_idx,
        "start_week_name": state.weeks[start_week - 1]["name"] if 0 < start_week <= len(state.weeks) else None,
        "end_week_name": state.weeks[latest_playoff_week_idx - 1]["name"] if 0 < latest_playoff_week_idx <= len(state.weeks) else None,
        "reseed": config.reseed,
        "consolation": config.consolation,
    }

    consolation_teams = standings[config.teams :] if config.consolation else []
    return seeds, rounds_output, metadata, consolation_teams


def _generate_playoff_structure(state: LeagueState) -> Dict[str, Any]:
    seeds, rounds_output, metadata, consolation_teams = _prepare_playoff_preview_components(state)
    seed_lookup = {entry["seed"]: entry for entry in seeds}
    rounds: List[Dict[str, Any]] = []
    for round_data in rounds_output:
        matchups: List[Dict[str, Any]] = []
        for match in round_data.get("matchups", []):
            matchups.append(
                {
                    "id": match["id"],
                    "week_index": round_data["week_index"],
                    "round_index": round_data["index"],
                    "sources": match.get("sources", {}),
                    "home_seed": match.get("home_seed"),
                    "away_seed": match.get("away_seed"),
                    "home_team": (match.get("home") or {}).get("team") if isinstance(match.get("home"), dict) else match.get("home"),
                    "away_team": (match.get("away") or {}).get("team") if isinstance(match.get("away"), dict) else match.get("away"),
                    "description": match.get("description"),
                    "note": match.get("note"),
                    "status": match.get("status", "scheduled"),
                }
            )
        rounds.append(
            {
                "index": round_data["index"],
                "name": round_data["name"],
                "week_index": round_data["week_index"],
                "note": round_data.get("note"),
                "matchups": matchups,
            }
        )
    return {
        "seeds": seeds,
        "seed_lookup": seed_lookup,
        "rounds": rounds,
        "metadata": metadata,
        "consolation_teams": consolation_teams,
    }


def build_playoff_preview(state: LeagueState) -> Dict[str, Any]:
    config = state.playoffs_config
    payload: Dict[str, Any] = {
        "league_id": state.league_id,
        "phase": state.phase,
        "config": config.to_dict(),
        "preview": True,
    }
    if not config.is_enabled:
        payload.update(
            {
                "enabled": False,
                "message": "Playoffs are currently disabled.",
                "bracket": None,
                "consolation": None,
            }
        )
        return payload

    seeds, rounds_output, metadata, consolation_teams = _prepare_playoff_preview_components(state)

    consolation_payload: Optional[Dict[str, Any]] = None
    if config.consolation:
        consolation_payload = {
            "enabled": True,
            "teams": consolation_teams,
            "description": "Consolation matchups will use remaining teams.",
        }

    payload.update(
        {
            "enabled": True,
            "bracket": {
                "seeds": seeds,
                "rounds": rounds_output,
                "metadata": metadata,
            },
            "consolation": consolation_payload or {"enabled": False},
        }
    )
    return payload


def _initialize_playoff_matchup_result(
    state: LeagueState,
    matchup_id: str,
    week_index: int,
    home_team: Optional[str],
    away_team: Optional[str],
) -> None:
    entry = state.weekly_results.get(matchup_id)
    if entry is None:
        entry = {
            "matchup_id": matchup_id,
            "week_index": week_index,
            "teams": {},
            "days": [],
        }
        state.weekly_results[matchup_id] = entry
    else:
        entry["matchup_id"] = matchup_id
        entry["week_index"] = week_index
        entry["days"] = []
        entry["teams"] = {}

    for team_name in [home_team, away_team]:
        if team_name:
            entry["teams"][team_name] = {
                "team": team_name,
                "total": 0.0,
                "players": {},
                "daily_totals": {},
            }


def _apply_playoff_round_to_week(state: LeagueState, round_entry: Dict[str, Any]) -> None:
    week_index = int(round_entry.get("week_index", 0) or 0)
    if week_index <= 0 or week_index > len(state.weeks):
        return
    week = state.weeks[week_index - 1]
    existing_ids = [str(matchup.get("id")) for matchup in week.get("matchups") or []]
    matchups_payload: List[Dict[str, Any]] = []
    new_ids: List[str] = []
    seeds_lookup: Dict[int, Dict[str, Any]] = {}
    try:
        if state.playoffs and isinstance(state.playoffs.get("seeds"), dict):
            seeds_lookup = {int(k): v for k, v in state.playoffs.get("seeds").items()}
    except Exception:  # noqa: BLE001
        seeds_lookup = {}

    for match in round_entry.get("matchups", []):
        matchup_id = str(match.get("matchup_id") or f"playoff-{match.get('id', '').lower()}")
        match["matchup_id"] = matchup_id
        new_ids.append(matchup_id)
        home_team = match.get("home_team") or ""
        away_team = match.get("away_team") or ""
        if not home_team and match.get("home_seed"):
            home_team = (seeds_lookup.get(int(match.get("home_seed"))) or {}).get("team") or ""
        if not away_team and match.get("away_seed"):
            away_team = (seeds_lookup.get(int(match.get("away_seed"))) or {}).get("team") or ""
        matchups_payload.append(
            {
                "id": matchup_id,
                "type": "playoff",
                "round": round_entry.get("index"),
                "bracket_id": match.get("id"),
                "teams": [
                    {"name": home_team, "seed": match.get("home_seed")},
                    {"name": away_team, "seed": match.get("away_seed")},
                ],
            }
        )
        _initialize_playoff_matchup_result(state, matchup_id, week_index, home_team, away_team)

    week["matchups"] = matchups_payload
    week["playoff_round"] = round_entry.get("index")
    if round_entry.get("status") == "completed":
        week["status"] = "completed"

    for old_id in existing_ids:
        if old_id not in new_ids:
            state.weekly_results.pop(old_id, None)


def _resolve_playoff_source(
    source: Dict[str, Any],
    seeds_lookup: Dict[int, Dict[str, Any]],
    winner_lookup: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    stype = source.get("type")
    value = source.get("value")
    if stype == "seed":
        seed_num = int(value)
        entry = seeds_lookup.get(seed_num, {})
        return {"team": entry.get("team"), "seed": seed_num}
    if stype == "winner":
        winner = winner_lookup.get(str(value))
        if winner:
            return {"team": winner.get("team"), "seed": winner.get("seed")}
    return {"team": None, "seed": None}


def _assign_next_round_matchup(
    match: Dict[str, Any],
    home_info: Dict[str, Any],
    away_info: Dict[str, Any],
) -> None:
    match["home_team"] = home_info.get("team")
    match["away_team"] = away_info.get("team")
    match["home_seed"] = home_info.get("seed")
    match["away_seed"] = away_info.get("seed")
    match["status"] = "scheduled"
    match["result"] = None
    match.pop("winner", None)
    match.pop("loser", None)
    match.pop("home_total", None)
    match.pop("away_total", None)


def _prepare_next_round(state: LeagueState, next_round: Dict[str, Any], winners: List[Dict[str, Any]]) -> None:
    config = state.playoffs_config
    seeds_lookup = state.playoffs.get("seeds", {}) if state.playoffs else {}
    previous_round_index = next_round.get("index", 1) - 1
    previous_round = None
    if state.playoffs:
        rounds = state.playoffs.get("rounds") or []
        if 0 <= previous_round_index - 1 < len(rounds):
            previous_round = rounds[previous_round_index - 1]
    winner_lookup = {}
    if previous_round:
        for match in previous_round.get("matchups", []):
            winner_lookup[str(match.get("id"))] = match.get("winner")

    if config.reseed and next_round.get("index", 0) > 1:
        seeded_winners = [w for w in winners if w.get("seed") is not None]
        seeded_winners.sort(key=lambda item: item["seed"])
        pairs: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        while len(seeded_winners) >= 2:
            top = seeded_winners.pop(0)
            bottom = seeded_winners.pop(-1)
            pairs.append((top, bottom))
        while seeded_winners:
            remaining = seeded_winners.pop(0)
            pairs.append((remaining, {"team": None, "seed": None}))
        for match, pairing in zip(next_round.get("matchups", []), pairs):
            home_info, away_info = pairing
            _assign_next_round_matchup(match, home_info, away_info)
    else:
        for match in next_round.get("matchups", []):
            sources = match.get("sources", {})
            home_info = _resolve_playoff_source(sources.get("home", {}), seeds_lookup, winner_lookup)
            away_info = _resolve_playoff_source(sources.get("away", {}), seeds_lookup, winner_lookup)
            _assign_next_round_matchup(match, home_info, away_info)

    _apply_playoff_round_to_week(state, next_round)
    next_round["status"] = "pending"


def _finalize_playoff_round(state: LeagueState, week_index: int) -> None:
    playoffs = state.playoffs or {}
    rounds = playoffs.get("rounds") or []
    round_entry = next((rnd for rnd in rounds if int(rnd.get("week_index", 0) or 0) == week_index), None)
    if not round_entry or round_entry.get("status") == "completed":
        return

    seeds_lookup = playoffs.get("seeds", {})
    winners: List[Dict[str, Any]] = []
    losers: List[Dict[str, Any]] = []

    for match in round_entry.get("matchups", []):
        matchup_id = match.get("matchup_id") or f"playoff-{match.get('id', '').lower()}"
        entry = state.weekly_results.get(matchup_id)
        if not entry:
            continue
        teams_data = entry.get("teams") or {}
        totals_map = {team: float(info.get("total", 0.0)) for team, info in teams_data.items()}
        seeds_map = {}
        for seed_value, seed_info in seeds_lookup.items():
            team_name = seed_info.get("team")
            if team_name:
                seeds_map[team_name] = int(seed_value)
        home_team = match.get("home_team")
        away_team = match.get("away_team")
        if not home_team and totals_map:
            home_team = list(totals_map.keys())[0]
        if not away_team and len(totals_map) > 1:
            away_team = list(totals_map.keys())[1]
        total_home = totals_map.get(home_team, 0.0)
        total_away = totals_map.get(away_team, 0.0)
        seed_home = match.get("home_seed", seeds_map.get(home_team))
        seed_away = match.get("away_seed", seeds_map.get(away_team))

        if total_home == total_away:
            if seed_home is not None and seed_away is not None:
                winner_is_home = seed_home < seed_away
            else:
                winner_is_home = True
        else:
            winner_is_home = total_home > total_away

        if winner_is_home:
            winner_team, winner_seed, winner_total = home_team, seed_home, total_home
            loser_team, loser_seed, loser_total = away_team, seed_away, total_away
        else:
            winner_team, winner_seed, winner_total = away_team, seed_away, total_away
            loser_team, loser_seed, loser_total = home_team, seed_home, total_home

        match["status"] = "completed"
        match["winner"] = {"team": winner_team, "seed": winner_seed, "total": round(winner_total, 1)}
        match["loser"] = {"team": loser_team, "seed": loser_seed, "total": round(loser_total, 1)}
        match["home_total"] = round(total_home, 1)
        match["away_total"] = round(total_away, 1)
        match["result"] = match["winner"]

        winners.append({"team": winner_team, "seed": winner_seed})
        losers.append({"team": loser_team, "seed": loser_seed})

    round_entry["status"] = "completed"
    playoffs.setdefault("elimination_log", []).append(
        {
            "round": round_entry.get("index"),
            "losers": losers,
        }
    )
    playoffs["current_round"] = round_entry.get("index", playoffs.get("current_round", 1))

    rounds = playoffs.get("rounds") or []
    current_round_index = round_entry.get("index", 0)
    if current_round_index < len(rounds):
        next_round = rounds[current_round_index]
        _prepare_next_round(state, next_round, winners)
        playoffs["current_round"] = next_round.get("index", playoffs.get("current_round", 1))
    else:
        playoffs["completed"] = True
        state.phase = "finished"
        final_match = round_entry.get("matchups", [])[:1]
        final_match = final_match[0] if final_match else {}
        champion = (final_match.get("winner") or {}).get("team")
        runner_up = (final_match.get("loser") or {}).get("team")
        placements: List[Dict[str, Any]] = []
        seen: set[str] = set()

        def _add_placement(team: Optional[str]) -> None:
            if not team:
                return
            norm = _normalize_team_name(team)
            if norm in seen:
                return
            seen.add(norm)
            placements.append({"team": team, "placement": len(placements) + 1})

        _add_placement(champion)
        _add_placement(runner_up)

        elimination_log = playoffs.get("elimination_log") or []
        for record in sorted(elimination_log, key=lambda item: item.get("round", 0)):
            round_idx = record.get("round")
            for loser in record.get("losers", []) or []:
                team_name = loser.get("team")
                if _normalize_team_name(team_name) in (_normalize_team_name(champion), _normalize_team_name(runner_up)):
                    continue
                _add_placement(team_name)

        playoffs["placements"] = placements
        playoffs["finalized_at"] = date.today().isoformat()

    consolation = playoffs.get("consolation")
    if consolation and consolation.get("enabled"):
        consolation.setdefault("results", []).append({"week_index": week_index, "losers": losers})


def _finalize_week(state: LeagueState, week_index: int) -> None:
    if not (1 <= week_index <= len(state.weeks)):
        return
    week = state.weeks[week_index - 1]
    if week.get("status") == "completed":
        return
    if state.playoffs_config.is_enabled and week_index in state.playoffs_config.week_indices and state.playoffs:
        _finalize_playoff_round(state, week_index)
    week["status"] = "completed"


def _maybe_finalize_week(state: LeagueState, week: Optional[Dict[str, Any]], current_date: date) -> None:
    if not week:
        return
    try:
        week_index = int(week.get("index", 0) or 0)
        if week_index <= 0:
            return
        if week.get("status") == "completed":
            return
        end_iso = week.get("end")
        if not end_iso:
            return
        end_date = date.fromisoformat(str(end_iso))
    except (TypeError, ValueError):
        return
    if current_date >= end_date:
        _finalize_week(state, week_index)


def _playoffs_should_start(state: LeagueState, week_index: Optional[int]) -> bool:
    config = state.playoffs_config
    if not config.is_enabled or not config.week_indices:
        return False
    if state.playoffs and state.playoffs.get("started"):
        return False
    return week_index == min(config.week_indices)


def _resolve_weekly_result_entry(
    state: LeagueState,
    matchup_id: str,
    week_index: Optional[int],
    team_names: List[str],
) -> Optional[Dict[str, Any]]:
    entry = state.weekly_results.get(matchup_id)
    if entry:
        return entry
    if week_index is None:
        return None
    normalized = {_normalize_team_name(name) for name in team_names if name}
    if not normalized:
        return None
    for candidate in state.weekly_results.values():
        try:
            candidate_week = int(candidate.get("week_index", 0) or 0)
        except Exception:  # noqa: BLE001
            continue
        if candidate_week != week_index:
            continue
        candidate_teams = candidate.get("teams") or {}
        candidate_names = {_normalize_team_name(name) for name in candidate_teams.keys()}
        if normalized.issubset(candidate_names):
            return candidate
    return None


def _get_playoff_matchups_for_week(state: LeagueState, week_index: Optional[int]) -> Optional[List[Dict[str, Any]]]:
    if not state.playoffs or week_index is None:
        return None
    try:
        week_index = int(week_index)
    except (TypeError, ValueError):
        return None
    round_entry = next(
        (rnd for rnd in (state.playoffs.get("rounds") or []) if int(rnd.get("week_index", 0) or 0) == week_index),
        None,
    )
    if not round_entry:
        return None

    seeds_lookup: Dict[int, Dict[str, Any]] = {}
    try:
        if isinstance(state.playoffs.get("seeds"), dict):
            seeds_lookup = {int(k): v for k, v in state.playoffs.get("seeds").items()}
    except Exception:  # noqa: BLE001
        seeds_lookup = {}

    matchups: List[Dict[str, Any]] = []
    for match in round_entry.get("matchups", []):
        matchup_id = str(match.get("matchup_id") or f"playoff-{str(match.get('id') or '').lower()}")
        home = match.get("home_team") or ""
        away = match.get("away_team") or ""
        if not home and match.get("home_seed"):
            home = (seeds_lookup.get(int(match.get("home_seed"))) or {}).get("team") or ""
        if not away and match.get("away_seed"):
            away = (seeds_lookup.get(int(match.get("away_seed"))) or {}).get("team") or ""
        matchups.append(
            {
                "id": matchup_id,
                "teams": [
                    {"name": home},
                    {"name": away},
                ],
                "_source": match,
            }
        )
    return matchups if matchups else None


def _initialize_playoffs(state: LeagueState) -> None:
    structure = _generate_playoff_structure(state)
    rounds_state: List[Dict[str, Any]] = []
    for round_data in structure.get("rounds", []):
        matchups_state: List[Dict[str, Any]] = []
        for match in round_data.get("matchups", []):
            matchup_id = f"playoff-{match.get('id', '').lower()}"
            matchups_state.append(
                {
                    "id": match.get("id"),
                    "matchup_id": matchup_id,
                    "sources": match.get("sources", {}),
                    "home_seed": match.get("home_seed"),
                    "away_seed": match.get("away_seed"),
                    "home_team": match.get("home_team"),
                    "away_team": match.get("away_team"),
                    "status": "scheduled",
                    "result": None,
                }
            )
        rounds_state.append(
            {
                "index": round_data.get("index"),
                "name": round_data.get("name"),
                "week_index": round_data.get("week_index"),
                "note": round_data.get("note"),
                "status": "pending",
                "matchups": matchups_state,
            }
        )

    state.playoffs = {
        "started": True,
        "completed": False,
        "current_round": 1,
        "config": state.playoffs_config.to_dict(),
        "seeds": {entry["seed"]: entry for entry in structure.get("seeds", [])},
        "rounds": rounds_state,
        "consolation": {
            "enabled": state.playoffs_config.consolation,
            "teams": structure.get("consolation_teams", []),
            "results": [],
        },
    }
    state.phase = "playoffs"
    if rounds_state:
        # Populate the first round team names from seeds/sources and activate it
        _prepare_next_round(state, rounds_state[0], [])
        rounds_state[0]["status"] = "active"


def _ensure_playoff_round_active(state: LeagueState, week_index: Optional[int]) -> None:
    if not state.playoffs or not week_index:
        return
    for round_entry in state.playoffs.get("rounds", []):
        if int(round_entry.get("week_index", 0) or 0) == week_index:
            if round_entry.get("status") == "pending":
                round_entry["status"] = "active"
                _apply_playoff_round_to_week(state, round_entry)
            break


def _maybe_initialize_playoffs(state: LeagueState, week_index: Optional[int]) -> None:
    if _playoffs_should_start(state, week_index):
        _initialize_playoffs(state)


def simulate_until_playoffs(
    state: LeagueState,
    game_logs: pd.DataFrame,
    player_stats: pd.DataFrame,
    schedule_df: pd.DataFrame | None = None,
) -> Dict[str, Any]:
    if not state.playoffs_config.is_enabled:
        raise ValueError("Enable playoffs before simulating to their start.")
    if state.playoffs and state.playoffs.get("started"):
        return {
            "message": "Playoffs already started.",
            "playoffs_started": True,
            "current_date": None if state.current_date is None else state.current_date.isoformat(),
        }

    simulated_days: List[str] = []
    max_iterations = max(1, len(state.calendar) * 3)
    iterations = 0

    while True:
        if state.playoffs and state.playoffs.get("started"):
            break
        if state.current_date is None:
            break
        if state.awaiting_simulation:
            current_date = state.current_date
            week = _find_week_for_date(state.weeks, current_date) if current_date else None
            week_index = int(week.get("index", 0) or 0) if week else None
            if _playoffs_should_start(state, week_index) and not (state.playoffs and state.playoffs.get("started")):
                _initialize_playoffs(state)
                _ensure_playoff_round_active(state, week_index)
                break
            result = simulate_day(
                state,
                game_logs=game_logs,
                player_stats=player_stats,
                scoring_profile_key=None,
                schedule_df=schedule_df,
            )
            simulated_days.append(str(result.get("date")))
        else:
            advance_league_day(state)
        iterations += 1
        if iterations > max_iterations:
            raise ValueError("Unable to reach playoff start. Check the playoff configuration.")

    save_league_state(state)
    return {
        "league_id": state.league_id,
        "current_date": None if state.current_date is None else state.current_date.isoformat(),
        "awaiting_simulation": state.awaiting_simulation,
        "phase": state.phase,
        "playoffs_started": bool(state.playoffs and state.playoffs.get("started")),
        "simulated_days": [day for day in simulated_days if day],
    }

def _serialize_active_playoffs(state: LeagueState) -> Dict[str, Any]:
    playoffs = state.playoffs or {}
    config_dict = state.playoffs_config.to_dict()
    seeds = list(playoffs.get("seeds", {}).values())
    seed_lookup = playoffs.get("seeds", {})
    rounds_output: List[Dict[str, Any]] = []
    for round_entry in playoffs.get("rounds", []):
        matchups_output: List[Dict[str, Any]] = []
        for match in round_entry.get("matchups", []):
            desc = match.get("description")
            home_team = match.get("home_team")
            away_team = match.get("away_team")
            if home_team and away_team:
                desc = f"{home_team} vs {away_team}"
            elif not desc:
                desc = _build_match_description(seed_lookup, match.get("sources", {}))
            matchups_output.append(
                {
                    "id": match.get("id"),
                    "matchup_id": match.get("matchup_id"),
                    "description": desc,
                    "status": match.get("status"),
                    "home_seed": match.get("home_seed"),
                    "away_seed": match.get("away_seed"),
                    "home_team": match.get("home_team"),
                    "away_team": match.get("away_team"),
                    "winner": match.get("winner"),
                    "loser": match.get("loser"),
                    "home_total": match.get("home_total"),
                    "away_total": match.get("away_total"),
                    "note": match.get("note"),
                }
            )
        rounds_output.append(
            {
                "index": round_entry.get("index"),
                "name": round_entry.get("name"),
                "week_index": round_entry.get("week_index"),
                "status": round_entry.get("status"),
                "matchups": matchups_output,
                "note": round_entry.get("note"),
            }
        )
    metadata = {
        "start_week": state.playoffs_config.week_indices[0] if state.playoffs_config.week_indices else None,
        "end_week": state.playoffs_config.week_indices[-1] if state.playoffs_config.week_indices else None,
        "reseed": state.playoffs_config.reseed,
        "consolation": state.playoffs_config.consolation,
    }
    payload = {
        "league_id": state.league_id,
        "phase": state.phase,
        "config": config_dict,
        "enabled": True,
        "preview": False,
        "status": "completed" if playoffs.get("completed") else "active",
        "bracket": {
            "seeds": seeds,
            "rounds": rounds_output,
            "metadata": metadata,
        },
        "consolation": playoffs.get("consolation") or {"enabled": False},
    }
    if playoffs.get("placements"):
        payload["placements"] = playoffs.get("placements")
    if playoffs.get("finalized_at"):
        payload["finalized_at"] = playoffs.get("finalized_at")
    return payload

    if _playoffs_should_start(state, week_index):
        _initialize_playoffs(state)





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
    week_index_val = int(week.get("index", 0) or 0)
    matchups = _get_playoff_matchups_for_week(state, week_index_val) or week.get("matchups") or []
    for result in team_results:
        target_matchup = None
        for matchup in matchups:
            teams = matchup.get("teams") or []
            if any(_normalize_team_name(team.get("name")) == _normalize_team_name(result.team) for team in teams):
                target_matchup = matchup
                break
        if target_matchup is None:
            continue
        entry = _ensure_matchup_entry(state, target_matchup, week_index_val)
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
        # Use playoff bracket-defined matchups if a playoff round is scheduled for this week
        try:
            week_idx_for_overlay = int(week.get("index", 0) or 0)
        except Exception:  # noqa: BLE001
            week_idx_for_overlay = 0
        source_matchups = _get_playoff_matchups_for_week(state, week_idx_for_overlay) or week.get("matchups") or []

        for matchup in source_matchups:
            matchup_id = str(matchup.get("id"))
            entry = state.weekly_results.get(matchup_id)
            if entry is None:
                entry = _resolve_weekly_result_entry(
                    state,
                    matchup_id,
                    int(week.get("index", 0) or 0),
                    [team.get("name") for team in matchup.get("teams") or []],
                ) or {}
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


def compute_head_to_head_standings(state: LeagueState, through_week: Optional[int] = None) -> List[Dict[str, Any]]:
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
        week_index = int(week.get("index", 0) or 0)
        if through_week is not None and week_index > through_week:
            continue
        if state.playoffs_config.is_enabled and week_index in state.playoffs_config.week_indices:
            continue
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
    playoffs_config: Optional[Dict[str, Any]] = None,
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
    playoffs_cfg = validate_playoff_config(team_count, weeks, playoffs_config)
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
        playoffs_config=playoffs_cfg,
    )


def initialize_league(
    league_name: str,
    team_count: int,
    roster_size: int,
    scoring_profile_key: str,
    user_team_name: Optional[str] = None,
    team_names: Optional[List[str]] = None,
    league_id: Optional[str] = None,
    playoffs_config: Optional[Dict[str, Any]] = None,
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
        playoffs_config=playoffs_config,
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
    if state.phase == "finished":
        raise ValueError("This league has completed the playoffs.")
    if draft_is_active(state):
        raise ValueError("Complete the draft before simulating games.")
    if not state.awaiting_simulation:
        raise ValueError("Today's games have already been simulated.")

    week = _find_week_for_date(state.weeks, current_date)
    week_index = int(week.get("index", 0) or 0) if week else None
    _maybe_initialize_playoffs(state, week_index)
    week = _find_week_for_date(state.weeks, current_date)
    week_index = int(week.get("index", 0) or 0) if week else None
    _ensure_playoff_round_active(state, week_index)

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
    _maybe_finalize_week(state, week, current_date)
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
    try:
        state.playoffs_config = validate_playoff_config(state.team_count, state.weeks, state.playoffs_config.to_dict())
    except ValueError:
        state.playoffs_config = PlayoffConfig()
    state.phase = "regular"
    state.playoffs = None
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
    if state.phase == "finished":
        raise ValueError("This league has completed the playoffs.")
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
