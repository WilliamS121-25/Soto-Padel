import { describe, expect, it } from "vitest";
import {
  checkLineups,
  describeLineupProblem,
  gamesScheduled,
  isCompleteFour,
  lineupChanged,
  type LineupProblem,
} from "@/domain/lineup-edits";
import type { Match } from "@/domain/types";
import { court, makeSession, makeSignup } from "./fixtures";

const NAMES: Record<string, string> = {
  a: "Ana",
  b: "Bruno",
  c: "Carla",
  d: "Diego",
  e: "Elena",
  f: "Felipe",
  g: "Gaby",
  h: "Hugo",
};
const nameOf = (id: string) => NAMES[id] ?? "Someone";

function match(
  slotIndex: number,
  courtNumber: number,
  a1: string,
  a2: string,
  b1: string,
  b2: string,
  scores: Partial<Match> = {},
): Match {
  return {
    slotIndex,
    courtNumber,
    teamA: [a1, a2],
    teamB: [b1, b2],
    ...scores,
  };
}

/** Two courts for four half-hours; everybody in from the start. */
const session = makeSession({
  courts: [court(1, "18:00", 4), court(2, "18:00", 4)],
});
const eight = ["a", "b", "c", "d", "e", "f", "g", "h"];
const confirmed = eight.map((id, index) => makeSignup(id, 2, "18:00", index));

/** A clean two-block draw: everybody plays exactly the two games they asked for. */
const cleanDraw: Match[] = [
  match(0, 1, "a", "b", "c", "d"),
  match(0, 2, "e", "f", "g", "h"),
  match(1, 1, "a", "c", "b", "d"),
  match(1, 2, "e", "g", "f", "h"),
];

describe("checkLineups", () => {
  it("passes a draw the generator would produce", () => {
    expect(checkLineups({ session, confirmed, matches: cleanDraw })).toEqual([]);
  });

  it("passes an empty draw", () => {
    expect(checkLineups({ session, confirmed, matches: [] })).toEqual([]);
  });

  it("catches the same player on two courts in one block", () => {
    const matches = [
      match(0, 1, "a", "b", "c", "d"),
      // "a" replaces "e" on the other court in the same half-hour
      match(0, 2, "a", "f", "g", "h"),
    ];
    const problems = checkLineups({ session, confirmed, matches });
    expect(problems).toContainEqual<LineupProblem>({
      kind: "DOUBLE_BOOKED",
      playerId: "a",
      slotIndex: 0,
      courtNumbers: [1, 2],
    });
  });

  it("does not call the same player in two different blocks a double booking", () => {
    const problems = checkLineups({ session, confirmed, matches: cleanDraw });
    expect(problems.filter((p) => p.kind === "DOUBLE_BOOKED")).toEqual([]);
  });

  it("catches the same player twice on one court", () => {
    const matches = [match(0, 1, "a", "a", "c", "d")];
    const problems = checkLineups({ session, confirmed, matches });
    expect(problems).toContainEqual<LineupProblem>({
      kind: "REPEATED_IN_MATCH",
      playerId: "a",
      slotIndex: 0,
      courtNumber: 1,
    });
    // and it is not also reported as being on two courts at once
    expect(problems.filter((p) => p.kind === "DOUBLE_BOOKED")).toEqual([]);
  });

  it("catches somebody down for more games than they signed up for", () => {
    const matches = [
      ...cleanDraw,
      // a third block "a" is not entitled to
      match(2, 1, "a", "b", "c", "d"),
    ];
    const problems = checkLineups({ session, confirmed, matches });
    expect(problems).toContainEqual<LineupProblem>({
      kind: "TOO_MANY_GAMES",
      playerId: "a",
      scheduled: 3,
      requested: 2,
    });
  });

  it("counts games over the whole evening, not one block", () => {
    // Each block on its own is fine; only the total is wrong.
    const matches = [
      match(0, 1, "a", "b", "c", "d"),
      match(1, 1, "a", "c", "b", "e"),
      match(2, 1, "a", "d", "b", "f"),
    ];
    const over = checkLineups({ session, confirmed, matches }).filter(
      (p) => p.kind === "TOO_MANY_GAMES",
    );
    expect(over.map((p) => p.playerId).sort()).toEqual(["a", "b"]);
  });

  it("is happy with fewer games than requested", () => {
    const matches = [match(0, 1, "a", "b", "c", "d")];
    expect(checkLineups({ session, confirmed, matches })).toEqual([]);
  });

  it("catches somebody who is not confirmed for this mixin", () => {
    const matches = [match(0, 1, "a", "b", "c", "zz")];
    expect(checkLineups({ session, confirmed, matches })).toContainEqual<LineupProblem>({
      kind: "NOT_ATTENDING",
      playerId: "zz",
    });
  });

  it("reports an unknown player once, not once per block", () => {
    const matches = [match(0, 1, "a", "b", "c", "zz"), match(1, 1, "a", "b", "c", "zz")];
    const problems = checkLineups({ session, confirmed, matches });
    expect(problems.filter((p) => p.kind === "NOT_ATTENDING")).toHaveLength(1);
  });

  it("catches a player put in a block that starts before they can get there", () => {
    const late = [
      ...eight.slice(0, 7).map((id, index) => makeSignup(id, 2, "18:00", index)),
      makeSignup("h", 2, "19:00", 7),
    ];
    const matches = [match(0, 1, "a", "b", "c", "h")];
    expect(checkLineups({ session, confirmed: late, matches })).toContainEqual<LineupProblem>({
      kind: "NOT_ARRIVED",
      playerId: "h",
      slotIndex: 0,
      startMinutes: 18 * 60,
      earliestStartMinutes: 19 * 60,
    });
  });

  it("allows a late arrival in a block they can make", () => {
    const late = [
      ...eight.slice(0, 7).map((id, index) => makeSignup(id, 2, "18:00", index)),
      makeSignup("h", 2, "19:00", 7),
    ];
    // slot 2 is 19:00-19:30
    const matches = [match(2, 1, "a", "b", "c", "h")];
    expect(checkLineups({ session, confirmed: late, matches })).toEqual([]);
  });

  it("reports every problem at once rather than stopping at the first", () => {
    const matches = [
      match(0, 1, "a", "b", "c", "d"),
      match(0, 2, "a", "f", "g", "h"),
      match(1, 1, "a", "c", "b", "d"),
      match(1, 2, "e", "g", "f", "h"),
      match(2, 1, "a", "e", "b", "c"),
    ];
    const kinds = new Set(checkLineups({ session, confirmed, matches }).map((p) => p.kind));
    expect(kinds).toContain("DOUBLE_BOOKED");
    expect(kinds).toContain("TOO_MANY_GAMES");
  });

  it("does not care about repeat partners or opponents", () => {
    // The same four every block: legal, if dull. Repeats are weights in the
    // draw, not rules an edit may not break.
    const twice = [match(0, 1, "a", "b", "c", "d"), match(1, 1, "a", "b", "c", "d")];
    expect(checkLineups({ session, confirmed, matches: twice })).toEqual([]);
  });

  it("honours a court whose window starts after the mixin does", () => {
    const staggered = makeSession({
      courts: [court(1, "18:00", 4), court(3, "19:00", 2)],
    });
    // Slot 2 is 19:00, which is when court 3 opens.
    const matches = [match(2, 3, "a", "b", "c", "d")];
    expect(checkLineups({ session: staggered, confirmed, matches })).toEqual([]);
  });
});

