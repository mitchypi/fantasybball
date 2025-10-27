from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional, Tuple

import httpx
import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from src.config import DATA_DIR, settings  # noqa: E402
from src.data_loader import load_game_schedule  # noqa: E402

ODDS_API_BASE = "https://api.the-odds-api.com/v4"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download NBA betting odds and cache them locally.")
    parser.add_argument("--season", type=str, default=settings.season, help="Season label (e.g. 2024-25).")
    parser.add_argument(
        "--sport",
        type=str,
        default="basketball_nba",
        help="Odds API sport key (default: basketball_nba).",
    )
    parser.add_argument(
        "--regions",
        type=str,
        default=settings.odds_regions,
        help="Comma-delimited list of regions, e.g. us,us2,eu.",
    )
    parser.add_argument(
        "--markets",
        type=str,
        default=settings.odds_markets,
        help="Comma-delimited list of markets to request, e.g. h2h,spreads,totals.",
    )
    parser.add_argument(
        "--bookmaker",
        type=str,
        default=settings.odds_default_bookmaker,
        help="Bookmaker key to prioritize when saving odds (default comes from settings).",
    )
    parser.add_argument("--api-key", type=str, default=settings.odds_api_key, help="Odds API key.")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite the cached odds file if it exists.")
    return parser.parse_args()


def normalize_team_name(name: str) -> str:
    """Return a normalized team name suitable for dictionary matching."""
    return "".join(ch for ch in name.lower() if ch.isalnum())


def build_schedule_index(schedule_df: pd.DataFrame) -> Dict[Tuple[str, str], List[Dict[str, Any]]]:
    index: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}

    for row in schedule_df.itertuples(index=False):
        home_norm = normalize_team_name(getattr(row, "HOME_TEAM_FULL_NAME"))
        away_norm = normalize_team_name(getattr(row, "VISITOR_TEAM_FULL_NAME"))
        key = (home_norm, away_norm)
        index.setdefault(key, []).append(
            {
                "game_id": int(getattr(row, "GAME_ID")),
                "game_date": getattr(row, "GAME_DATE").date(),
                "home_abbr": getattr(row, "HOME_TEAM_ABBREVIATION"),
                "away_abbr": getattr(row, "VISITOR_TEAM_ABBREVIATION"),
                "home_name": getattr(row, "HOME_TEAM_FULL_NAME"),
                "away_name": getattr(row, "VISITOR_TEAM_FULL_NAME"),
            }
        )

    for candidates in index.values():
        candidates.sort(key=lambda item: item["game_date"])
    return index


def assign_schedule_match(
    index: Dict[Tuple[str, str], List[Dict[str, Any]]],
    home_name: str,
    away_name: str,
    commence: datetime,
    max_day_delta: int = 2,
) -> Optional[Dict[str, Any]]:
    key = (normalize_team_name(home_name), normalize_team_name(away_name))
    candidates = index.get(key, [])
    if not candidates:
        return None

    target_date = commence.date()
    best_idx = None
    best_delta = None

    for idx, candidate in enumerate(candidates):
        schedule_date = candidate["game_date"]
        delta = abs((schedule_date - target_date).days)
        if best_delta is None or delta < best_delta:
            best_delta = delta
            best_idx = idx

    if best_idx is None or best_delta is None or best_delta > max_day_delta:
        return None

    return candidates.pop(best_idx)


def extract_market(bookmaker: Dict[str, Any], market_key: str) -> Optional[List[Dict[str, Any]]]:
    for market in bookmaker.get("markets", []) or []:
        if market.get("key") == market_key:
            return market.get("outcomes") or []
    return None


def format_markets(bookmaker: Dict[str, Any]) -> Dict[str, Any]:
    markets: Dict[str, Any] = {}

    h2h_outcomes = extract_market(bookmaker, "h2h")
    if h2h_outcomes:
        formatted = {}
        for outcome in h2h_outcomes:
            name = outcome.get("name", "")
            price = outcome.get("price")
            if name and price is not None:
                formatted[name] = {"price": price}
        if formatted:
            markets["moneyline"] = formatted

    spread_outcomes = extract_market(bookmaker, "spreads")
    if spread_outcomes:
        formatted = {}
        for outcome in spread_outcomes:
            name = outcome.get("name", "")
            price = outcome.get("price")
            point = outcome.get("point")
            if name and price is not None and point is not None:
                formatted[name] = {"price": price, "point": point}
        if formatted:
            markets["spread"] = formatted

    total_outcomes = extract_market(bookmaker, "totals")
    if total_outcomes:
        formatted = {}
        for outcome in total_outcomes:
            name = outcome.get("name", "")
            price = outcome.get("price")
            point = outcome.get("point")
            if name and price is not None and point is not None:
                formatted[name] = {"price": price, "point": point}
        if formatted:
            markets["total"] = formatted

    return markets


