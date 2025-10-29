export type MoneylineMap = Record<string, { price: number }>;
export type SpreadMap = Record<string, { price: number; point: number }>;
export type TotalMap = Record<string, { price: number; point: number }>;

export interface OddsSnapshot {
  markets?: {
    moneyline?: MoneylineMap;
    spread?: SpreadMap;
    total?: TotalMap;
  } | null;
  home_team?: { full_name: string };
  away_team?: { full_name: string };
}

export interface ScoreboardGame {
  game_id: number | string;
  date?: string;
  away_team: string;
  home_team: string;
  away_score?: number | null;
  home_score?: number | null;
  status?: string;
  period_display?: string;
  time?: string;
  simulated?: boolean;
  odds?: OddsSnapshot | null;
}

export interface ScoreboardPayload {
  date: string;
  games: ScoreboardGame[];
}

export interface BoxscorePlayer {
  player_id?: number | null;
  player_name: string;
  position?: string;
  MINUTES?: number;
  FGM?: number;
  FGA?: number;
  FG3M?: number;
  FG3A?: number;
  FTM?: number;
  FTA?: number;
  REB?: number;
  OREB?: number;
  DREB?: number;
  AST?: number;
  STL?: number;
  BLK?: number;
  TOV?: number;
  PF?: number;
  PTS?: number;
  PLUS_MINUS?: number;
}

export interface BoxscoreTeam {
  name: string;
  abbreviation?: string;
  score?: number | null;
  players: BoxscorePlayer[];
}

export interface BoxscorePayload {
  game_id: number | string;
  date: string;
  home_team: BoxscoreTeam;
  away_team: BoxscoreTeam;
}

export type BetKind = 'single' | 'parlay';
export type BetStatus = 'pending' | 'won' | 'lost' | 'void';
export type BetMarket = 'moneyline' | 'spread' | 'total';
export type BetSelection = 'home' | 'away' | 'over' | 'under';

export interface BetLeg {
  game_id: number | string;
  market: BetMarket;
  selection: BetSelection;
  price: number; // American odds
  point?: number;
  label?: string;
  metadata?: Record<string, unknown>;
  game?: ScoreboardGame;
}

export interface BetSlip {
  id?: number;
  placed_at: string; // ISO
  status: BetStatus;
  kind: BetKind;
  stake: number;
  payout?: number;
  legs: BetLeg[];
}

export interface SystemState {
  key: 'system';
  currentDate: string;
  bankroll: number;
  initialBankroll: number;
  pendingStake: number;
  pendingPotential: number;
}

export interface SimulationState {
  date: string;
  simulated: boolean;
  simulatedAt?: string;
}
