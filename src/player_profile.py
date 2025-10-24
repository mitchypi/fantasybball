from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

from .config import settings
from .data_loader import compute_fantasy_points, player_season_averages

RAW_PLAYERS_PATH = Path(__file__).resolve().parent.parent / "rawplayers.json"

STAT_FIELDS = [
    "MINUTES",
    "FGM",
    "FGA",
    "FG_PCT",
    "FG3M",
    "FG3A",
    "FG3_PCT",
    "FTM",
    "FTA",
    "FT_PCT",
    "OREB",
    "DREB",
    "REB",
    "AST",
    "STL",
    "BLK",
    "TO",
    "TOV",
    "PF",
    "PTS",
]

SUMMARY_FIELD_SOURCES = [
    ("MIN", ("MINUTES", "MPG")),
    ("PTS", ("PTS",)),
    ("FGM", ("FGM",)),
    ("FGA", ("FGA",)),
    ("FG3M", ("FG3M", "3PM")),
    ("FG3A", ("FG3A", "3PA")),
    ("FTM", ("FTM",)),
    ("FTA", ("FTA",)),
    ("OREB", ("OREB",)),
    ("DREB", ("DREB",)),
    ("REB", ("REB", "TREB")),
    ("AST", ("AST",)),
    ("STL", ("STL",)),
    ("BLK", ("BLK",)),
    ("PF", ("PF",)),
    ("TOV", ("TO", "TOV")),
]

PERCENT_FIELD_SOURCES = {
    "FG_PCT": (("FGM",), ("FGA",)),
    "FG3_PCT": (("FG3M", "3PM"), ("FG3A", "3PA")),
    "FT_PCT": (("FTM",), ("FTA",)),
}

SUMMARY_KEYS = [key for key, _ in SUMMARY_FIELD_SOURCES]
PERCENT_KEYS = list(PERCENT_FIELD_SOURCES.keys())


def load_player_images(raw_path: Path | None = None) -> Dict[str, str]:
    path = raw_path or RAW_PLAYERS_PATH
    mapping: Dict[str, str] = {}
    if not path.exists():
        return mapping

    text = path.read_text(encoding="utf-8", errors="ignore")
    marker = '"players":['
    if marker not in text:
        return mapping

    start = text.index(marker) + len(marker)
    length = len(text)
    i = start
    while i < length:
        ch = text[i]
        if ch == "{":
            depth = 0
            j = i
            while j < length:
                cj = text[j]
                if cj == "{":
                    depth += 1
                elif cj == "}":
                    depth -= 1
                    if depth == 0:
                        block = text[i : j + 1]
                        try:
                            name = block.split('"name":"', 1)[1].split('"', 1)[0]
                            img = block.split('"imgURL":"', 1)[1].split('"', 1)[0]
                        except (IndexError, ValueError):
                            pass
                        else:
                            mapping.setdefault(name, img)
                        i = j + 1
                        break
                j += 1
            else:
                break
        elif ch == "]":
            break
        else:
            i += 1
    return mapping


def build_team_lookup(schedule_df: pd.DataFrame | None) -> Dict[str, str]:
    if schedule_df is None:
        return {}
    mapping: Dict[str, str] = {}
    for column_pair in [
        ("HOME_TEAM_ABBREVIATION", "HOME_TEAM_FULL_NAME"),
        ("VISITOR_TEAM_ABBREVIATION", "VISITOR_TEAM_FULL_NAME"),
    ]:
        abbr_col, name_col = column_pair
        if abbr_col not in schedule_df.columns:
            continue
        for abbr, full in schedule_df[[abbr_col, name_col]].dropna().drop_duplicates().itertuples(index=False):
            if abbr:
                mapping.setdefault(str(abbr), str(full))
    return mapping


def _pick_column(df: pd.DataFrame, options: tuple[str, ...]) -> Optional[str]:
    for option in options:
        if option in df.columns:
            return option
    return None


def _aggregate_stats(df: pd.DataFrame) -> Dict[str, float]:
    if df.empty:
        stats = {}
        for key, _ in SUMMARY_FIELD_SOURCES:
            stats[key] = 0.0
        for key in PERCENT_FIELD_SOURCES:
            stats[key] = 0.0
        return stats

    df_numeric = df.copy()
    for column in df_numeric.columns:
        if pd.api.types.is_numeric_dtype(df_numeric[column]):
            continue
        df_numeric[column] = pd.to_numeric(df_numeric[column], errors="coerce")

    games = max(len(df_numeric), 1)
    stats: Dict[str, float] = {}

    for key, options in SUMMARY_FIELD_SOURCES:
        column = _pick_column(df_numeric, options)
        if column is None:
            stats[key] = 0.0
            continue
        series = pd.to_numeric(df_numeric[column], errors="coerce")
        stats[key] = float(series.sum(skipna=True) / games) if not series.empty else 0.0

    for key, (num_options, den_options) in PERCENT_FIELD_SOURCES.items():
        num_col = _pick_column(df_numeric, num_options)
        den_col = _pick_column(df_numeric, den_options)
        if not num_col or not den_col:
            stats[key] = 0.0
            continue
        num = pd.to_numeric(df_numeric[num_col], errors="coerce").sum(skipna=True)
        den = pd.to_numeric(df_numeric[den_col], errors="coerce").sum(skipna=True)
        stats[key] = float(num / den * 100.0) if den else 0.0

    return stats


