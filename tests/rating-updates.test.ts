import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATING_UPDATE_OPTIONS,
  expectedWinShare,
  hasScore,
  materialRatingChanges,
  ratingChangesFromResults,
  type MatchResult,
} from "@/domain/rating-updates";

const ratings = (entries: Record<string, number>) => new Map(Object.entries(entries));
const match = (
  teamA: [string, string],
  teamB: [string, string],
  gamesA: number,
  gamesB: number,
): MatchResult => ({ teamA, teamB, gamesA, gamesB });

const changeFor = (
  changes: ReturnType<typeof ratingChangesFromResults>,
  playerId: string,
) => changes.find((c) => c.playerId === playerId);

describe("expected win share", () => {
  it("is even between equal pairs", () => {
    expect(expectedWinShare(4, 4)).toBeCloseTo(0.5, 10);
  });

  it("rises with the gap, and a full point is close to dominant", () => {
    expect(expectedWinShare(4.25, 4)).toBeCloseTo(0.64, 2);
    expect(expectedWinShare(5, 4)).toBeCloseTo(0.909, 3);
    expect(expectedWinShare(6, 4)).toBeCloseTo(0.99, 2);
  });

  it("is symmetric — the two sides always sum to one", () => {
    for (const [a, b] of [[3, 5], [4, 4.25], [6.5, 2]] as const) {
      expect(expectedWinShare(a, b) + expectedWinShare(b, a)).toBeCloseTo(1, 10);
    }
  });
});

describe("what a result implies", () => {
  it("moves nobody on a draw", () => {
    const changes = ratingChangesFromResults(
      [match(["a1", "a2"], ["b1", "b2"], 5, 5)],
      ratings({ a1: 4, a2: 4, b1: 4, b2: 4 }),
    );
    for (const change of changes) expect(change.delta).toBe(0);
    expect(materialRatingChanges(changes)).toEqual([]);
  });

  it("barely moves anyone when a result lands where the ratings said it would", () => {
    // A 5.0 pair against a 3.5 pair is expected to take roughly 97% of games,
    // so 6-0 is par: almost nothing changes hands.
    const changes = ratingChangesFromResults(
      [match(["s1", "s2"], ["w1", "w2"], 6, 0)],
      ratings({ s1: 5, s2: 5, w1: 3.5, w2: 3.5 }),
    );
    expect(Math.abs(changeFor(changes, "s1")?.delta ?? 1)).toBeLessThanOrEqual(0.01);
  });

  it("charges the favourites a little for winning by less than their rating implies", () => {
    // Same pairing, but 6-1 is slightly below a 97% expectation. This is a real
    // property of scoring on games won rather than win/loss, and it only bites
    // at wide gaps — which the scheduler avoids putting on court in the first
    // place, since it balances team averages to within a few hundredths.
    const changes = ratingChangesFromResults(
      [match(["s1", "s2"], ["w1", "w2"], 6, 1)],
      ratings({ s1: 5, s2: 5, w1: 3.5, w2: 3.5 }),
    );
    expect(changeFor(changes, "s1")?.delta).toBeCloseTo(-0.03, 2);
    expect(changeFor(changes, "w1")?.delta).toBeCloseTo(0.03, 2);
  });

  it("rewards an upset properly", () => {
    // A 3.5 pair had about a 9% expectation here and won two thirds of the games.
    const changes = ratingChangesFromResults(
      [match(["w1", "w2"], ["s1", "s2"], 6, 3)],
      ratings({ w1: 3.5, w2: 3.5, s1: 5, s2: 5 }),
    );
    expect(changeFor(changes, "w1")?.delta).toBeCloseTo(0.16, 2);
    expect(changeFor(changes, "s1")?.delta).toBeCloseTo(-0.16, 2);
  });

  it("reads the margin, not just the winner", () => {
    const narrow = ratingChangesFromResults(
      [match(["a1", "a2"], ["b1", "b2"], 6, 5)],
      ratings({ a1: 4, a2: 4, b1: 4, b2: 4 }),
    );
    const thrashing = ratingChangesFromResults(
      [match(["a1", "a2"], ["b1", "b2"], 6, 0)],
      ratings({ a1: 4, a2: 4, b1: 4, b2: 4 }),
    );
    const narrowDelta = changeFor(narrow, "a1")?.delta ?? 0;
    const thrashingDelta = changeFor(thrashing, "a1")?.delta ?? 0;
    expect(thrashingDelta).toBeGreaterThan(narrowDelta * 3);
  });

  it("treats both players in a pair identically", () => {
    const changes = ratingChangesFromResults(
      [match(["a1", "a2"], ["b1", "b2"], 6, 2)],
      ratings({ a1: 3, a2: 5, b1: 4, b2: 4 }),
    );
    expect(changeFor(changes, "a1")?.delta).toBe(changeFor(changes, "a2")?.delta);
  });

  it("is zero-sum within a single match", () => {
    const changes = ratingChangesFromResults(
      [match(["a1", "a2"], ["b1", "b2"], 6, 3)],
      ratings({ a1: 4, a2: 4.5, b1: 3.75, b2: 4.25 }),
    );
    expect(changes.reduce((sum, c) => sum + c.delta, 0)).toBeCloseTo(0, 10);
  });
});

