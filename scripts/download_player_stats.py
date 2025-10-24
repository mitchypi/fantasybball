from __future__ import annotations

import argparse
import time
from pathlib import Path
import sys
from typing import Dict, Iterable, List, Optional

import httpx
from httpx import HTTPStatusError
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from src.config import DATA_DIR, settings

BASE_URL = "https://api.balldontlie.io/v1"
STAT_KEY_MAP: Dict[str, str] = {
    "fgm": "FGM",
    "fga": "FGA",
    "fg3m": "FG3M",
    "fg3a": "FG3A",
    "ftm": "FTM",
    "fta": "FTA",
    "oreb": "OREB",
    "dreb": "DREB",
    "reb": "REB",
    "ast": "AST",
    "stl": "STL",
    "blk": "BLK",
    "turnover": "TOV",
    "pf": "PF",
    "pts": "PTS",
    "fg_pct": "FG_PCT",
    "fg3_pct": "FG3_PCT",
    "ft_pct": "FT_PCT",
    "plus_minus": "PLUS_MINUS",
}


def parse_season_to_year(season: str) -> int:
    if "-" in season:
        return int(season.split("-")[0])
    return int(season)


def season_slug(season: str) -> str:
    return season.replace("-", "").replace("/", "")


def parse_minutes(value: str | None) -> float:
    if not value:
        return 0.0
    if ":" not in value:
        try:
            return float(value)
        except ValueError:
            return 0.0
    minutes, seconds = value.split(":")
    return int(minutes) + int(seconds) / 60.0


def flatten_stat(record: dict) -> dict:
    player = record.get("player", {}) or {}
    team = record.get("team", {}) or {}
    game = record.get("game", {}) or {}

    flattened = {
        "PLAYER_ID": player.get("id"),
        "PLAYER_NAME": f"{player.get('first_name', '').strip()} {player.get('last_name', '').strip()}".strip(),
        "PLAYER_POSITION": player.get("position", ""),
        "TEAM_ID": team.get("id"),
        "TEAM_ABBREVIATION": team.get("abbreviation", ""),
        "GAME_ID": game.get("id"),
        "GAME_DATE": game.get("date"),
        "GAME_SEASON": game.get("season"),
        "IS_HOME": team.get("id") == game.get("home_team_id"),
        "MINUTES": parse_minutes(record.get("min")),
    }

    for api_key, column in STAT_KEY_MAP.items():
        value = record.get(api_key)
        if value is None:
            flattened[column] = 0.0
        else:
            try:
                flattened[column] = float(value)
            except (TypeError, ValueError):
                flattened[column] = 0.0

    return flattened


def fetch_stats(
    client: httpx.Client,
    season_year: int,
    per_page: int,
    api_key: str | None,
    cursor: Optional[int] = None,
) -> dict:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    params = {
        "seasons[]": season_year,
        "per_page": per_page,
    }
    if cursor:
        params["cursor"] = cursor
    try:
        response = client.get(f"{BASE_URL}/stats", params=params, headers=headers)
        response.raise_for_status()
    except HTTPStatusError as err:
        if err.response.status_code == 404:
            raise RuntimeError(
                f"balldontlie does not expose stats for the {season_year}-{season_year + 1} season yet. "
                "Try an earlier season (e.g. 2023-24) or provide a valid cached dataset."
            ) from err
        raise
    return response.json()


def collect_all_stats(
    season_year: int,
    api_key: str | None,
    per_page: int,
    pause_seconds: float,
) -> Iterable[dict]:
    with httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
        cursor: Optional[int] = None
        page = 1
        while True:
            payload = fetch_stats(client, season_year, per_page, api_key, cursor=cursor)
            data = payload.get("data", [])

            print(f"Fetched stats page {page} ({len(data)} rows)")
            for row in data:
                yield flatten_stat(row)

            meta = payload.get("meta", {}) or {}
            cursor = meta.get("next_cursor")
            if not cursor:
                break
            page += 1
            if pause_seconds > 0:
                time.sleep(pause_seconds)


