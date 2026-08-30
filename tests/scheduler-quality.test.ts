import { describe, expect, it } from "vitest";
import { pairKey } from "@/domain/history";
import { generateSchedule } from "@/domain/scheduler";
import { court, ladder, makeSession, makeSignup, ratingMap } from "./fixtures";

/**
 * The club's draw rules, measured across the range of mixins it actually runs
 * rather than on one scenario.
 *
 * This exists because `DEFAULT_WEIGHTS` was chosen by sweeping these shapes: a
 * single scenario sits inside the hill-climb's run-to-run noise, so tuning on
 * one fits noise rather than quality. The bounds below are deliberately loose
 * enough to survive that noise and tight enough to catch a real regression —
 * the weighting these defaults replaced scored 183 repeat opponent pairs here,
 * against the 13 they score now.
 */
const SHAPES = [
  { players: 8, courts: 2, blocks: 4 },
  { players: 12, courts: 3, blocks: 4 },
  { players: 16, courts: 4, blocks: 4 },
  { players: 16, courts: 3, blocks: 5 },
  { players: 20, courts: 5, blocks: 4 },
  { players: 24, courts: 5, blocks: 6 },
  { players: 28, courts: 5, blocks: 6 },
] as const;

const LOW = 2.0;
const HIGH = 6.0;

function draw(shape: (typeof SHAPES)[number]) {
  const players = ladder(shape.players, LOW, HIGH);
  const session = makeSession({
    slotCount: shape.blocks,
    courts: Array.from({ length: shape.courts }, (_, i) => court(i + 1, "18:00", shape.blocks)),
  });
  const signups = players.map((p, i) => makeSignup(p.id, shape.blocks, "18:00", i + 1));
  const ratings = ratingMap(players);
  return { result: generateSchedule({ session, signups, ratings }), ratings, players };
}

const label = (shape: (typeof SHAPES)[number]) =>
  `${shape.players} players, ${shape.courts} courts, ${shape.blocks} blocks`;

describe("the draw rules, across every shape the club runs", () => {
  const drawn = SHAPES.map((shape) => ({ shape, ...draw(shape) }));

  it("never repeats a partnership, in any shape", () => {
    // Partner slots are two per match, always well inside the number of
    // distinct pairs available, so this one is achievable everywhere and there
    // is no excuse for a repeat.
    for (const { shape, result } of drawn) {
      expect(result.repeats.partnerships, label(shape)).toEqual([]);
    }
  });

  it("keeps opponent repeats to the few that the numbers force", () => {
    const total = drawn.reduce(
      (sum, { result }) =>
        sum + result.repeats.opponents.reduce((n, r) => n + (r.times - 1), 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(40);
  });

  it("only accepts an opponent repeat where the pool is genuinely too small", () => {
    for (const { shape, result } of drawn) {
      const pairs = (shape.players * (shape.players - 1)) / 2;
      const opponentSlots = result.matches.length * 4;
      // Where there is comfortable room — twice as many distinct pairs as
      // opponent slots — the draw should find a clean answer.
      if (pairs > opponentSlots * 2) {
        expect(result.repeats.opponents, label(shape)).toEqual([]);
      }
    }
  });

  it("keeps the two teams in a four evenly matched", () => {
    for (const { shape, result, ratings } of drawn) {
      const gaps = result.matches.map((m) => {
        const avg = (team: readonly [string, string]) =>
          ((ratings.get(team[0]) ?? 0) + (ratings.get(team[1]) ?? 0)) / 2;
        return Math.abs(avg(m.teamA) - avg(m.teamB));
      });
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      // Over a 4.0-point ladder: the typical game is close, and none is a
      // walkover on paper.
      expect(mean, `mean gap, ${label(shape)}`).toBeLessThan(0.35);
      expect(Math.max(...gaps), `worst gap, ${label(shape)}`).toBeLessThan(1.25);
    }
  });

  it("mixes levels instead of banding players by rating", () => {
    for (const { shape, result, ratings } of drawn) {
      const spreads = result.matches.map((m) => {
        const values = [...m.teamA, ...m.teamB].map((id) => ratings.get(id) ?? 0);
        return Math.max(...values) - Math.min(...values);
      });
      const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
      // A banded draw would keep every four inside a narrow slice of the
      // ladder. Over a 4.0-point range, a mean spread above a third of it means
      // lower-rated players really are getting games with stronger ones.
      expect(mean, `mean spread, ${label(shape)}`).toBeGreaterThan((HIGH - LOW) / 3);
    }
  });

  it("still gets everyone the games they asked for when there is room", () => {
    for (const { shape, result } of drawn) {
      const seats = shape.courts * 4 * shape.blocks;
      if (seats >= shape.players * shape.blocks) {
        expect(result.shortfalls, label(shape)).toEqual([]);
      }
    }
  });
});