def _summary_row(
    label: str,
    df: pd.DataFrame,
    *,
    matchup: Optional[str] = None,
    result: Optional[str] = None,
    time: Optional[str] = None,
    games_label: Optional[str] = None,
    rank: Optional[int] = None,
) -> Dict[str, Any]:
    if df is None:
        df = pd.DataFrame()

    minutes_col = _pick_column(df, ("MINUTES", "MIN", "MPG"))
    if minutes_col and minutes_col in df.columns:
        minutes_series = pd.to_numeric(df[minutes_col], errors="coerce").fillna(0)
        filtered_df = df.loc[minutes_series > 0].copy()
    else:
        filtered_df = df.copy()

    games_played = int(len(filtered_df))
    if games_played:
        fantasy_total = float(pd.to_numeric(filtered_df["FANTASY_POINTS"], errors="coerce").fillna(0).sum())
    else:
        fantasy_total = 0.0
    fantasy_avg = fantasy_total / games_played if games_played else 0.0
    stats = _aggregate_stats(filtered_df)
    return {
        "label": label,
        "games_played": games_played,
        "matchup": matchup,
        "result": result,
        "time": time,
        "fantasy_points_avg": fantasy_avg,
        "fantasy_points_total": fantasy_total,
        "stats": stats,
        "games_label": games_label,
        "rank": rank,
    }


def _format_opponent(is_home: bool, opponent_abbr: str) -> str:
    prefix = "vs" if is_home else "@"
    return f"{prefix} {opponent_abbr}".strip()


def _resolve_game_meta(row: pd.Series, schedule_df: pd.DataFrame) -> Dict[str, Any]:
    try:
        sched = schedule_df.loc[schedule_df["GAME_ID"] == int(row["GAME_ID"])].iloc[0]
    except (KeyError, IndexError):
        return {
            "opponent_abbr": "",
            "opponent_name": "",
            "matchup": "",
            "result": "",
            "time": "",
            "status": "",
        }

    is_home = bool(row.get("IS_HOME", False))
    opp_abbr = (
        sched.get("VISITOR_TEAM_ABBREVIATION") if is_home else sched.get("HOME_TEAM_ABBREVIATION")
    ) or ""
    opp_name = (
        sched.get("VISITOR_TEAM_FULL_NAME") if is_home else sched.get("HOME_TEAM_FULL_NAME")
    ) or opp_abbr
    matchup = _format_opponent(is_home, opp_abbr)

    status = str(sched.get("STATUS", "")).lower()
    time = str(sched.get("TIME", "") or "")
    home_score = int(sched.get("HOME_TEAM_SCORE") or 0)
    away_score = int(sched.get("VISITOR_TEAM_SCORE") or 0)

    if status.startswith("final"):
        player_score = home_score if is_home else away_score
        opponent_score = away_score if is_home else home_score
        result_letter = "W" if player_score > opponent_score else "L"
        result_text = f"{result_letter} {player_score}-{opponent_score}"
    else:
        result_text = sched.get("STATUS", "")

    return {
        "opponent_abbr": opp_abbr,
        "opponent_name": opp_name,
        "matchup": matchup,
        "result": result_text,
        "time": time,
        "status": sched.get("STATUS", ""),
        "is_home": is_home,
    }


def _prepare_game_log(
    df: pd.DataFrame,
    schedule_df: pd.DataFrame,
    limit: Optional[int] = None,
) -> List[Dict[str, Any]]:
    if df.empty:
        return []
    logs: List[Dict[str, Any]] = []
    ordered = df.sort_values("GAME_DATE", ascending=False)
    if limit:
        ordered = ordered.head(limit)
    for row in ordered.itertuples(index=False):
        row_dict = row._asdict()
        meta = _resolve_game_meta(pd.Series(row_dict), schedule_df)
        row_df = pd.DataFrame([row_dict])
        stats = _aggregate_stats(row_df)
        entry = {
            "game_id": int(getattr(row, "GAME_ID")),
            "date": getattr(row, "GAME_DATE").date().isoformat(),
            "fantasy_points": float(getattr(row, "FANTASY_POINTS", 0.0)),
            "stats": stats,
            "matchup": meta["matchup"],
            "result": meta["result"],
            "time": meta["time"],
            "status": meta["status"],
        }
        logs.append(entry)
    return logs


