import { describe, expect, it } from "vitest";
import { HistoryIndex, pairKey } from "@/domain/history";
import { generateSchedule } from "@/domain/scheduler";
import { parseTime } from "@/domain/time";
import { court, ladder, makeSession, makeSignup, makePlayer, ratingMap } from "./fixtures";

function partnershipCounts(matches: { teamA: readonly [string, string]; teamB: readonly [string, string] }[]) {
  const counts = new Map<string, number>();
  for (const match of matches) {
    for (const team of [match.teamA, match.teamB]) {
      const key = pairKey(team[0], team[1]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

describe("a full mixin: 5 courts, 2 hours, 20 players", () => {
  const players = ladder(20, 2.5, 5.5);
  const session = makeSession({
    slotCount: 4,
    courts: [1, 2, 3, 4, 5].map((n) => court(n, "18:00", 4)),
  });
  const signups = players.map((p, i) => makeSignup(p.id, 4, "18:00", i + 1));
  const result = generateSchedule({ session, signups, ratings: ratingMap(players) });

  it("fills every court in every block", () => {
    expect(result.rounds).toHaveLength(4);
    expect(result.matches).toHaveLength(20);
    expect(result.idleCourtBlocks).toBe(0);
  });

  it("gives everyone the number of games they asked for", () => {
    expect(result.shortfalls).toEqual([]);
    for (const allocation of result.allocations) {
      expect(allocation.scheduled).toBe(4);
    }
  });

  it("never repeats a partnership when there is room not to", () => {
    const repeats = [...partnershipCounts(result.matches).values()].filter((n) => n > 1);
    expect(repeats).toEqual([]);
  });

  it("keeps each four close in level", () => {
    const ratings = ratingMap(players);
    for (const match of result.matches) {
      const values = [...match.teamA, ...match.teamB].map((id) => ratings.get(id) ?? 0);
      // The ladder spans 3.0 rating points; a four never spans most of it.
      expect(Math.max(...values) - Math.min(...values)).toBeLessThan(2);
    }
  });

  it("balances the two teams within each four", () => {
    const ratings = ratingMap(players);
    for (const match of result.matches) {
      const avg = (team: readonly [string, string]) =>
        ((ratings.get(team[0]) ?? 0) + (ratings.get(team[1]) ?? 0)) / 2;
      expect(Math.abs(avg(match.teamA) - avg(match.teamB))).toBeLessThan(0.4);
    }
  });

  it("is reproducible, and a new seed gives a different draw", () => {
    const again = generateSchedule({ session, signups, ratings: ratingMap(players) });
    expect(again.matches).toEqual(result.matches);

    const reseeded = generateSchedule({
      session,
      signups,
      ratings: ratingMap(players),
      seed: 99,
    });
    expect(reseeded.matches).not.toEqual(result.matches);
    // ...but still a valid schedule.
    expect(reseeded.shortfalls).toEqual([]);
  });
});

describe("individual start times", () => {
  const players = ladder(12, 3, 5);
  const session = makeSession({
    slotCount: 4,
    courts: [court(1, "18:00", 4), court(2, "18:00", 4)],
  });
  const signups = players.map((p, i) =>
    makeSignup(p.id, 2, i < 8 ? "18:00" : "19:00", i + 1),
  );
  const lateArrivals = players.slice(8).map((p) => p.id);
  const result = generateSchedule({ session, signups, ratings: ratingMap(players) });

  it("keeps late arrivals out of the early rounds", () => {
    for (const round of result.rounds.slice(0, 2)) {
      const onCourt = round.matches.flatMap((m) => [...m.teamA, ...m.teamB]);
      for (const id of lateArrivals) expect(onCourt).not.toContain(id);
    }
  });

  it("still gets the late arrivals their games", () => {
    for (const allocation of result.allocations) {
      expect(allocation.scheduled).toBe(2);
    }
  });

  it("reports the court-blocks that could not be used", () => {
    // Only four players are around after 19:00, so one of the two courts idles.
    expect(result.idleCourtBlocks).toBe(2);
  });
});

describe("awkward numbers", () => {
  it("only seats whole courts and reports who is sitting out", () => {
    const players = ladder(6, 3, 4);
    const session = makeSession({ slotCount: 1, courts: [court(1, "18:00", 1), court(2, "18:00", 1)] });
    const signups = players.map((p, i) => makeSignup(p.id, 1, "18:00", i + 1));
    const result = generateSchedule({ session, signups, ratings: ratingMap(players) });

    expect(result.rounds[0]?.matches).toHaveLength(1);
    expect(result.rounds[0]?.sittingOut).toHaveLength(2);
    expect(result.idleCourtBlocks).toBe(1);
  });

  it("schedules nothing when fewer than four turn up", () => {
    const players = ladder(3, 3, 4);
    const session = makeSession({ slotCount: 2, courts: [court(1, "18:00", 2)] });
    const signups = players.map((p, i) => makeSignup(p.id, 2, "18:00", i + 1));
    const result = generateSchedule({ session, signups, ratings: ratingMap(players) });

    expect(result.matches).toEqual([]);
    expect(result.shortfalls).toHaveLength(3);
  });

  it("never gives a player more games than they asked for", () => {
    const players = ladder(8, 3, 4.5);
    const session = makeSession({ slotCount: 4, courts: [court(1, "18:00", 4), court(2, "18:00", 4)] });
    // Half the group wants one game, half wants four.
    const signups = players.map((p, i) => makeSignup(p.id, i % 2 === 0 ? 1 : 4, "18:00", i + 1));
    const result = generateSchedule({ session, signups, ratings: ratingMap(players) });

    for (const allocation of result.allocations) {
      expect(allocation.scheduled).toBeLessThanOrEqual(allocation.requested);
    }
  });
});

describe("history across sessions", () => {
  it("avoids pairing players who always partner each other", () => {
    const players = [
      makePlayer("a", 4),
      makePlayer("b", 4),
      makePlayer("c", 4),
      makePlayer("d", 4),
    ];
    const history = new HistoryIndex();
    for (let i = 0; i < 5; i += 1) {
      history.record({ teamA: ["a", "b"] as const, teamB: ["c", "d"] as const }, "2025-08-01");
    }

    const session = makeSession({ slotCount: 1, courts: [court(1, "18:00", 1)] });
    const signups = players.map((p, i) => makeSignup(p.id, 1, "18:00", i + 1));
    const result = generateSchedule({ session, signups, ratings: ratingMap(players), history });

    const match = result.matches[0];
    expect(match).toBeDefined();
    const teams = [match!.teamA, match!.teamB].map((t) => pairKey(t[0], t[1]));
    expect(teams).not.toContain(pairKey("a", "b"));
    expect(teams).not.toContain(pairKey("c", "d"));
  });

  it("does not mutate the history it was given", () => {
    const history = new HistoryIndex();
    const players = ladder(4, 4, 4);
    const session = makeSession({ slotCount: 1, courts: [court(1, "18:00", 1)] });
    const signups = players.map((p, i) => makeSignup(p.id, 1, "18:00", i + 1));

    generateSchedule({ session, signups, ratings: ratingMap(players), history });
    expect(history.gamesPlayed("p1")).toBe(0);
  });
});

describe("staggered courts", () => {
  it("schedules around courts that start at different times", () => {
    const players = ladder(8, 3, 5);
    const session = makeSession({
      startMinutes: parseTime("18:00"),
      slotCount: 4,
      courts: [court(1, "18:00", 4), court(4, "19:00", 2)],
    });
    const signups = players.map((p, i) => makeSignup(p.id, 2, "18:00", i + 1));
    const result = generateSchedule({ session, signups, ratings: ratingMap(players) });

    const courtsByRound = result.rounds.map((r) => r.matches.map((m) => m.courtNumber));
    expect(courtsByRound[0]).toEqual([1]);
    expect(courtsByRound[1]).toEqual([1]);
    expect(courtsByRound[2]).toEqual([1, 4]);
    expect(result.shortfalls).toEqual([]);
  });
});