def flatten_game(record: dict) -> dict:
    home = record.get("home_team", {}) or {}
    visitor = record.get("visitor_team", {}) or {}

    return {
        "GAME_ID": record.get("id"),
        "GAME_DATE": record.get("date"),
        "SEASON": record.get("season"),
        "STATUS": record.get("status"),
        "PERIOD": record.get("period"),
        "TIME": record.get("time"),
        "POSTSEASON": bool(record.get("postseason")),
        "ARENA": record.get("arena"),
        "CITY": record.get("city"),
        "STATE": record.get("state"),
        "HOME_TEAM_ID": home.get("id"),
        "HOME_TEAM_ABBREVIATION": home.get("abbreviation"),
        "HOME_TEAM_FULL_NAME": home.get("full_name"),
        "HOME_TEAM_SCORE": record.get("home_team_score"),
        "VISITOR_TEAM_ID": visitor.get("id"),
        "VISITOR_TEAM_ABBREVIATION": visitor.get("abbreviation"),
        "VISITOR_TEAM_FULL_NAME": visitor.get("full_name"),
        "VISITOR_TEAM_SCORE": record.get("visitor_team_score"),
    }


def collect_all_games(
    season_year: int,
    api_key: str | None,
    per_page: int,
    pause_seconds: float,
) -> Iterable[dict]:
    with httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
        cursor: Optional[int] = None
        page = 1
        while True:
            headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
            params = {
                "seasons[]": season_year,
                "per_page": per_page,
            }
            if cursor:
                params["cursor"] = cursor
            try:
                response = client.get(f"{BASE_URL}/games", params=params, headers=headers)
                response.raise_for_status()
            except HTTPStatusError as err:
                if err.response.status_code == 404:
                    raise RuntimeError(
                        f"balldontlie does not expose game results for the {season_year}-{season_year + 1} season yet."
                    ) from err
                raise
            payload = response.json()
            data = payload.get("data", [])
            meta = payload.get("meta", {}) or {}

            print(f"Fetched games page {page} ({len(data)} rows)")
            for row in data:
                yield flatten_game(row)

            cursor = meta.get("next_cursor")
            if not cursor:
                break
            page += 1
            if pause_seconds > 0:
                time.sleep(pause_seconds)


def persist_records(records: Iterable[dict]) -> pd.DataFrame:
    data = list(records)
    if not data:
        raise RuntimeError("No records were downloaded; check the season value or API key.")
    return pd.DataFrame(data)


def persist(df: pd.DataFrame, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(destination, index=False)
    print(f"Saved {len(df)} rows to {destination}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download balldontlie player game stats for a given NBA season and cache them locally.",
    )
    parser.add_argument(
        "--season",
        default=settings.season,
        help="Season label in 'YYYY-YY' or starting year format (default matches settings.season).",
    )
    parser.add_argument(
        "--api-key",
        default=settings.balldontlie_api_key,
        help="balldontlie API key (falls back to BALLDONTLIE_API_KEY env or settings).",
    )
    parser.add_argument(
        "--per-page",
        type=int,
        default=100,
        help="Number of rows per paginated request (max 100 according to API docs).",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.5,
        help="Seconds to pause between paginated requests to avoid rate limits.",
    )
    args = parser.parse_args()

    season_year = parse_season_to_year(args.season)
    slug = season_slug(args.season)
    stats_outfile = DATA_DIR / f"player_game_logs_{slug}.csv"
    games_outfile = DATA_DIR / f"games_{slug}.csv"

    print(f"Downloading player game logs for the {season_year} season to {stats_outfile}")
    try:
        stats_df = persist_records(
            collect_all_stats(
                season_year=season_year,
                api_key=args.api_key,
                per_page=args.per_page,
                pause_seconds=args.sleep,
            )
        )
    except RuntimeError as err:
        print(f"Failed to download player stats: {err}")
        return
    persist(stats_df, stats_outfile)

    print(f"Downloading game schedule and scores for the {season_year} season to {games_outfile}")
    try:
        games_df = persist_records(
            collect_all_games(
                season_year=season_year,
                api_key=args.api_key,
                per_page=args.per_page,
                pause_seconds=args.sleep,
            )
        )
    except RuntimeError as err:
        print(f"Failed to download game schedule: {err}")
        return
    persist(games_df, games_outfile)
    print("Done! Local cache ready for offline use.")


if __name__ == "__main__":
    main()