def fetch_odds(
    sport: str,
    api_key: str,
    regions: str,
    markets: str,
    timeout_seconds: float = 30.0,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    params = {
        "regions": regions,
        "markets": markets,
        "oddsFormat": "american",
        "apiKey": api_key,
    }
    url = f"{ODDS_API_BASE}/sports/{sport}/odds"

    with httpx.Client(timeout=httpx.Timeout(timeout_seconds, connect=10.0)) as client:
        response = client.get(url, params=params)
        response.raise_for_status()
        payload = response.json()
        rate_info = {
            "requests-remaining": response.headers.get("x-requests-remaining"),
            "requests-used": response.headers.get("x-requests-used"),
        }
        return payload, rate_info


def main() -> None:
    args = parse_args()
    if not args.api_key:
        raise SystemExit("Provide an Odds API key via --api-key or ODDS_API_KEY environment variable.")

    odds_path = settings.odds_path(args.season)
    if odds_path.exists() and not args.overwrite:
        raise SystemExit(
            f"{odds_path} already exists. Pass --overwrite to replace it or remove the file manually."
        )

    print(f"Loading schedule for {args.season}…")  # noqa: T201
    schedule_df = load_game_schedule(args.season)
    schedule_index = build_schedule_index(schedule_df)
    total_games = len(schedule_df)

    print("Requesting odds from The Odds API…")  # noqa: T201
    try:
        events, rate_info = fetch_odds(
            sport=args.sport,
            api_key=args.api_key,
            regions=args.regions,
            markets=args.markets,
        )
    except httpx.HTTPStatusError as err:
        raise SystemExit(f"Odds API request failed ({err.response.status_code}): {err.response.text}") from err
    except httpx.HTTPError as err:
        raise SystemExit(f"Unable to reach the Odds API: {err}") from err

    saved_games: Dict[int, Dict[str, Any]] = {}
    unmatched_events: List[Dict[str, Any]] = []
    assigned_count = 0

    for event in events:
        commence_raw = event.get("commence_time")
        try:
            commence_dt = datetime.fromisoformat(commence_raw.replace("Z", "+00:00"))
        except Exception:
            commence_dt = datetime.now(timezone.utc)

        home_team = event.get("home_team", "")
        away_team = event.get("away_team", "")

        match = assign_schedule_match(schedule_index, home_team, away_team, commence_dt)
        if not match:
            unmatched_events.append(
                {
                    "home_team": home_team,
                    "away_team": away_team,
                    "commence_time": commence_raw,
                }
            )
            continue

        bookmaker = None
        for entry in event.get("bookmakers", []) or []:
            if entry.get("key") == args.bookmaker:
                bookmaker = entry
                break
        if bookmaker is None and event.get("bookmakers"):
            bookmaker = event["bookmakers"][0]

        if bookmaker is None:
            unmatched_events.append(
                {
                    "home_team": home_team,
                    "away_team": away_team,
                    "commence_time": commence_raw,
                    "reason": "No bookmakers returned.",
                }
            )
            continue

        markets = format_markets(bookmaker)
        saved_games[match["game_id"]] = {
            "game_id": match["game_id"],
            "commence_time": commence_raw,
            "bookmaker": {
                "key": bookmaker.get("key"),
                "title": bookmaker.get("title"),
                "last_update": bookmaker.get("last_update"),
            },
            "markets": markets,
            "home_team": {
                "full_name": match["home_name"],
                "abbreviation": match["home_abbr"],
            },
            "away_team": {
                "full_name": match["away_name"],
                "abbreviation": match["away_abbr"],
            },
        }
        assigned_count += 1

    odds_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "metadata": {
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "season": args.season,
            "sport": args.sport,
            "regions": args.regions,
            "markets": args.markets,
            "bookmaker": args.bookmaker,
            **{k: v for k, v in rate_info.items() if v is not None},
            "schedule_games": total_games,
            "matched_events": assigned_count,
            "unmatched_events": len(unmatched_events),
        },
        "games": {str(game_id): data for game_id, data in saved_games.items()},
        "unmatched": unmatched_events,
    }

    with odds_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")

    print(f"Saved odds for {assigned_count} games to {odds_path}")  # noqa: T201
    if unmatched_events:
        print(f"{len(unmatched_events)} events did not match the cached schedule. See 'unmatched' in the output file.")  # noqa: T201


if __name__ == "__main__":
    main()
