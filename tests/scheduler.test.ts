import { describe, expect, it } from "vitest";
import { HistoryIndex, pairKey } from "@/domain/history";
import {
  DEFAULT_WEIGHTS,
  detectScheduleDrift,
  generateSchedule,
  reconstructRounds,
  summariseRepeats,
} from "@/domain/scheduler";
import { parseTime } from "@/domain/time";
import { court, ladder, makeSession, makeSignup, makePlayer, ratingMap } from "./fixtures";

type MatchLike = { teamA: readonly [string, string]; teamB: readonly [string, string] };

function partnershipCounts(matches: MatchLike[]) {
  const counts = new Map<string, number>();
  for (const match of matches) {
    for (const team of [match.teamA, match.teamB]) {
      const key = pairKey(team[0], team[1]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function opponentCounts(matches: MatchLike[]) {
  const counts = new Map<string, number>();
  for (const match of matches) {
    for (const a of match.teamA) {
      for (const b of match.teamB) {
        const key = pairKey(a, b);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

const teamGap = (match: MatchLike, ratings: ReadonlyMap<string, number>) => {
  const avg = (team: readonly [string, string]) =>
    ((ratings.get(team[0]) ?? 0) + (ratings.get(team[1]) ?? 0)) / 2;
  return Math.abs(avg(match.teamA) - avg(match.teamB));
};

const fourSpread = (match: MatchLike, ratings: ReadonlyMap<string, number>) => {
  const values = [...match.teamA, ...match.teamB].map((id) => ratings.get(id) ?? 0);
  return Math.max(...values) - Math.min(...values);
};

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

  it("never puts two players against each other twice", () => {
    const repeats = [...opponentCounts(result.matches).values()].filter((n) => n > 1);
    expect(repeats).toEqual([]);
    expect(result.repeats.partnerships).toEqual([]);
    expect(result.repeats.opponents).toEqual([]);
  });

  it("mixes levels rather than banding players by rating", () => {
    // The point of a mixin: a 2.5 should get games with and against a 5.5, not
    // spend the evening on the same court as the four people nearest them. The
    // ladder spans 3.0 rating points, so a four spanning over a third of it is
    // a genuinely mixed four rather than a band.
    const ratings = ratingMap(players);
    const spreads = result.matches.map((m) => fourSpread(m, ratings));
    const mixed = spreads.filter((spread) => spread > 1).length;
    expect(mixed).toBeGreaterThan(result.matches.length / 2);
  });

  it("gives the weakest player games with and against stronger ones", () => {
    const ratings = ratingMap(players);
    const weakest = [...players].sort((a, b) => a.rating - b.rating)[0]!;
    const theirs = result.matches.filter((m) =>
      [...m.teamA, ...m.teamB].includes(weakest.id),
    );
    expect(theirs.length).toBeGreaterThan(0);
    const others = theirs.flatMap((m) =>
      [...m.teamA, ...m.teamB].filter((id) => id !== weakest.id),
    );
    const strongest = Math.max(...others.map((id) => ratings.get(id) ?? 0));
    expect(strongest - weakest.rating).toBeGreaterThan(1);
  });

  it("balances the two teams within each four", () => {
    // Mixing levels is not licence to make the game one-sided: the two teams
    // still have to add up to a similar total. The ladder spans 3.0 points, so
    // these bounds keep every game close and the typical one very close.
    const ratings = ratingMap(players);
    const gaps = result.matches.map((m) => teamGap(m, ratings));
    for (const gap of gaps) expect(gap).toBeLessThan(0.7);
    expect(gaps.reduce((a, b) => a + b, 0) / gaps.length).toBeLessThan(0.3);
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

describe("when the rules cannot all be kept", () => {
  /**
   * Eight players over four rounds is the shape that makes the club's second
   * rule arithmetically impossible: each player faces two opponents a round, so
   * eight opponent slots against seven other people. Something has to repeat.
   */
  const players = ladder(8, 3.0, 5.0);
  const session = makeSession({
    slotCount: 4,
    courts: [court(1, "18:00", 4), court(2, "18:00", 4)],
  });
  const signups = players.map((p, i) => makeSignup(p.id, 4, "18:00", i + 1));
  const result = generateSchedule({ session, signups, ratings: ratingMap(players) });

  it("still gives everyone their games", () => {
    expect(result.matches).toHaveLength(8);
    expect(result.shortfalls).toEqual([]);
  });

  it("keeps the partner rule, which is the one that can be kept", () => {
    // 16 partner slots over 28 possible pairs: no repeat is necessary here, so
    // there must not be one.
    expect(result.repeats.partnerships).toEqual([]);
  });

  it("gives up opponents rather than partners, and says that it did", () => {
    expect(result.repeats.opponents.length).toBeGreaterThan(0);
    // 32 opponent slots over 28 pairs forces at least four repeats; a draw much
    // worse than that floor means the search has stopped working.
    const forced = result.repeats.opponents.reduce((n, r) => n + (r.times - 1), 0);
    expect(forced).toBeGreaterThanOrEqual(4);
    expect(forced).toBeLessThanOrEqual(8);
  });

  it("reports every repeat it accepted, with a count", () => {
    const counts = opponentCounts(result.matches);
    for (const pair of result.repeats.opponents) {
      expect(counts.get(pairKey(pair.playerIds[0], pair.playerIds[1]))).toBe(pair.times);
      expect(pair.times).toBeGreaterThan(1);
    }
  });
});

describe("summarising the repeats in a draw", () => {
  const match = (a1: string, a2: string, b1: string, b2: string) => ({
    slotIndex: 0,
    courtNumber: 1,
    teamA: [a1, a2] as const,
    teamB: [b1, b2] as const,
  });

  it("finds nothing in a draw with none", () => {
    expect(summariseRepeats([match("a", "b", "c", "d"), match("e", "f", "g", "h")])).toEqual({
      partnerships: [],
      opponents: [],
    });
  });

  it("counts a rematch even when the pairings are rearranged", () => {
    // a-b-c-d twice over is four fresh partnerships but the same four people,
    // so every one of them faces someone they have faced already.
    const summary = summariseRepeats([match("a", "b", "c", "d"), match("a", "c", "b", "d")]);
    expect(summary.partnerships).toEqual([]);
    expect(summary.opponents.map((r) => r.playerIds.join("|")).sort()).toEqual(["a|d", "b|c"]);
  });

  it("counts a partnership that happens twice", () => {
    const summary = summariseRepeats([match("a", "b", "c", "d"), match("a", "b", "e", "f")]);
    expect(summary.partnerships).toEqual([{ playerIds: ["a", "b"], times: 2 }]);
  });

  it("counts opponents who meet again, whichever side they are on", () => {
    const summary = summariseRepeats([match("a", "b", "c", "d"), match("c", "e", "a", "f")]);
    const met = summary.opponents.map((r) => r.playerIds.join("|"));
    expect(met).toEqual(["a|c"]);
    expect(summary.partnerships).toEqual([]);
  });

  it("puts the worst offenders first", () => {
    const summary = summariseRepeats([
      match("a", "b", "c", "d"),
      match("a", "b", "e", "f"),
      match("a", "b", "g", "h"),
      match("c", "e", "g", "i"),
      match("c", "e", "g", "j"),
    ]);
    expect(summary.partnerships[0]).toEqual({ playerIds: ["a", "b"], times: 3 });
  });

  it("reads a saved draw as happily as a generated one", () => {
    // Takes plain matches, so the session page can report on what is in the
    // database rather than having to regenerate to find out.
    expect(summariseRepeats([]).opponents).toEqual([]);
  });
});

describe("a player who only wants their own level", () => {
  // A wide ladder, so a mixed four is the natural outcome and the flag has to
  // work against it rather than getting the answer for free.
  const players = ladder(16, 2.0, 6.0);
  const session = makeSession({
    slotCount: 4,
    courts: [1, 2, 3, 4].map((n) => court(n, "18:00", 4)),
  });
  const signups = players.map((p, i) => makeSignup(p.id, 4, "18:00", i + 1));
  const ratings = ratingMap(players);
  const fussy = players[2]!;

  const mixed = generateSchedule({ session, signups, ratings });
  const respected = generateSchedule({
    session,
    signups,
    ratings,
    similarLevelOnly: new Set([fussy.id]),
  });

  const foursWith = (result: ReturnType<typeof generateSchedule>, playerId: string) =>
    result.matches
      .filter((m) => [...m.teamA, ...m.teamB].includes(playerId))
      .map((m) => {
        const values = [...m.teamA, ...m.teamB].map((id) => ratings.get(id) ?? 0);
        return Math.max(...values) - Math.min(...values);
      });

  it("keeps their fours inside the band, where everyone else's are mixed", () => {
    const before = foursWith(mixed, fussy.id);
    const after = foursWith(respected, fussy.id);
    expect(Math.max(...after)).toBeLessThan(Math.max(...before));

    // The band is 1.0 rating point. The cost is a hinge, so the draw will step
    // marginally outside it when that is what avoids a repeat — it must not
    // wander, but it is allowed to pay a little.
    const band = DEFAULT_WEIGHTS.similarLevelBand;
    expect(Math.max(...after)).toBeLessThanOrEqual(band * 1.25);
    const mean = after.reduce((a, b) => a + b, 0) / after.length;
    expect(mean).toBeLessThanOrEqual(band);
  });

  it("still gives them the games they asked for", () => {
    const scheduled = respected.allocations.find((a) => a.playerId === fussy.id);
    expect(scheduled?.scheduled).toBe(4);
    expect(respected.shortfalls).toEqual([]);
  });

  it("leaves everyone else mixed", () => {
    const others = respected.matches.filter(
      (m) => ![...m.teamA, ...m.teamB].includes(fussy.id),
    );
    const spreads = others.map((m) => {
      const values = [...m.teamA, ...m.teamB].map((id) => ratings.get(id) ?? 0);
      return Math.max(...values) - Math.min(...values);
    });
    expect(Math.max(...spreads)).toBeGreaterThan(1);
  });

  it("does not give up the no-repeat rules to do it", () => {
    expect(respected.repeats.partnerships).toEqual([]);
  });

  it("copes when two of them are the only pair near each other", () => {
    // Both ends of the ladder flagged: nobody near them, so a narrow four is
    // impossible. It must still produce a draw rather than failing.
    const both = new Set([players[0]!.id, players[15]!.id]);
    const result = generateSchedule({ session, signups, ratings, similarLevelOnly: both });
    expect(result.matches).toHaveLength(16);
    expect(result.shortfalls).toEqual([]);
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

describe("rebuilding rounds from a saved schedule", () => {
  const players = ladder(6, 3, 4.5);
  const session = makeSession({ slotCount: 2, courts: [court(1, "18:00", 2)] });
  // Four players want both games; two want only the first.
  const signups = players.map((p, i) => makeSignup(p.id, i < 4 ? 2 : 1, "18:00", i + 1));
  const generated = generateSchedule({ session, signups, ratings: ratingMap(players) });

  it("reproduces the generated rounds exactly", () => {
    const rebuilt = reconstructRounds(session, signups, generated.matches);
    expect(rebuilt.map((r) => r.matches)).toEqual(generated.rounds.map((r) => r.matches));
    expect(rebuilt.map((r) => r.startMinutes)).toEqual(generated.rounds.map((r) => r.startMinutes));
  });

  it("counts as sitting out only those still owed a game", () => {
    const rebuilt = reconstructRounds(session, signups, generated.matches);
    const secondRound = rebuilt[1];
    expect(secondRound).toBeDefined();
    // Anyone listed as waiting must still have games outstanding, so nobody who
    // asked for a single game appears in the second block.
    for (const id of secondRound!.sittingOut) {
      const signup = signups.find((s) => s.playerId === id);
      expect(signup?.requestedSlots).toBe(2);
    }
  });

  it("places each match in the block its court was booked for", () => {
    const staggered = makeSession({
      slotCount: 3,
      courts: [court(1, "18:00", 3), court(2, "19:00", 1)],
    });
    const eight = ladder(8, 3, 5);
    const eightSignups = eight.map((p, i) => makeSignup(p.id, 2, "18:00", i + 1));
    const result = generateSchedule({ session: staggered, signups: eightSignups, ratings: ratingMap(eight) });
    const rebuilt = reconstructRounds(staggered, eightSignups, result.matches);

    const courtTwoRound = rebuilt.find((r) => r.matches.some((m) => m.courtNumber === 2));
    expect(courtTwoRound?.startMinutes).toBe(parseTime("19:00"));
  });
});

describe("spotting a draw that has gone stale", () => {
  const players = ladder(8, 3, 5);
  const session = makeSession({ slotCount: 2, courts: [court(1, "18:00", 2), court(2, "18:00", 2)] });
  const signups = players.map((p, i) => makeSignup(p.id, 2, "18:00", i + 1));
  const result = generateSchedule({ session, signups, ratings: ratingMap(players) });

  it("is happy when the draw matches the signups", () => {
    const drift = detectScheduleDrift(signups, result.matches);
    expect(drift.isStale).toBe(false);
    expect(drift.scheduledButNotAttending).toEqual([]);
    expect(drift.confirmedButNotScheduled).toEqual([]);
  });

  it("flags a player who dropped out after the draw", () => {
    const remaining = signups.filter((s) => s.playerId !== "p3");
    const drift = detectScheduleDrift(remaining, result.matches);
    expect(drift.isStale).toBe(true);
    expect(drift.scheduledButNotAttending).toEqual(["p3"]);
  });

  it("flags a reserve promoted after the draw", () => {
    const promoted = [...signups, makeSignup("late", 2, "18:00", 9)];
    const drift = detectScheduleDrift(promoted, result.matches);
    expect(drift.isStale).toBe(true);
    expect(drift.confirmedButNotScheduled).toEqual(["late"]);
  });

  it("says nothing when no draw has been made yet", () => {
    expect(detectScheduleDrift(signups, []).isStale).toBe(false);
  });
});
