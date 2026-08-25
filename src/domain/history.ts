import type { Match } from "./types";

/** A match as stored for long-term history, across all sessions. */
export interface MatchRecord {
  sessionId: string;
  date: string;
  slotIndex: number;
  courtNumber: number;
  teamA: readonly [string, string];
  teamB: readonly [string, string];
}

/** Order-independent key for a pair of players. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Counts of who has played with and against whom. Built from historical
 * matches, then cloned and updated as a new schedule is generated so that
 * repeats within a single session are penalised too.
 */
export class HistoryIndex {
  private partners = new Map<string, number>();
  private opponents = new Map<string, number>();
  private games = new Map<string, number>();
  private lastPlayed = new Map<string, string>();

  constructor(records: Iterable<MatchRecord> = []) {
    for (const record of records) this.record(record, record.date);
  }

  partnerCount(a: string, b: string): number {
    return this.partners.get(pairKey(a, b)) ?? 0;
  }

  opponentCount(a: string, b: string): number {
    return this.opponents.get(pairKey(a, b)) ?? 0;
  }

  gamesPlayed(playerId: string): number {
    return this.games.get(playerId) ?? 0;
  }

  lastPlayedDate(playerId: string): string | null {
    return this.lastPlayed.get(playerId) ?? null;
  }

  /** Add a match to the index. */
  record(match: Pick<Match, "teamA" | "teamB">, date?: string): void {
    const [a1, a2] = match.teamA;
    const [b1, b2] = match.teamB;

    this.bump(this.partners, pairKey(a1, a2));
    this.bump(this.partners, pairKey(b1, b2));
    for (const a of [a1, a2]) {
      for (const b of [b1, b2]) this.bump(this.opponents, pairKey(a, b));
    }
    for (const id of [a1, a2, b1, b2]) {
      this.games.set(id, (this.games.get(id) ?? 0) + 1);
      if (date) {
        const current = this.lastPlayed.get(id);
        if (!current || date > current) this.lastPlayed.set(id, date);
      }
    }
  }

  /** A copy that can be mutated without touching the original. */
  clone(): HistoryIndex {
    const copy = new HistoryIndex();
    copy.partners = new Map(this.partners);
    copy.opponents = new Map(this.opponents);
    copy.games = new Map(this.games);
    copy.lastPlayed = new Map(this.lastPlayed);
    return copy;
  }

  /** Everyone `playerId` has partnered, most frequent first. */
  partnersOf(playerId: string): { playerId: string; count: number }[] {
    return this.relationsOf(this.partners, playerId);
  }

  /** Everyone `playerId` has faced, most frequent first. */
  opponentsOf(playerId: string): { playerId: string; count: number }[] {
    return this.relationsOf(this.opponents, playerId);
  }

  private relationsOf(
    source: Map<string, number>,
    playerId: string,
  ): { playerId: string; count: number }[] {
    const out: { playerId: string; count: number }[] = [];
    for (const [key, count] of source) {
      const parts = key.split("|");
      const first = parts[0];
      const second = parts[1];
      if (first === undefined || second === undefined) continue;
      if (first === playerId) out.push({ playerId: second, count });
      else if (second === playerId) out.push({ playerId: first, count });
    }
    return out.sort((x, y) => y.count - x.count || x.playerId.localeCompare(y.playerId));
  }

  private bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }
}
