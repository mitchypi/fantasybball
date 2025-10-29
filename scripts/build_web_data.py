#!/usr/bin/env python3
"""
Emit static JSON files for the client-only SPA.

Outputs:
  web/public/data/manifest.json
  web/public/data/scoreboard/<YYYY-MM-DD>.json
  web/public/data/boxscores/<GAME_ID>.json (optional)

This is a minimal scaffold: it demonstrates target shapes and writes examples
if it cannot parse real inputs. Wire to your existing CSV/JSON as needed.
"""
from __future__ import annotations
import argparse
import csv
import json
from pathlib import Path
from collections import defaultdict
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
WEB_PUBLIC = ROOT / 'web' / 'public' / 'data'


def ensure_dirs():
    (WEB_PUBLIC / 'scoreboard').mkdir(parents=True, exist_ok=True)
    (WEB_PUBLIC / 'boxscores').mkdir(parents=True, exist_ok=True)


def read_games_csv(season_tag: str) -> Optional[List[dict]]:
    # Try common filename patterns: games_202425.csv
    data_dir = ROOT / 'data'
    candidates = list(data_dir.glob(f'games_{season_tag}.csv'))
    if not candidates:
        return None
    path = candidates[0]
    rows: List[dict] = []
    with path.open('r', newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)
    return rows


def group_games_by_date(rows: List[dict]):
    by_date: Dict[str, List[dict]] = defaultdict(list)
    # For repo CSV (games_202425.csv) columns are uppercase:
    # GAME_ID,GAME_DATE,STATUS,HOME_TEAM_ABBREVIATION,HOME_TEAM_FULL_NAME,HOME_TEAM_SCORE,VISITOR_TEAM_ABBREVIATION,VISITOR_TEAM_FULL_NAME,VISITOR_TEAM_SCORE
    for r in rows:
        date = (
            r.get('GAME_DATE')
            or r.get('game_date')
            or r.get('date')
            or r.get('DATE')
        )
        if not date:
            continue
        by_date[date].append(r)
    return by_date


def to_scoreboard_payload(date: str, rows: List[dict], odds_by_gid: Dict[str, dict]):
    games: List[dict] = []
    for r in rows:
        gid_raw = r.get('GAME_ID') or r.get('game_id') or r.get('id')
        gid = int(gid_raw) if gid_raw and str(gid_raw).isdigit() else gid_raw
        h_abbr = r.get('HOME_TEAM_ABBREVIATION') or r.get('HOME') or r.get('home_team')
        a_abbr = r.get('VISITOR_TEAM_ABBREVIATION') or r.get('AWAY') or r.get('away_team')
        h_full = r.get('HOME_TEAM_FULL_NAME') or h_abbr
        a_full = r.get('VISITOR_TEAM_FULL_NAME') or a_abbr
        # Scores
        try:
            home_score = int(r.get('HOME_TEAM_SCORE') or 0)
        except Exception:
            home_score = None
        try:
            away_score = int(r.get('VISITOR_TEAM_SCORE') or 0)
        except Exception:
            away_score = None
        status = (
            r.get('STATUS')
            or ('Final' if home_score is not None and away_score is not None else 'Scheduled')
        )
        odds_src = odds_by_gid.get(str(gid)) if gid is not None else None
        odds = None
        if odds_src:
            markets_payload: Dict[str, dict] = {}
            markets = odds_src.get('markets', {}) or {}
            # Moneyline odds (price only)
            ml = markets.get('moneyline', {}) or {}
            moneyline = {}
            for team_name, entry in ml.items():
                price = entry.get('price') if isinstance(entry, dict) else None
                if price is None:
                    continue
                moneyline[team_name] = { 'price': price }
            if moneyline:
                markets_payload['moneyline'] = moneyline

            # Spread odds (price + point)
            spread_src = markets.get('spread', {}) or {}
            spread = {}
            for team_name, entry in spread_src.items():
                price = entry.get('price') if isinstance(entry, dict) else None
                point = entry.get('point') if isinstance(entry, dict) else None
                if price is None or point is None:
                    continue
                spread[team_name] = { 'price': price, 'point': point }
            if spread:
                markets_payload['spread'] = spread

            # Total odds (price + point) keyed by Over/Under
            total_src = markets.get('total', {}) or {}
            total = {}
            for label, entry in total_src.items():
                price = entry.get('price') if isinstance(entry, dict) else None
                point = entry.get('point') if isinstance(entry, dict) else None
                if price is None or point is None:
                    continue
                total[label] = { 'price': price, 'point': point }
            if total:
                markets_payload['total'] = total

            odds = {
                'home_team': { 'full_name': odds_src.get('home_team', {}).get('name', h_full) },
                'away_team': { 'full_name': odds_src.get('away_team', {}).get('name', a_full) },
                'markets': markets_payload or None,
            }
        games.append({
            'game_id': gid if gid is not None else f"{date}-{h_abbr}-{a_abbr}",
            'date': date,
            # Display compact abbreviations in the card; odds include full names for lookup
            'home_team': h_abbr or h_full or 'HOME',
            'away_team': a_abbr or a_full or 'AWAY',
            'home_score': home_score,
            'away_score': away_score,
            'status': status,
            'simulated': (status == 'Final'),
            'odds': odds,
        })
    return { 'date': date, 'games': games }