describe("aggregating an evening", () => {
  it("counts how many games fed each change", () => {
    const changes = ratingChangesFromResults(
      [
        match(["hero", "p1"], ["q1", "q2"], 6, 3),
        match(["hero", "p2"], ["q1", "q3"], 6, 4),
      ],
      ratings({ hero: 4, p1: 4, p2: 4, q1: 4, q2: 4, q3: 4 }),
    );
    expect(changeFor(changes, "hero")?.gamesCounted).toBe(2);
    expect(changeFor(changes, "q1")?.gamesCounted).toBe(2);
    expect(changeFor(changes, "p1")?.gamesCounted).toBe(1);
  });

  it("judges every block against pre-session ratings, so entry order cannot matter", () => {
    const start = { hero: 4, p1: 4, p2: 4, q1: 4, q2: 4, q3: 4 };
    const first = match(["hero", "p1"], ["q1", "q2"], 6, 1);
    const second = match(["hero", "p2"], ["q1", "q3"], 6, 2);

    const forwards = ratingChangesFromResults([first, second], ratings(start));
    const backwards = ratingChangesFromResults([second, first], ratings(start));
    expect(changeFor(backwards, "hero")?.delta).toBe(changeFor(forwards, "hero")?.delta);

    // And the combined move is the sum of the individual moves — proof that no
    // block is evaluated against a rating another block already shifted.
    const aloneFirst = changeFor(ratingChangesFromResults([first], ratings(start)), "hero");
    const aloneSecond = changeFor(ratingChangesFromResults([second], ratings(start)), "hero");
    expect(changeFor(forwards, "hero")?.delta).toBeCloseTo(
      (aloneFirst?.delta ?? 0) + (aloneSecond?.delta ?? 0),
      2,
    );
  });

  it("moves a consistent over-performer about two thirds of a step over four games", () => {
    const start = Object.fromEntries(
      ["hero", "p0", "p1", "p2", "p3", "q0", "q1", "q2", "q3", "z0", "z1", "z2", "z3"].map(
        (id) => [id, 4],
      ),
    );
    const changes = ratingChangesFromResults(
      Array.from({ length: 4 }, (_, i) => match(["hero", `p${i}`], [`q${i}`, `z${i}`], 6, 3)),
      ratings(start),
    );
    const hero = changeFor(changes, "hero");
    expect(hero?.delta).toBeCloseTo(0.17, 2);
    expect(hero?.to).toBe(4.17);
  });
});

describe("guard rails", () => {
  it("caps how far one session can move a rating", () => {
    // Ten thrashings of a far stronger pair would run away without the cap.
    const results = Array.from({ length: 10 }, () =>
      match(["w1", "w2"], ["s1", "s2"], 6, 0),
    );
    const changes = ratingChangesFromResults(
      results,
      ratings({ w1: 3, w2: 3, s1: 6, s2: 6 }),
    );
    expect(changeFor(changes, "w1")?.delta).toBe(DEFAULT_RATING_UPDATE_OPTIONS.maxSessionChange);
    expect(changeFor(changes, "s1")?.delta).toBe(-DEFAULT_RATING_UPDATE_OPTIONS.maxSessionChange);
  });

  it("never pushes a rating past the ends of the scale", () => {
    const top = ratingChangesFromResults(
      [match(["a1", "a2"], ["b1", "b2"], 6, 0)],
      ratings({ a1: 7, a2: 7, b1: 1, b2: 1 }),
    );
    expect(changeFor(top, "a1")?.to).toBe(7);
    expect(changeFor(top, "b1")?.to).toBe(1);
  });

  it("respects a club that wants slower or faster movement", () => {
    const results = [match(["a1", "a2"], ["b1", "b2"], 6, 0)];
    const start = ratings({ a1: 4, a2: 4, b1: 4, b2: 4 });
    const slow = ratingChangesFromResults(results, start, { k: 0.05 });
    const fast = ratingChangesFromResults(results, start, { k: 1 });
    expect(changeFor(slow, "a1")?.delta).toBeLessThan(changeFor(fast, "a1")?.delta ?? 0);
  });

  it("ignores blocks with no score recorded", () => {
    expect(hasScore({ gamesA: 0, gamesB: 0 })).toBe(false);
    expect(hasScore({ gamesA: 6, gamesB: 0 })).toBe(true);
    expect(hasScore({ gamesA: -1, gamesB: 3 })).toBe(false);

    const changes = ratingChangesFromResults(
      [
        match(["a1", "a2"], ["b1", "b2"], 0, 0),
        match(["a1", "a2"], ["c1", "c2"], 6, 2),
      ],
      ratings({ a1: 4, a2: 4, b1: 4, b2: 4, c1: 4, c2: 4 }),
    );
    expect(changeFor(changes, "a1")?.gamesCounted).toBe(1);
    expect(changeFor(changes, "b1")).toBeUndefined();
  });

  it("returns nothing at all when no block has a score", () => {
    const changes = ratingChangesFromResults(
      [match(["a1", "a2"], ["b1", "b2"], 0, 0)],
      ratings({ a1: 4, a2: 4, b1: 4, b2: 4 }),
    );
    expect(changes).toEqual([]);
  });
});
