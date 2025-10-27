from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
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

HISTORICAL_BASE = "https://api.the-odds-api.com/v4/historical"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download historical NBA odds keyed to the cached season schedule.")
    parser.add_argument("--season", type=str, default=settings.season, help="Season label (e.g. 2024-25).")
    parser.add_argument("--sport", type=str, default="basketball_nba", help="Odds API sport key.")
    parser.add_argument("--regions", type=str, default=settings.odds_regions, help="Comma-separated Odds API regions filter.")
    parser.add_argument("--markets", type=str, default=settings.odds_markets, help="Comma-separated market keys (h2h,spreads,totals).")
    parser.add_argument("--bookmaker", type=str, default=settings.odds_default_bookmaker, help="Preferred bookmaker key.")
    parser.add_argument("--api-key", type=str, default=settings.odds_api_key, help="Odds API key (fallback to ODDS_API_KEY env).")
    parser.add_argument("--from-date", type=str, help="ISO date (YYYY-MM-DD) to start harvesting (defaults to first schedule date).")
    parser.add_argument("--to-date", type=str, help="ISO date (YYYY-MM-DD) to stop harvesting (defaults to last schedule date).")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing cached odds JSON.")
    parser.add_argument("--max-window", type=int, default=1, help="Number of days per request (default 1).")
    parser.add_argument("--log-interval", type=int, default=7, help="Print progress every N days (default 7). Use 1 for daily logging.")
    parser.add_argument("--demo", action="store_true", help="Limit collection to the first seven days for quick testing.")
    parser.add_argument(
        "--snapshot-time",
        type=str,
        default="12:00:00Z",
        help="UTC time component (HH:MM:SSZ) used for historical odds snapshots (default 12:00:00Z).",
    )
    return parser.parse_args()


def normalize_team(value: str | None) -> str:
    if not value:
        return ""
    return "".join(ch for ch in value.lower() if ch.isalnum())


def build_schedule_index(schedule_df: pd.DataFrame) -> Dict[Tuple[str, str], List[Dict[str, Any]]]:
    index: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for row in schedule_df.itertuples(index=False):
        game_date = getattr(row, "GAME_DATE").date()
        key = (
            normalize_team(getattr(row, "HOME_TEAM_FULL_NAME")),
            normalize_team(getattr(row, "VISITOR_TEAM_FULL_NAME")),
        )
        index.setdefault(key, []).append(
            {
                "game_id": int(getattr(row, "GAME_ID")),
                "game_date": game_date,
                "home": {
                    "abbr": getattr(row, "HOME_TEAM_ABBREVIATION"),
                    "name": getattr(row, "HOME_TEAM_FULL_NAME"),
                },
                "away": {
                    "abbr": getattr(row, "VISITOR_TEAM_ABBREVIATION"),
                    "name": getattr(row, "VISITOR_TEAM_FULL_NAME"),
                },
            }
        )
    return index


def match_schedule_event(index: Dict[Tuple[str, str], List[Dict[str, Any]]], home_name: str, away_name: str, commence_iso: str) -> Optional[Dict[str, Any]]:
    try:
        commence = datetime.fromisoformat(commence_iso.replace("Z", "+00:00"))
    except Exception:
        return None
    home_key = normalize_team(home_name)
    away_key = normalize_team(away_name)
    key = (home_key, away_key)
    candidates = index.get(key)
    if not candidates:
        return None
    best_candidate: Optional[Dict[str, Any]] = None
    best_delta: Optional[int] = None
    for info in candidates:
        scheduled_dt = datetime.combine(info["game_date"], datetime.min.time(), tzinfo=timezone.utc)
        delta = abs((scheduled_dt - commence.replace(tzinfo=timezone.utc)).days)
        if best_delta is None or delta < best_delta:
            best_delta = delta
            best_candidate = info
    if best_delta is not None and best_delta <= 3:
        return best_candidate
    return None


def select_markets(bookmaker_payload: Dict[str, Any], preferred_key: str) -> Optional[Dict[str, Any]]:
    if not bookmaker_payload:
        return None
    markets = {}
    for market in bookmaker_payload.get("markets", []) or []:
        if market.get("key") == "h2h":
            markets["moneyline"] = {outcome.get("name"): {"price": outcome.get("price")} for outcome in market.get("outcomes", []) or []}
        elif market.get("key") == "spreads":
            markets["spread"] = {
                outcome.get("name"): {
                    "price": outcome.get("price"),
                    "point": outcome.get("point"),
                }
                for outcome in market.get("outcomes", []) or []
            }
        elif market.get("key") == "totals":
            markets["total"] = {
                outcome.get("name"): {
                    "price": outcome.get("price"),
                    "point": outcome.get("point"),
                }
                for outcome in market.get("outcomes", []) or []
            }
    return markets if markets else None