def write_manifest(dates: List[str]):
    payload = {
        'start_date': min(dates) if dates else '',
        'end_date': max(dates) if dates else '',
        'dates': dates,
        'teams': {},
    }
    out = WEB_PUBLIC / 'manifest.json'
    out.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def load_odds(season_tag: str) -> Dict[str, dict]:
    path = ROOT / 'data' / f'odds_{season_tag}.json'
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding='utf-8'))
    games = data.get('games', {}) or {}
    # Ensure keys are strings
    return { str(k): v for k, v in games.items() }


def write_scoreboards(grouped: Dict[str, List[dict]], odds_by_gid: Dict[str, dict]):
    for date, rows in grouped.items():
        payload = to_scoreboard_payload(date, rows, odds_by_gid)
        out = WEB_PUBLIC / 'scoreboard' / f'{date}.json'
        out.write_text(json.dumps(payload, indent=2), encoding='utf-8')


def parse_float(value: Optional[str]) -> float:
    if value is None or value == '':
        return 0.0
    try:
        return float(value)
    except ValueError:
        try:
            return float(value.replace('%', ''))
        except Exception:
            return 0.0


def parse_int(value: Optional[str]) -> Optional[int]:
    if value is None or value == '':
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def read_player_logs(season_tag: str) -> Optional[List[dict]]:
    data_dir = ROOT / 'data'
    path = data_dir / f'player_game_logs_{season_tag}.csv'
    if not path.exists():
        return None
    rows: List[dict] = []
    with path.open('r', newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)
    return rows


def group_logs_by_game(rows: List[dict]):
    grouped: Dict[str, Dict[str, List[dict]]] = defaultdict(lambda: {'home': [], 'away': []})
    for row in rows:
        gid = row.get('GAME_ID') or row.get('game_id')
        if not gid:
            continue
        is_home_raw = str(row.get('IS_HOME', '')).lower()
        is_home = is_home_raw in ('true', '1', 'yes')
        grouped[str(gid)]['home' if is_home else 'away'].append(row)
    return grouped


PLAYER_STAT_FIELDS = [
    'MINUTES', 'FGM', 'FGA', 'FG3M', 'FG3A', 'FTM', 'FTA',
    'OREB', 'DREB', 'REB', 'AST', 'STL', 'BLK', 'TOV', 'PF', 'PTS', 'PLUS_MINUS'
]


def build_player_entry(row: dict) -> dict:
    entry = {
        'player_id': parse_int(row.get('PLAYER_ID')),
        'player_name': row.get('PLAYER_NAME') or '',
        'position': row.get('PLAYER_POSITION') or '',
    }
    for field in PLAYER_STAT_FIELDS:
        entry[field] = parse_float(row.get(field))
    return entry


def to_boxscore_payload(date: str, game_row: dict, logs: Dict[str, List[dict]]):
    gid_raw = game_row.get('GAME_ID') or game_row.get('game_id')
    gid = int(gid_raw) if gid_raw and str(gid_raw).isdigit() else gid_raw
    h_abbr = game_row.get('HOME_TEAM_ABBREVIATION') or game_row.get('HOME')
    a_abbr = game_row.get('VISITOR_TEAM_ABBREVIATION') or game_row.get('AWAY')
    h_full = game_row.get('HOME_TEAM_FULL_NAME') or h_abbr
    a_full = game_row.get('VISITOR_TEAM_FULL_NAME') or a_abbr
    home_players = [build_player_entry(row) for row in logs.get('home', [])]
    away_players = [build_player_entry(row) for row in logs.get('away', [])]
    home_players.sort(key=lambda p: p.get('MINUTES', 0), reverse=True)
    away_players.sort(key=lambda p: p.get('MINUTES', 0), reverse=True)
    home_score = parse_int(game_row.get('HOME_TEAM_SCORE'))
    away_score = parse_int(game_row.get('VISITOR_TEAM_SCORE'))
    return {
        'game_id': gid,
        'date': date,
        'home_team': {
            'name': h_full or h_abbr or 'HOME',
            'abbreviation': h_abbr or h_full or 'HOME',
            'score': home_score,
            'players': home_players,
        },
        'away_team': {
            'name': a_full or a_abbr or 'AWAY',
            'abbreviation': a_abbr or a_full or 'AWAY',
            'score': away_score,
            'players': away_players,
        },
    }


