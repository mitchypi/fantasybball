from __future__ import annotations

from collections import Counter
from typing import Sequence

import pandas as pd

from .config import settings

NUMERIC_STAT_COLUMNS: Sequence[str] = (
    "PTS",
    "OREB",
    "DREB",
    "TREB",
    "AST",
    "STL",
    "BLK",
    "3PM",
    "3PA",
    "MPG",
    "FGM",
    "FGA",
    "FG_MISS",
    "FTM",
    "FTA",
    "FT_MISS",
    "TOV",
    "TO",
    "PF",
    "DD",
    "TD",
    "DOUBLE_DOUBLE",
    "TRIPLE_DOUBLE",
    "FG3M",
    "FG3A",
    "REB",
    "MINUTES",
    "PLUS_MINUS",
)


def load_player_game_logs(season: str | None = None) -> pd.DataFrame:
    """Load cached per-game logs for every player in the season."""
    season = season or settings.season
    path = settings.game_logs_path(season)
    if not path.exists():
        raise FileNotFoundError(
            f"Missing cached game logs at {path}. Run `python scripts/download_player_stats.py --season {season}` first."
        )
    df = pd.read_csv(path, parse_dates=["GAME_DATE"])
    df.columns = [col.upper() for col in df.columns]
    _attach_alias_columns(df)
    _attach_double_triple_flags(df)
    return df


def load_game_schedule(season: str | None = None) -> pd.DataFrame:
    """Load cached NBA game schedule and scores for the season."""
    season = season or settings.season
    path = settings.games_path(season)
    if not path.exists():
        raise FileNotFoundError(
            f"Missing cached game schedule at {path}. Run `python scripts/download_player_stats.py --season {season}` first."
        )
    df = pd.read_csv(path, parse_dates=["GAME_DATE"])
    df.columns = [col.upper() for col in df.columns]
    _attach_alias_columns(df)
    return df


def _most_common(value_series: pd.Series) -> str:
    non_null = value_series.dropna()
    if non_null.empty:
        return ""
    counts = Counter(non_null)
    return counts.most_common(1)[0][0]


def player_season_averages(game_logs: pd.DataFrame) -> pd.DataFrame:
    """Aggregate per-game logs into season averages per player, ignoring DNPs."""
    if game_logs.empty:
        columns = ["PLAYER_ID", "PLAYER_NAME", "TEAM_ABBREVIATION", "GP", *NUMERIC_STAT_COLUMNS]
        return pd.DataFrame(columns=columns)

    logs = game_logs.copy()
    group_keys = ["PLAYER_ID", "PLAYER_NAME"]
    numeric_cols = [col for col in NUMERIC_STAT_COLUMNS if col in logs.columns]

    if "MINUTES" in logs.columns:
        logs["MINUTES"] = pd.to_numeric(logs["MINUTES"], errors="coerce").fillna(0.0)
        played_mask = logs["MINUTES"] > 0
    else:
        played_mask = pd.Series(True, index=logs.index)

    played_logs = logs.loc[played_mask].copy()

    base = logs[group_keys].drop_duplicates()

    if "TEAM_ABBREVIATION" in logs.columns:
        team_mode = (
            logs.groupby(group_keys)["TEAM_ABBREVIATION"]
            .agg(_most_common)
            .reset_index()
        )
        base = base.merge(team_mode, on=group_keys, how="left")
    else:
        base["TEAM_ABBREVIATION"] = ""

    if numeric_cols and not played_logs.empty:
        totals = played_logs.groupby(group_keys)[numeric_cols].sum(numeric_only=True).reset_index()
        base = base.merge(totals, on=group_keys, how="left")
        gp = played_logs.groupby(group_keys).size().reset_index(name="GP")
    else:
        for col in numeric_cols:
            base[col] = 0.0
        gp = pd.DataFrame(columns=[*group_keys, "GP"])

    base = base.merge(gp, on=group_keys, how="left")
    base["GP"] = base["GP"].fillna(0).astype(int)

    for col in numeric_cols:
        base[col] = pd.to_numeric(base[col], errors="coerce").fillna(0.0)
        played = base["GP"] > 0
        base.loc[played, col] = base.loc[played, col] / base.loc[played, "GP"]
        base.loc[~played, col] = 0.0

    base["TEAM_ABBREVIATION"] = base["TEAM_ABBREVIATION"].fillna("")

    columns = ["PLAYER_ID", "PLAYER_NAME", "TEAM_ABBREVIATION", "GP", *numeric_cols]
    existing_columns = [col for col in columns if col in base.columns]
    return base[existing_columns]


def compute_fantasy_points(df: pd.DataFrame, scoring_weights: dict[str, float]) -> pd.DataFrame:
    """Return a DataFrame with a derived `FANTASY_POINTS` column based on scoring weights."""
    missing = [stat for stat in scoring_weights if stat not in df.columns]
    if missing:
        raise ValueError(
            "The cached stats are missing required columns for the scoring profile: "
            + ", ".join(sorted(missing))
        )
    fantasy = df.copy()
    fantasy["FANTASY_POINTS"] = sum(fantasy[stat] * weight for stat, weight in scoring_weights.items())
    return fantasy
def _attach_double_triple_flags(df: pd.DataFrame) -> None:
    """Annotate per-game logs with double-double and triple-double flags."""
    key_stats = ["PTS", "REB", "AST", "STL", "BLK"]
    available = [stat for stat in key_stats if stat in df.columns]
    if not available:
        df["DOUBLE_DOUBLE"] = 0
        df["TRIPLE_DOUBLE"] = 0
        df["DD"] = 0
        df["TD"] = 0
        return
    thresholds = df[available].ge(10)
    counts = thresholds.sum(axis=1)
    double_mask = counts >= 2
    triple_mask = counts >= 3
    df["DOUBLE_DOUBLE"] = double_mask.astype(int)
    df["TRIPLE_DOUBLE"] = triple_mask.astype(int)
    df["DD"] = df["DOUBLE_DOUBLE"]
    df["TD"] = df["TRIPLE_DOUBLE"]
def _attach_alias_columns(df: pd.DataFrame) -> None:
    """Add derived stat aliases used for scoring configuration."""
    if "GAME_ID" in df.columns:
        game_ids = pd.to_numeric(df["GAME_ID"], errors="coerce")
        df["GAME_ID"] = game_ids.fillna(0).astype(int)
    if "TEAM_ABBREVIATION" in df.columns:
        df["TEAM_ABBREVIATION"] = df["TEAM_ABBREVIATION"].astype(str).str.upper()
    if "REB" in df.columns:
        df["TREB"] = df["REB"]
    if "FG3M" in df.columns:
        df["3PM"] = df["FG3M"]
    if "FG3A" in df.columns:
        df["3PA"] = df["FG3A"]
    if "MINUTES" in df.columns:
        df["MPG"] = df["MINUTES"]
    if {"FGA", "FGM"}.issubset(df.columns):
        df["FG_MISS"] = df["FGA"] - df["FGM"]
    if {"FTA", "FTM"}.issubset(df.columns):
        df["FT_MISS"] = df["FTA"] - df["FTM"]
    if "TOV" in df.columns:
        df["TO"] = df["TOV"]