def main() -> None:
    args = parse_args()

    if not args.api_key:
        raise SystemExit("Provide an Odds API key via --api-key or ODDS_API_KEY environment variable.")

    odds_path = settings.odds_path(args.season)
    if odds_path.exists() and not args.overwrite:
        raise SystemExit(f"{odds_path} already exists. Use --overwrite to replace it.")

    print(f"Loading schedule for {args.season}…")  # noqa: T201
    schedule_df = load_game_schedule(args.season)
    schedule_index = build_schedule_index(schedule_df)

    season_dates = sorted({row.date() for row in schedule_df["GAME_DATE"]})
    if not season_dates:
        raise SystemExit("Schedule contains no dates.")

    start_date = datetime.fromisoformat(f"{args.from_date}T00:00:00") if args.from_date else datetime.combine(season_dates[0], datetime.min.time())
    end_date = datetime.fromisoformat(f"{args.to_date}T23:59:59") if args.to_date else datetime.combine(season_dates[-1], datetime.max.time())
    start_date = start_date.replace(tzinfo=timezone.utc)
    end_date = end_date.replace(tzinfo=timezone.utc)
    if args.demo:
        print("[demo] Demo mode active: limiting to first 7 days starting", start_date.date())  # noqa: T201
        end_date = min(end_date, start_date + timedelta(days=6))

    day_step = max(1, args.max_window)
    log_interval = max(1, args.log_interval)

    saved_games: Dict[int, Dict[str, Any]] = {}
    unmatched_events: List[Dict[str, Any]] = []
    rate_info: Dict[str, Any] = {}
    days_processed = 0

    with httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
        cursor = start_date
        while cursor <= end_date:
            current_day = cursor.date()
            snapshot = args.snapshot_time
            snapshot_iso = snapshot if snapshot.upper().endswith("Z") else f"{snapshot}Z"
            full_snapshot = snapshot_iso if "T" in snapshot_iso else f"{current_day}T{snapshot_iso.rstrip('Z')}Z"
            try:
                odds_response = client.get(
                    f"{HISTORICAL_BASE}/sports/{args.sport}/odds",
                    params={
                        "apiKey": args.api_key,
                        "regions": args.regions,
                        "markets": args.markets,
                        "oddsFormat": "american",
                        "date": full_snapshot,
                        "bookmakers": args.bookmaker,
                    },
                )
                odds_response.raise_for_status()
                odds_payload = odds_response.json()
                rate_info = {
                    "requests-remaining": odds_response.headers.get("x-requests-remaining"),
                    "requests-used": odds_response.headers.get("x-requests-used"),
                    "timestamp": odds_payload.get("timestamp") if isinstance(odds_payload, dict) else None,
                }
            except httpx.HTTPStatusError as err:
                raise SystemExit(f"Failed to fetch historical odds ({err.response.status_code}): {err.response.text}") from err

            event_items = odds_payload.get("data", []) if isinstance(odds_payload, dict) else []
            events_count = len(event_items)
            matched_before = len(saved_games)
            unmatched_before = len(unmatched_events)

            for event in event_items:
                if not isinstance(event, dict):
                    continue
                event_data: Dict[str, Any] = event
                event_id = str(event_data.get("id")) if event_data.get("id") else None
                home_team = event_data.get("home_team")
                away_team = event_data.get("away_team")
                commence = event_data.get("commence_time")
                match = match_schedule_event(schedule_index, home_team, away_team, commence)
                if not match:
                    unmatched_events.append({
                        "event_id": event_id,
                        "home_team": home_team,
                        "away_team": away_team,
                        "commence_time": commence,
                        "reason": "Schedule match not found",
                    })
                    continue
                bookmakers = event_data.get("bookmakers") or []
                bookmaker_entry = next((b for b in bookmakers if b.get("key") == args.bookmaker), None)
                if bookmaker_entry is None and bookmakers:
                    bookmaker_entry = bookmakers[0]
                if not bookmaker_entry:
                    unmatched_events.append({
                        "event_id": event_id,
                        "home_team": home_team,
                        "away_team": away_team,
                        "commence_time": commence,
                        "reason": "Bookmaker data unavailable",
                    })
                    continue
                markets = select_markets(bookmaker_entry, args.bookmaker)
                if not markets:
                    unmatched_events.append({
                        "event_id": event_id,
                        "home_team": home_team,
                        "away_team": away_team,
                        "commence_time": commence,
                        "reason": "Requested markets missing",
                    })
                    continue
                saved_games[match["game_id"]] = {
                    "game_id": match["game_id"],
                    "event_id": event_id,
                    "commence_time": commence,
                    "bookmaker": {
                        "key": bookmaker_entry.get("key"),
                        "title": bookmaker_entry.get("title"),
                        "last_update": bookmaker_entry.get("last_update"),
                    },
                    "markets": markets,
                    "home_team": match["home"],
                    "away_team": match["away"],
                }
            days_processed += 1
            matched_today = len(saved_games) - matched_before
            unmatched_today = len(unmatched_events) - unmatched_before
            if days_processed % log_interval == 0 or cursor >= end_date:
                print(
                    f"[progress] {current_day} — events: {events_count}, matched today: {matched_today}, unmatched today: {unmatched_today}, total matched: {len(saved_games)}"
                )  # noqa: T201
            cursor = cursor + timedelta(days=day_step)

    odds_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "metadata": {
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "season": args.season,
            "sport": args.sport,
            "regions": args.regions,
            "markets": args.markets,
            "bookmaker": args.bookmaker,
            "snapshot_time": args.snapshot_time,
            "from": start_date.isoformat(),
            "to": end_date.isoformat(),
            "matched_events": len(saved_games),
            "unmatched_events": len(unmatched_events),
            **{k: v for k, v in rate_info.items() if v is not None},
        },
        "games": {str(game_id): data for game_id, data in saved_games.items()},
        "unmatched": unmatched_events,
    }

    with odds_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")

    print(f"Saved odds for {len(saved_games)} games to {odds_path}")  # noqa: T201
    if unmatched_events:
        print(f"{len(unmatched_events)} event(s) did not match the cached schedule. Review 'unmatched' in the output file.")  # noqa: T201


if __name__ == "__main__":
    main()
