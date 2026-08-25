import { describe, expect, it } from "vitest";
import { HistoryIndex, pairKey } from "@/domain/history";

const match = (a: string, b: string, c: string, d: string) => ({
  sessionId: "s1",
  date: "2025-08-01",
  slotIndex: 0,
  courtNumber: 1,
  teamA: [a, b] as const,
  teamB: [c, d] as const,
});

describe("play history", () => {
  it("keys pairs regardless of order", () => {
    expect(pairKey("a", "b")).toBe(pairKey("b", "a"));
  });

  it("counts partners and opponents", () => {
    const history = new HistoryIndex([match("a", "b", "c", "d")]);
    expect(history.partnerCount("a", "b")).toBe(1);
    expect(history.partnerCount("b", "a")).toBe(1);
    expect(history.partnerCount("a", "c")).toBe(0);
    expect(history.opponentCount("a", "c")).toBe(1);
    expect(history.opponentCount("a", "d")).toBe(1);
    expect(history.opponentCount("a", "b")).toBe(0);
  });

  it("accumulates across sessions", () => {
    const history = new HistoryIndex([
      match("a", "b", "c", "d"),
      match("a", "b", "c", "d"),
      match("a", "c", "b", "d"),
    ]);
    expect(history.partnerCount("a", "b")).toBe(2);
    expect(history.partnerCount("a", "c")).toBe(1);
    expect(history.gamesPlayed("a")).toBe(3);
  });

  it("tracks games played and the last date each player appeared", () => {
    const history = new HistoryIndex([
      { ...match("a", "b", "c", "d"), date: "2025-08-01" },
      { ...match("a", "b", "c", "e"), date: "2025-08-08" },
    ]);
    expect(history.gamesPlayed("a")).toBe(2);
    expect(history.gamesPlayed("e")).toBe(1);
    expect(history.lastPlayedDate("a")).toBe("2025-08-08");
    expect(history.lastPlayedDate("d")).toBe("2025-08-01");
    expect(history.lastPlayedDate("nobody")).toBeNull();
  });

  it("lists who someone has played with and against, most frequent first", () => {
    const history = new HistoryIndex([
      match("a", "b", "c", "d"),
      match("a", "b", "c", "d"),
      match("a", "c", "b", "d"),
    ]);
    expect(history.partnersOf("a")).toEqual([
      { playerId: "b", count: 2 },
      { playerId: "c", count: 1 },
    ]);
    // a faces d in all three matches, c in the first two, b only in the third.
    expect(history.opponentsOf("a")).toEqual([
      { playerId: "d", count: 3 },
      { playerId: "c", count: 2 },
      { playerId: "b", count: 1 },
    ]);
  });

  it("clones without sharing state", () => {
    const original = new HistoryIndex([match("a", "b", "c", "d")]);
    const copy = original.clone();
    copy.record({ teamA: ["a", "b"] as const, teamB: ["c", "d"] as const });

    expect(copy.partnerCount("a", "b")).toBe(2);
    expect(original.partnerCount("a", "b")).toBe(1);
  });
});
