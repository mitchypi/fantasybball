from __future__ import annotations

import os
from pathlib import Path
from typing import Dict

from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"


def _season_slug(value: str) -> str:
    return value.replace("-", "").replace("/", "")


class ScoringProfile(BaseModel):
    name: str
    weights: Dict[str, float]

    def describe(self) -> str:
        """Return a concise string that lists the scoring weights."""
        weight_bits = [f"{k}({v:+})" for k, v in self.weights.items()]
        return f"{self.name}: " + ", ".join(weight_bits)


class Settings(BaseModel):
    season: str = "2024-25"
    balldontlie_api_key: str = Field(
        default_factory=lambda: os.getenv(
            "BALLDONTLIE_API_KEY",
            "76648295-5d37-417d-b3b6-99564d506efa",
        )
    )
    default_scoring_profile: str = "points_league"
    scoring_profiles: Dict[str, ScoringProfile] = {
        "points_league": ScoringProfile(
            name="Points league (balanced)",
            weights={
                "PTS": 1.0,
                "OREB": 1.2,
                "DREB": 1.0,
                "TREB": 0.0,
                "AST": 1.5,
                "STL": 3.0,
                "BLK": 3.0,
                "3PM": 1.0,
                "3PA": 0.0,
                "MPG": 0.0,
                "FGM": 1.0,
                "FGA": -0.45,
                "FG_MISS": 0.0,
                "FTM": 1.0,
                "FTA": -0.75,
                "FT_MISS": 0.0,
                "TO": -1.0,
                "DD": 3.0,
                "TD": 5.0,
                "PF": 0.0,
            },
        ),
        "nine_cat": ScoringProfile(
            name="Nine category rotisserie",
            weights={
                "FG_PCT": 1.0,
                "FT_PCT": 1.0,
                "3PM": 1.0,
                "PTS": 1.0,
                "TREB": 1.0,
                "AST": 1.0,
                "STL": 1.0,
                "BLK": 1.0,
                "TO": -1.0,
                "DD": 0.0,
                "TD": 0.0,
                "OREB": 0.0,
                "DREB": 0.0,
                "3PA": 0.0,
                "MPG": 0.0,
                "FGM": 0.0,
                "FGA": 0.0,
                "FG_MISS": 0.0,
                "FTM": 0.0,
                "FTA": 0.0,
                "FT_MISS": 0.0,
                "PF": 0.0,
            },
        ),
    }

    def resolve_scoring_profile(self, name: str | None = None) -> ScoringProfile:
        """Return the requested scoring profile, falling back to the default."""
        if not name:
            name = self.default_scoring_profile
        try:
            return self.scoring_profiles[name]
        except KeyError as exc:
            known = ", ".join(sorted(self.scoring_profiles))
            raise ValueError(f"Unknown scoring profile '{name}'. Known profiles: {known}") from exc

    def season_slug(self, season: str | None = None) -> str:
        return _season_slug(season or self.season)

    def game_logs_path(self, season: str | None = None) -> Path:
        slug = self.season_slug(season)
        return DATA_DIR / f"player_game_logs_{slug}.csv"

    def games_path(self, season: str | None = None) -> Path:
        slug = self.season_slug(season)
        return DATA_DIR / f"games_{slug}.csv"


settings = Settings()