describe("describeLineupProblem", () => {
  it("names the player and both courts for a double booking", () => {
    expect(
      describeLineupProblem(
        { kind: "DOUBLE_BOOKED", playerId: "a", slotIndex: 0, courtNumbers: [1, 2] },
        nameOf,
      ),
    ).toBe("Ana is on courts 1 and 2 at the same time.");
  });

  it("gives both numbers for a quota breach", () => {
    expect(
      describeLineupProblem(
        { kind: "TOO_MANY_GAMES", playerId: "b", scheduled: 4, requested: 3 },
        nameOf,
      ),
    ).toBe("Bruno is down for 4 games but only signed up for 3.");
  });

  it("gives clock times, not slot numbers, for an early block", () => {
    expect(
      describeLineupProblem(
        {
          kind: "NOT_ARRIVED",
          playerId: "c",
          slotIndex: 0,
          startMinutes: 18 * 60,
          earliestStartMinutes: 19 * 60 + 30,
        },
        nameOf,
      ),
    ).toBe("Carla cannot play at 18:00 — they said they can only start at 19:30.");
  });

  it("has a sentence for every kind", () => {
    const all: LineupProblem[] = [
      { kind: "NOT_ATTENDING", playerId: "a" },
      { kind: "REPEATED_IN_MATCH", playerId: "a", slotIndex: 0, courtNumber: 1 },
      { kind: "DOUBLE_BOOKED", playerId: "a", slotIndex: 0, courtNumbers: [1, 2] },
      {
        kind: "NOT_ARRIVED",
        playerId: "a",
        slotIndex: 0,
        startMinutes: 0,
        earliestStartMinutes: 60,
      },
      { kind: "TOO_MANY_GAMES", playerId: "a", scheduled: 3, requested: 2 },
    ];
    for (const problem of all) {
      const sentence = describeLineupProblem(problem, nameOf);
      expect(sentence).toMatch(/^Ana\b/);
      expect(sentence.endsWith(".")).toBe(true);
    }
  });
});

describe("lineupChanged", () => {
  it("is false when the same people are in the same seats", () => {
    expect(lineupChanged(match(0, 1, "a", "b", "c", "d"), match(0, 1, "a", "b", "c", "d"))).toBe(
      false,
    );
  });

  it("is true when somebody is replaced", () => {
    expect(lineupChanged(match(0, 1, "a", "b", "c", "d"), match(0, 1, "a", "e", "c", "d"))).toBe(
      true,
    );
  });

  it("is true when the same four are re-paired, because the teams differ", () => {
    expect(lineupChanged(match(0, 1, "a", "b", "c", "d"), match(0, 1, "a", "c", "b", "d"))).toBe(
      true,
    );
  });
});

describe("gamesScheduled", () => {
  it("counts a block per appearance", () => {
    const counts = gamesScheduled(cleanDraw);
    expect([...counts.values()].every((n) => n === 2)).toBe(true);
    expect(counts.size).toBe(8);
  });

  it("is empty for no draw", () => {
    expect(gamesScheduled([]).size).toBe(0);
  });
});

describe("isCompleteFour", () => {
  it("accepts four filled seats", () => {
    expect(isCompleteFour(["a", "b", "c", "d"])).toBe(true);
  });

  it("rejects a blank seat", () => {
    expect(isCompleteFour(["a", "", "c", "d"])).toBe(false);
  });

  it("rejects the wrong number of seats", () => {
    expect(isCompleteFour(["a", "b", "c"])).toBe(false);
    expect(isCompleteFour(["a", "b", "c", "d", "e"])).toBe(false);
  });
});
