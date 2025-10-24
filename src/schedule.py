from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Dict, Iterable, List

import pandas as pd

from .data_loader import load_game_schedule


@dataclass
class GameSummary:
    game_id: int
    game_date: date
    status: str
    home_team: str
    away_team: str
    home_score: int
    away_score: int
    period: int
    time: str

    @property
    def winner(self) -> str | None:
        if self.status.lower().startswith("final"):
            if self.home_score > self.away_score:
                return self.home_team
            if self.away_score > self.home_score:
                return self.away_team
        return None

    def to_dict(self) -> Dict[str, object]:
        return {
            "game_id": self.game_id,
            "date": self.game_date.isoformat(),
            "status": self.status,
            "home_team": self.home_team,
            "away_team": self.away_team,
            "home_score": self.home_score,
            "away_score": self.away_score,
            "period": self.period,
            "time": self.time,
            "winner": self.winner,
        }


def _build_game_summary(row: pd.Series) -> GameSummary:
    return GameSummary(
        game_id=int(row["GAME_ID"]),
        game_date=row["GAME_DATE"].date(),
        status=str(row.get("STATUS", "")),
        home_team=str(row.get("HOME_TEAM_ABBREVIATION") or row.get("HOME_TEAM_FULL_NAME", "")),
        away_team=str(row.get("VISITOR_TEAM_ABBREVIATION") or row.get("VISITOR_TEAM_FULL_NAME", "")),
        home_score=int(row.get("HOME_TEAM_SCORE", 0)),
        away_score=int(row.get("VISITOR_TEAM_SCORE", 0)),
        period=int(row.get("PERIOD", 0) or 0),
        time=str(row.get("TIME", "")),
    )


def daily_scoreboard(target_date: date, schedule_df: pd.DataFrame | None = None) -> List[GameSummary]:
    if schedule_df is None:
        schedule_df = load_game_schedule()
    mask = schedule_df["GAME_DATE"].dt.date == target_date
    games = schedule_df.loc[mask]
    return [_build_game_summary(row) for _, row in games.iterrows()]


def season_dates(schedule_df: pd.DataFrame | None = None) -> Iterable[date]:
    if schedule_df is None:
        schedule_df = load_game_schedule()
    return sorted({dt.date() for dt in schedule_df["GAME_DATE"]})
