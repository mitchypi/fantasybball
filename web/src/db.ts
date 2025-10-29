import { openDB, IDBPDatabase } from 'idb';
import type { BetSlip, BoxscorePayload, ScoreboardPayload, SimulationState, SystemState } from './types';

const DB_NAME = 'fantasybball';
const DB_VERSION = 3;

type DBSchema = {
  system: SystemState;
  bets: BetSlip;
  scoreboards: { key: string; value: ScoreboardPayload };
  boxscores: { key: string | number; value: BoxscorePayload };
  simulations: { key: string; value: SimulationState };
};

let dbPromise: Promise<IDBPDatabase<any>> | null = null;

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('system')) {
          const store = db.createObjectStore('system', { keyPath: 'key' });
          store.put({ key: 'system', currentDate: new Date().toISOString().slice(0, 10), bankroll: 1000, initialBankroll: 1000, pendingStake: 0, pendingPotential: 0 } satisfies SystemState);
        }
        if (!db.objectStoreNames.contains('bets')) {
          db.createObjectStore('bets', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('scoreboards')) {
          db.createObjectStore('scoreboards');
        }
        if (!db.objectStoreNames.contains('boxscores')) {
          db.createObjectStore('boxscores');
        }
        if (!db.objectStoreNames.contains('simulations')) {
          db.createObjectStore('simulations');
        }
      },
    });
  }
  return dbPromise;
}

export async function getSystem(): Promise<SystemState> {
  const db = await getDB();
  const val = await db.get('system', 'system');
  return val as SystemState;
}

export async function setSystem(patch: Partial<SystemState>) {
  const db = await getDB();
  const current = (await db.get('system', 'system')) as SystemState;
  const next = { ...current, ...patch } as SystemState;
  await db.put('system', next);
  return next;
}

export async function addBet(slip: Omit<BetSlip, 'id'>) {
  const db = await getDB();
  const id = await db.add('bets', slip as BetSlip);
  return { ...(slip as BetSlip), id } as BetSlip;
}

export async function listBets() {
  const db = await getDB();
  const tx = db.transaction('bets');
  const store = tx.objectStore('bets');
  const all = await store.getAll();
  return all as BetSlip[];
}

export async function updateBet(id: number, patch: Partial<BetSlip>) {
  const db = await getDB();
  const current = (await db.get('bets', id)) as BetSlip | undefined;
  if (!current) return;
  await db.put('bets', { ...current, ...patch });
}

export async function cacheScoreboard(date: string, payload: ScoreboardPayload) {
  const db = await getDB();
  await db.put('scoreboards', payload, date);
}

export async function getCachedScoreboard(date: string) {
  const db = await getDB();
  return db.get('scoreboards', date) as Promise<ScoreboardPayload | undefined>;
}

export async function cacheBoxscore(gameId: number | string, payload: BoxscorePayload) {
  const db = await getDB();
  await db.put('boxscores', payload, String(gameId));
}

export async function getCachedBoxscore(gameId: number | string) {
  const db = await getDB();
  return db.get('boxscores', String(gameId)) as Promise<BoxscorePayload | undefined>;
}

export async function getSimulationState(date: string) {
  const db = await getDB();
  return db.get('simulations', date) as Promise<SimulationState | undefined>;
}

export async function setSimulationState(date: string, state: SimulationState) {
  const db = await getDB();
  await db.put('simulations', state, date);
  return state;
}

export async function clearBets() {
  const db = await getDB();
  await db.clear('bets');
}

export async function clearSimulations() {
  const db = await getDB();
  await db.clear('simulations');
}

export async function clearScoreboardCache() {
  const db = await getDB();
  await db.clear('scoreboards');
}

export async function clearBoxscoreCache() {
  const db = await getDB();
  await db.clear('boxscores');
}
