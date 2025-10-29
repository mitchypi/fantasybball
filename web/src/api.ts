import type { BoxscorePayload, ScoreboardPayload } from './types';

const baseUrl = import.meta.env.BASE_URL;

export async function fetchManifest() {
  const res = await fetch(`${baseUrl}data/manifest.json`);
  if (!res.ok) throw new Error(`Manifest HTTP ${res.status}`);
  return res.json();
}

export async function fetchScoreboard(date: string): Promise<ScoreboardPayload> {
  const res = await fetch(`${baseUrl}data/scoreboard/${date}.json`);
  if (res.status === 404) return { date, games: [] };
  if (!res.ok) throw new Error(`Scoreboard HTTP ${res.status}`);
  return res.json();
}

export async function fetchBoxscore(gameId: number | string): Promise<BoxscorePayload> {
  const res = await fetch(`${baseUrl}data/boxscores/${gameId}.json`);
  if (!res.ok) throw new Error(`Boxscore HTTP ${res.status}`);
  return res.json();
}
