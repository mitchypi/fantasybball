from __future__ import annotations

from typing import Dict, Iterable, List

from pydantic import BaseModel


class PlayerSeasonStats(BaseModel):
    player_id: int
    player_name: str
    team_abbreviation: str
    games_played: int
    raw_stats: Dict[str, float]

    def fantasy_points(self, scoring_weights: Dict[str, float]) -> float:
        return sum(self.raw_stats.get(stat, 0.0) * weight for stat, weight in scoring_weights.items())


class FantasyTeam(BaseModel):
    name: str
    players: List[PlayerSeasonStats]

    def total_fantasy_points(self, scoring_weights: Dict[str, float]) -> float:
        return sum(player.fantasy_points(scoring_weights) for player in self.players)

    @classmethod
    def from_rows(cls, name: str, rows: Iterable[dict]) -> "FantasyTeam":
        players = []
        for row in rows:
            player = PlayerSeasonStats(
                player_id=int(row.get("PLAYER_ID")),
                player_name=str(row.get("PLAYER_NAME")),
                team_abbreviation=str(row.get("TEAM_ABBREVIATION", "")),
                games_played=int(row.get("GP", 0)),
                raw_stats={k: float(v) for k, v in row.items() if k not in {"PLAYER_ID", "PLAYER_NAME", "TEAM_ABBREVIATION"}},
            )
            players.append(player)
        return cls(name=name, players=players)


class SimulationResult(BaseModel):
    scoring_profile: str
    team_totals: Dict[str, float]

    def winning_team(self) -> str:
        return max(self.team_totals, key=self.team_totals.get)
