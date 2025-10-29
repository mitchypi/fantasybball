import type { BetLeg, BetSlip, ScoreboardPayload } from './types';
import { americanToDecimal } from './utils';

function winnerFor(game: ScoreboardPayload['games'][number]): 'home' | 'away' | null {
  if (game.away_score == null || game.home_score == null) return null;
  if (game.home_score > game.away_score) return 'home';
  if (game.away_score > game.home_score) return 'away';
  return null;
}

export function legResult(leg: BetLeg, game: ScoreboardPayload['games'][number]): 'won' | 'lost' | 'void' | 'pending' {
  const homeScore = game.home_score;
  const awayScore = game.away_score;
  if (homeScore == null || awayScore == null) return 'pending';

  switch (leg.market) {
    case 'moneyline': {
      const w = winnerFor(game);
      if (w == null) return 'pending';
      return leg.selection === w ? 'won' : 'lost';
    }
    case 'spread': {
      if (leg.selection !== 'home' && leg.selection !== 'away') return 'void';
      if (leg.point == null) return 'void';
      const teamScore = leg.selection === 'home' ? homeScore : awayScore;
      const opponentScore = leg.selection === 'home' ? awayScore : homeScore;
      const adjusted = teamScore + leg.point;
      if (nearlyEqual(adjusted, opponentScore)) return 'void';
      return adjusted > opponentScore ? 'won' : 'lost';
    }
    case 'total': {
      if (leg.selection !== 'over' && leg.selection !== 'under') return 'void';
      if (leg.point == null) return 'void';
      const totalScore = homeScore + awayScore;
      if (nearlyEqual(totalScore, leg.point)) return 'void';
      if (leg.selection === 'over') return totalScore > leg.point ? 'won' : 'lost';
      return totalScore < leg.point ? 'won' : 'lost';
    }
    default:
      return 'void';
  }
}

export function settleSlip(slip: BetSlip, gamesById: Map<string | number, ScoreboardPayload['games'][number]>) {
  const results = slip.legs.map((leg) => {
    const game = gamesById.get(leg.game_id) || gamesById.get(String(leg.game_id));
    if (!game) return 'pending' as const;
    return legResult(leg, game);
  });

  if (results.some((r) => r === 'pending')) return { status: 'pending' as const };

  if (slip.kind === 'single') {
    const result = results[0];
    if (result === 'won') {
      const dec = americanToDecimal(slip.legs[0].price);
      const payout = +(slip.stake * dec).toFixed(2);
      return { status: 'won' as const, payout, legResults: results };
    }
    if (result === 'void') return { status: 'void' as const, payout: slip.stake, legResults: results };
    return { status: 'lost' as const, payout: 0, legResults: results };
  }

  if (results.some((r) => r === 'lost')) return { status: 'lost' as const, payout: 0, legResults: results };

  if (results.every((r) => r === 'won')) {
    const multiplier = slip.legs.reduce((m, leg) => m * americanToDecimal(leg.price), 1);
    const payout = +(slip.stake * multiplier).toFixed(2);
    return { status: 'won' as const, payout, legResults: results };
  }

  if (results.every((r) => r === 'won' || r === 'void')) {
    const multiplier = slip.legs.reduce((m, leg, idx) => {
      return m * (results[idx] === 'void' ? 1 : americanToDecimal(leg.price));
    }, 1);
    const payout = +(slip.stake * multiplier).toFixed(2);
    return { status: 'won' as const, payout, legResults: results };
  }

  return { status: 'pending' as const };
}

function nearlyEqual(a: number, b: number, epsilon = 1e-9) {
  return Math.abs(a - b) < epsilon;
}