def build_player_profile_payload(
    player_id: int,
    *,
    game_logs: pd.DataFrame,
    schedule_df: pd.DataFrame,
    scoring_name: Optional[str],
    scoring_weights: Dict[str, float],
    target_date: Optional[date],
    player_images: Dict[str, str],
    team_lookup: Dict[str, str],
    fantasy_team_name: Optional[str] = None,
) -> Dict[str, Any]:
    player_logs = game_logs[game_logs["PLAYER_ID"] == player_id].copy()
    if player_logs.empty:
        raise ValueError(f"No game logs available for player id {player_id}")

    global_logs = game_logs.copy()
    if not pd.api.types.is_datetime64_any_dtype(global_logs["GAME_DATE"]):
        global_logs.loc[:, "GAME_DATE"] = pd.to_datetime(global_logs["GAME_DATE"])

    fantasy_logs = compute_fantasy_points(player_logs, scoring_weights)
    fantasy_logs["GAME_DATE"] = pd.to_datetime(fantasy_logs["GAME_DATE"])

    if target_date is not None:
        target_timestamp = pd.Timestamp(target_date)
        past_logs = fantasy_logs[fantasy_logs["GAME_DATE"].dt.date <= target_date].copy()
    else:
        target_timestamp = None
        past_logs = fantasy_logs.copy()

    player_name = str(fantasy_logs["PLAYER_NAME"].iloc[0])
    team_abbr = str(fantasy_logs["TEAM_ABBREVIATION"].iloc[-1])
    team_name = team_lookup.get(team_abbr, team_abbr)
    positions = fantasy_logs["PLAYER_POSITION"].dropna().unique().tolist() if "PLAYER_POSITION" in fantasy_logs else []

    season_values = past_logs["GAME_SEASON"].dropna()
    current_season = int(season_values.max()) if not season_values.empty else None
    previous_season = int(current_season - 1) if current_season else None

    if target_timestamp is not None:
        day_logs = past_logs[past_logs["GAME_DATE"].dt.date == target_date]
        window_7 = past_logs[past_logs["GAME_DATE"] >= target_timestamp - pd.Timedelta(days=6)]
        window_14 = past_logs[past_logs["GAME_DATE"] >= target_timestamp - pd.Timedelta(days=13)]
        window_30 = past_logs[past_logs["GAME_DATE"] >= target_timestamp - pd.Timedelta(days=29)]
    else:
        day_logs = past_logs
        window_7 = past_logs
        window_14 = past_logs
        window_30 = past_logs
    season_logs = past_logs if current_season is None else past_logs[past_logs["GAME_SEASON"] == current_season]
    prev_season_logs = (
        past_logs[past_logs["GAME_SEASON"] == previous_season] if previous_season else pd.DataFrame(columns=past_logs.columns)
    )

    meta = (
        _resolve_game_meta(day_logs.iloc[0], schedule_df)
        if not day_logs.empty
        else {"matchup": "", "result": "", "time": ""}
    )

    season_rank = None
    season_fantasy_avg = None
    if target_date is not None:
        filtered_global_logs = global_logs[global_logs["GAME_DATE"].dt.date <= target_date].copy()
        if not filtered_global_logs.empty and not pd.api.types.is_datetime64_any_dtype(filtered_global_logs["GAME_DATE"]):
            filtered_global_logs.loc[:, "GAME_DATE"] = pd.to_datetime(filtered_global_logs["GAME_DATE"])
        if not filtered_global_logs.empty:
            season_averages_through_date = player_season_averages(filtered_global_logs)
            season_df = compute_fantasy_points(season_averages_through_date, scoring_weights)
            season_df = season_df.sort_values("FANTASY_POINTS", ascending=False).reset_index(drop=True)
            match = season_df[season_df["PLAYER_ID"] == player_id]
            if not match.empty:
                season_rank = int(match.index[0] + 1)
                season_fantasy_avg = float(match["FANTASY_POINTS"].iloc[0])

    def _season_label(season_value: Optional[int]) -> str:
        if season_value is None:
            return "Season (avg)"
        return f"{season_value}-{season_value + 1} season (avg)"

    summary = [
        _summary_row(
            "Today",
            day_logs,
            matchup=meta.get("matchup"),
            result=meta.get("result"),
            time=meta.get("time"),
            games_label="Today",
        ),
        _summary_row("Last 7 Days (avg)", window_7),
        _summary_row("Last 14 Days (avg)", window_14),
        _summary_row("Last 30 Days (avg)", window_30),
        _summary_row(
            _season_label(current_season),
            season_logs,
            rank=season_rank,
        ),
    ]

    if previous_season and not prev_season_logs.empty:
        summary.append(_summary_row(_season_label(previous_season), prev_season_logs))

    game_log = _prepare_game_log(past_logs, schedule_df)

    image_url = player_images.get(player_name)

    return {
        "player": {
            "id": player_id,
            "name": player_name,
            "positions": positions,
            "team_abbreviation": team_abbr,
            "team_name": team_name,
            "image_url": image_url,
            "fantasy_team": fantasy_team_name,
            "season_rank": season_rank,
            "season_fantasy_avg": season_fantasy_avg,
            "scoring_profile": scoring_name or settings.resolve_scoring_profile().name,
        },
        "summary": summary,
        "game_log": game_log,
        "target_date": None if target_date is None else target_date.isoformat(),
    }
