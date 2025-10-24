from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

import pandas as pd

from .config import settings
from .data_loader import (
    compute_fantasy_points,
    load_player_game_logs,
    player_season_averages,
)
from .models import FantasyTeam, SimulationResult


@dataclass
class DraftResult:
    team_a: FantasyTeam
    team_b: FantasyTeam


def create_demo_teams(
    stats_df: pd.DataFrame,
    team_size: int = 8,
    scoring_name: str | None = None,
) -> DraftResult:
    """Generate two quick demo teams by alternating picks from the top fantasy scorers."""
    scoring = settings.resolve_scoring_profile(scoring_name)
    fantasy_df = compute_fantasy_points(stats_df, scoring.weights)
    fantasy_df = fantasy_df.sort_values("FANTASY_POINTS", ascending=False).head(team_size * 2)

    records = fantasy_df.to_dict("records")
    team_a_rows = records[0::2][:team_size]
    team_b_rows = records[1::2][:team_size]

    if len(team_a_rows) < team_size or len(team_b_rows) < team_size:
        raise ValueError(
            f"Insufficient player rows to build demo teams (needed {team_size * 2}, got {len(records)})."
        )

    team_a = FantasyTeam.from_rows("Know-It-Alls", team_a_rows)
    team_b = FantasyTeam.from_rows("Time Travelers", team_b_rows)
    return DraftResult(team_a=team_a, team_b=team_b)


def simulate_head_to_head(teams: Tuple[FantasyTeam, FantasyTeam], scoring_name: str | None = None) -> SimulationResult:
    scoring_profile = settings.resolve_scoring_profile(scoring_name)
    totals = {
        teams[0].name: teams[0].total_fantasy_points(scoring_profile.weights),
        teams[1].name: teams[1].total_fantasy_points(scoring_profile.weights),
    }
    return SimulationResult(scoring_profile=scoring_profile.name, team_totals=totals)


def run_demo(team_size: int = 8) -> SimulationResult:
    game_logs = load_player_game_logs()
    player_stats = player_season_averages(game_logs)
    draft = create_demo_teams(player_stats, team_size=team_size)
    return simulate_head_to_head((draft.team_a, draft.team_b))


if __name__ == "__main__":
    try:
        result = run_demo()
    except FileNotFoundError as err:
        print(err)
    else:
        winner = result.winning_team()
        print(f"Scoring profile: {result.scoring_profile}")
        for team_name, total in result.team_totals.items():
            print(f"- {team_name}: {total:.1f} fantasy points")
        print(f"Winner: {winner}")