def write_boxscores(grouped_games: Dict[str, List[dict]], logs_by_game: Dict[str, Dict[str, List[dict]]]):
    count = 0
    for date, rows in grouped_games.items():
        for row in rows:
            gid_raw = row.get('GAME_ID') or row.get('game_id')
            if not gid_raw:
                continue
            game_logs = logs_by_game.get(str(gid_raw))
            if not game_logs:
                continue
            payload = to_boxscore_payload(date, row, game_logs)
            out = WEB_PUBLIC / 'boxscores' / f'{gid_raw}.json'
            out.write_text(json.dumps(payload, indent=2), encoding='utf-8')
            count += 1
    return count


def write_example():
    # Minimal example for a single day
    date = '2024-10-01'
    payload = {
        'date': date,
        'games': [
            {
                'game_id': 1,
                'date': date,
                'away_team': 'LAL',
                'home_team': 'GSW',
                'away_score': 102,
                'home_score': 110,
                'status': 'Final',
                'simulated': True,
                'odds': {
                    'home_team': { 'full_name': 'Golden State Warriors' },
                    'away_team': { 'full_name': 'Los Angeles Lakers' },
                    'markets': {
                        'moneyline': {
                            'Golden State Warriors': { 'price': -140 },
                            'Los Angeles Lakers': { 'price': +120 }
                        },
                        'spread': {
                            'Golden State Warriors': { 'price': -110, 'point': -3.5 },
                            'Los Angeles Lakers': { 'price': -110, 'point': 3.5 }
                        },
                        'total': {
                            'Over': { 'price': -105, 'point': 228.5 },
                            'Under': { 'price': -115, 'point': 228.5 }
                        }
                    }
                }
            }
        ]
    }
    (WEB_PUBLIC).mkdir(parents=True, exist_ok=True)
    (WEB_PUBLIC / 'scoreboard').mkdir(parents=True, exist_ok=True)
    (WEB_PUBLIC / 'boxscores').mkdir(parents=True, exist_ok=True)
    (WEB_PUBLIC / 'manifest.json').write_text(json.dumps({ 'start_date': date, 'end_date': date, 'dates': [date], 'teams': {} }, indent=2), encoding='utf-8')
    (WEB_PUBLIC / 'scoreboard' / f'{date}.json').write_text(json.dumps(payload, indent=2), encoding='utf-8')
    sample_boxscore = {
        'game_id': 1,
        'date': date,
        'home_team': {
            'name': 'Golden State Warriors',
            'abbreviation': 'GSW',
            'score': 110,
            'players': [
                { 'player_id': 201939, 'player_name': 'Stephen Curry', 'position': 'G', 'MINUTES': 32.1, 'FGM': 11, 'FGA': 19, 'FG3M': 6, 'FG3A': 11, 'FTM': 2, 'FTA': 2, 'OREB': 1, 'DREB': 4, 'REB': 5, 'AST': 7, 'STL': 2, 'BLK': 0, 'TOV': 3, 'PF': 2, 'PTS': 30, 'PLUS_MINUS': 8 }
            ]
        },
        'away_team': {
            'name': 'Los Angeles Lakers',
            'abbreviation': 'LAL',
            'score': 102,
            'players': [
                { 'player_id': 2544, 'player_name': 'LeBron James', 'position': 'F', 'MINUTES': 34.5, 'FGM': 10, 'FGA': 21, 'FG3M': 2, 'FG3A': 6, 'FTM': 6, 'FTA': 8, 'OREB': 1, 'DREB': 7, 'REB': 8, 'AST': 9, 'STL': 1, 'BLK': 1, 'TOV': 4, 'PF': 2, 'PTS': 28, 'PLUS_MINUS': -4 }
            ]
        }
    }
    (WEB_PUBLIC / 'boxscores' / '1.json').write_text(json.dumps(sample_boxscore, indent=2), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--season', default='202425', help='Season tag matching games_<tag>.csv (e.g., 202425)')
    parser.add_argument('--emit-static', action='store_true', help='Write static JSON under web/public/data')
    args = parser.parse_args()

    ensure_dirs()
    rows = read_games_csv(args.season)
    if not rows:
        print('No games CSV found; writing example payloads instead.')
        write_example()
        return
    grouped = group_games_by_date(rows)
    dates = sorted(grouped.keys())
    write_manifest(dates)
    odds_by_gid = load_odds(args.season)
    write_scoreboards(grouped, odds_by_gid)
    log_rows = read_player_logs(args.season)
    if log_rows:
        logs_by_game = group_logs_by_game(log_rows)
        box_count = write_boxscores(grouped, logs_by_game)
        print(f'Wrote manifest, {len(dates)} scoreboard files, and {box_count} box scores to {WEB_PUBLIC}')
    else:
        print(f'Wrote manifest and {len(dates)} scoreboard files to {WEB_PUBLIC} (no player logs found for box scores)')


if __name__ == '__main__':
    main()
