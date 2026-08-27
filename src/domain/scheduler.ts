import { HistoryIndex, pairKey } from "./history";
import { buildTimeline } from "./timeline";
import { PLAYERS_PER_COURT, type Match, type Round, type Session, type Signup } from "./types";

export interface SchedulerWeights {
  /**
   * Cost of pairing two players who have already partnered **in this mixin**.
   * Large enough to act as a rule rather than a preference.
   */
  sessionRepeatPartner: number;
  /** Cost of two players facing each other again **in this mixin**. */
  sessionRepeatOpponent: number;
  /** Cost of putting two players together who partnered in an earlier mixin. */
  repeatPartner: number;
  /** Cost of two players facing each other again across mixins. */
  repeatOpponent: number;
  /** Cost per rating point of spread within a group of four. */
  ratingSpread: number;
  /** Cost per rating point of difference between the two teams. */
  teamImbalance: number;
  /** Extra cost per rating point squared, so a wide gap is resisted hard. */
  teamImbalanceSquared: number;
}

/**
 * Defaults chosen by measuring draws across seven mixin shapes (8-28 players on
 * 2-5 courts), not by taste. They encode the club's four rules, in the order
 * the club stated them:
 *
 * 1. Nobody partners the same player twice in a mixin.
 * 2. Nobody faces the same player twice in a mixin.
 * 3. The two teams in a four add up to a similar total.
 * 4. Lower-rated players get to play with and against higher-rated ones.
 *
 * Rules 1 and 2 are enforced by weights three orders of magnitude larger than
 * the rest, which makes them rules in practice: the scheduler gives up a level
 * match to keep them. They are still weights rather than a hard filter because
 * **they cannot always both be satisfied** — eight players over four rounds
 * need eight distinct opponents each and there are only seven other people, so
 * some repeat is arithmetic, not a bug. Where a repeat is forced, this ranking
 * makes the draw take an opponent repeat before a partner repeat, and
 * `summariseRepeats` reports what it had to accept.
 *
 * Rule 4 is why `ratingSpread` is small: a high cost there keeps each four
 * inside a narrow band, which is exactly what the club did *not* want. Rule 3
 * is carried by `teamImbalance` plus a squared term, so a small gap is cheap
 * and a wide one is resisted hard — that combination held the average gap
 * between the two teams to 0.05-0.29 rating points across every shape measured.
 *
 * Measured totals over the seven shapes: 0 repeat partnerships anywhere, and 13
 * repeat opponent pairs, against 14-41 for the weightings tried alongside.
 * Every weight is overridable per call if a club disagrees.
 */
export const DEFAULT_WEIGHTS: SchedulerWeights = {
  sessionRepeatPartner: 2000,
  sessionRepeatOpponent: 600,
  repeatPartner: 8,
  repeatOpponent: 2.5,
  ratingSpread: 2,
  teamImbalance: 40,
  teamImbalanceSquared: 600,
};

export interface SchedulerInput {
  session: Session;
  /** Confirmed signups only. */
  signups: Signup[];
  ratings: ReadonlyMap<string, number>;
  /** Cross-session history; defaults to empty. */
  history?: HistoryIndex;
  weights?: Partial<SchedulerWeights>;
  /** Change to shuffle tie-breaks and get a different valid schedule. */
  seed?: number;
}

export interface PlayerAllocation {
  playerId: string;
  requested: number;
  scheduled: number;
}

export interface ScheduleResult {
  rounds: Round[];
  matches: Match[];
  allocations: PlayerAllocation[];
  /** Players who got fewer games than they asked for. */
  shortfalls: PlayerAllocation[];
  /** Court-blocks that ran with no game because fewer than four were free. */
  idleCourtBlocks: number;
  /** Repeats the draw could not avoid. Empty is the normal case. */
  repeats: RepeatSummary;
  totalCost: number;
}

/** A pair of players who met more than once, and how many times. */
export interface RepeatedPair {
  playerIds: readonly [string, string];
  times: number;
}

export interface RepeatSummary {
  /** Pairs who partnered more than once in this mixin. */
  partnerships: RepeatedPair[];
  /** Pairs who faced each other more than once in this mixin. */
  opponents: RepeatedPair[];
}

/** Small deterministic PRNG so a seed always reproduces the same schedule. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAIRINGS: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 2, 3],
  [0, 2, 1, 3],
  [0, 3, 1, 2],
];

function ratingOf(ratings: ReadonlyMap<string, number>, id: string): number {
  return ratings.get(id) ?? 0;
}

/** Best of the three ways to split four players into two teams. */
function bestPairing(
  group: readonly string[],
  ratings: ReadonlyMap<string, number>,
  history: HistoryIndex,
  session: HistoryIndex,
  weights: SchedulerWeights,
): { cost: number; teamA: readonly [string, string]; teamB: readonly [string, string] } {
  const values = group.map((id) => ratingOf(ratings, id));
  const spread = Math.max(...values) - Math.min(...values);
  const spreadCost = weights.ratingSpread * spread;

  let best: {
    cost: number;
    teamA: readonly [string, string];
    teamB: readonly [string, string];
  } | null = null;

  for (const [i, j, k, l] of PAIRINGS) {
    const a1 = group[i];
    const a2 = group[j];
    const b1 = group[k];
    const b2 = group[l];
    if (!a1 || !a2 || !b1 || !b2) continue;

    const repeatPartners = history.partnerCount(a1, a2) + history.partnerCount(b1, b2);
    const repeatOpponents =
      history.opponentCount(a1, b1) +
      history.opponentCount(a1, b2) +
      history.opponentCount(a2, b1) +
      history.opponentCount(a2, b2);

    const samePartners = session.partnerCount(a1, a2) + session.partnerCount(b1, b2);
    const sameOpponents =
      session.opponentCount(a1, b1) +
      session.opponentCount(a1, b2) +
      session.opponentCount(a2, b1) +
      session.opponentCount(a2, b2);

    const teamAAvg = (ratingOf(ratings, a1) + ratingOf(ratings, a2)) / 2;
    const teamBAvg = (ratingOf(ratings, b1) + ratingOf(ratings, b2)) / 2;
    const gap = Math.abs(teamAAvg - teamBAvg);

    const cost =
      spreadCost +
      weights.sessionRepeatPartner * samePartners +
      weights.sessionRepeatOpponent * sameOpponents +
      weights.repeatPartner * repeatPartners +
      weights.repeatOpponent * repeatOpponents +
      weights.teamImbalance * gap +
      weights.teamImbalanceSquared * gap * gap;

    if (!best || cost < best.cost) {
      best = { cost, teamA: [a1, a2] as const, teamB: [b1, b2] as const };
    }
  }

  // Unreachable for a group of four, but keeps the return type honest.
  if (!best) {
    const [p0 = "", p1 = "", p2 = "", p3 = ""] = group;
    return { cost: 0, teamA: [p0, p1] as const, teamB: [p2, p3] as const };
  }
  return best;
}

/**
 * Every pair that met more than once across a set of matches.
 *
 * Two players partnering twice, or facing each other twice, is the thing the
 * club asked the draw to rule out — so when the arithmetic makes it impossible,
 * the organiser is told rather than left to spot it. Pure, and takes plain
 * matches, so it reports on a draw loaded from the database just as well as on
 * one just generated.
 */
export function summariseRepeats(
  matches: readonly Pick<Match, "teamA" | "teamB">[],
): RepeatSummary {
  const partners = new Map<string, number>();
  const opponents = new Map<string, number>();

  for (const match of matches) {
    const [a1, a2] = match.teamA;
    const [b1, b2] = match.teamB;
    for (const [x, y] of [
      [a1, a2],
      [b1, b2],
    ] as const) {
      partners.set(pairKey(x, y), (partners.get(pairKey(x, y)) ?? 0) + 1);
    }
    for (const a of [a1, a2]) {
      for (const b of [b1, b2]) {
        opponents.set(pairKey(a, b), (opponents.get(pairKey(a, b)) ?? 0) + 1);
      }
    }
  }

  const repeatsIn = (counts: Map<string, number>): RepeatedPair[] =>
    [...counts]
      .filter(([, times]) => times > 1)
      .map(([key, times]) => {
        const [first = "", second = ""] = key.split("|");
        return { playerIds: [first, second] as const, times };
      })
      .sort((x, y) => y.times - x.times || x.playerIds[0].localeCompare(y.playerIds[0]));

  return { partnerships: repeatsIn(partners), opponents: repeatsIn(opponents) };
}

/**
 * Improve an initial grouping by swapping players between courts whenever it
 * lowers total cost. The search space is tiny (at most five courts), so an
 * exhaustive hill-climb runs in microseconds and is fully deterministic.
 */
function refineGroups(
  groups: string[][],
  ratings: ReadonlyMap<string, number>,
  history: HistoryIndex,
  session: HistoryIndex,
  weights: SchedulerWeights,
  maxPasses = 8,
): void {
  const costOf = (group: string[]) => bestPairing(group, ratings, history, session, weights).cost;
  const costs = groups.map(costOf);

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;
    for (let g1 = 0; g1 < groups.length; g1 += 1) {
      for (let g2 = g1 + 1; g2 < groups.length; g2 += 1) {
        const groupA = groups[g1];
        const groupB = groups[g2];
        if (!groupA || !groupB) continue;

        for (let i = 0; i < groupA.length; i += 1) {
          for (let j = 0; j < groupB.length; j += 1) {
            const playerA = groupA[i];
            const playerB = groupB[j];
            if (playerA === undefined || playerB === undefined) continue;

            groupA[i] = playerB;
            groupB[j] = playerA;
            const newA = costOf(groupA);
            const newB = costOf(groupB);
            const before = (costs[g1] ?? 0) + (costs[g2] ?? 0);

            if (newA + newB < before - 1e-9) {
              costs[g1] = newA;
              costs[g2] = newB;
              improved = true;
            } else {
              groupA[i] = playerA;
              groupB[j] = playerB;
            }
          }
        }
      }
    }
    if (!improved) break;
  }
}

/**
 * Generate the running order for a mixin.
 *
 * For each 30-minute block the scheduler works out who is present and still owes
 * games, prioritises whoever is at most risk of not getting their full quota,
 * groups them, then chooses teams. Within a mixin nobody should partner or face
 * the same player twice; where the numbers make that impossible the draw takes
 * the smallest compromise it can find and `repeats` says what it was. See
 * `DEFAULT_WEIGHTS` for the full ordering.
 */
export function generateSchedule(input: SchedulerInput): ScheduleResult {
  const { session, signups, ratings } = input;
  const weights = { ...DEFAULT_WEIGHTS, ...input.weights };
  const history = (input.history ?? new HistoryIndex()).clone();
  /**
   * Repeats within this mixin, kept apart from the cross-session history so the
   * two can carry different weights: playing with someone again tonight is a
   * rule to be broken only when the numbers make it unavoidable, whereas
   * playing with them again a month later is merely a mild preference.
   */
  const sessionSoFar = new HistoryIndex();
  const rng = mulberry32(input.seed ?? 0x50d0);
  /**
   * With no seed the grouping follows rating order exactly, which gives the
   * best level match. Passing a seed nudges ratings by up to this many points
   * when forming the initial groups, so "re-roll" produces a genuinely
   * different draw rather than the same one every time.
   */
  const jitterScale = input.seed === undefined ? 0 : 0.35;

  const timeline = buildTimeline(session).filter((slot) => slot.courts.length > 0);

  const remaining = new Map<string, number>();
  const requested = new Map<string, number>();
  const earliest = new Map<string, number>();
  const playedCount = new Map<string, number>();

  for (const signup of signups) {
    remaining.set(signup.playerId, signup.requestedSlots);
    requested.set(signup.playerId, signup.requestedSlots);
    earliest.set(signup.playerId, signup.earliestStartMinutes);
    playedCount.set(signup.playerId, 0);
  }

  const rounds: Round[] = [];
  const allMatches: Match[] = [];
  let idleCourtBlocks = 0;
  let totalCost = 0;

  for (let index = 0; index < timeline.length; index += 1) {
    const slot = timeline[index];
    if (!slot) continue;

    const available = signups
      .map((s) => s.playerId)
      .filter(
        (id) =>
          (remaining.get(id) ?? 0) > 0 &&
          slot.startMinutes >= (earliest.get(id) ?? Number.POSITIVE_INFINITY),
      );

    // How many further chances each player has, used to prioritise fairly.
    const chancesLeft = new Map<string, number>();
    for (const id of available) {
      const from = earliest.get(id) ?? 0;
      const count = timeline
        .slice(index)
        .filter((s) => s.startMinutes >= from && s.courts.length > 0).length;
      chancesLeft.set(id, count);
    }

    const jitter = new Map<string, number>();
    const ratingNoise = new Map<string, number>();
    for (const id of available) {
      jitter.set(id, rng());
      ratingNoise.set(id, (rng() - 0.5) * 2 * jitterScale);
    }
    const seededRating = (id: string) => ratingOf(ratings, id) + (ratingNoise.get(id) ?? 0);

    const ordered = [...available].sort((x, y) => {
      const urgencyX = (remaining.get(x) ?? 0) / Math.max(1, chancesLeft.get(x) ?? 1);
      const urgencyY = (remaining.get(y) ?? 0) / Math.max(1, chancesLeft.get(y) ?? 1);
      if (urgencyX !== urgencyY) return urgencyY - urgencyX;

      const remX = remaining.get(x) ?? 0;
      const remY = remaining.get(y) ?? 0;
      if (remX !== remY) return remY - remX;

      const playedX = playedCount.get(x) ?? 0;
      const playedY = playedCount.get(y) ?? 0;
      if (playedX !== playedY) return playedX - playedY;

      return (jitter.get(x) ?? 0) - (jitter.get(y) ?? 0);
    });

    const seats = slot.courts.length * PLAYERS_PER_COURT;
    const playableCount = Math.min(
      seats,
      Math.floor(ordered.length / PLAYERS_PER_COURT) * PLAYERS_PER_COURT,
    );
    const playing = ordered.slice(0, playableCount);
    const sittingOut = ordered.slice(playableCount);

    const courtsUsed = playableCount / PLAYERS_PER_COURT;
    idleCourtBlocks += slot.courts.length - courtsUsed;

    // Seed the grouping by rating so each court starts out level-matched. When
    // an explicit seed is supplied the ratings are nudged slightly first, which
    // starts the search from a different place and yields a different — but
    // still level-matched — draw for the same group of players.
    const byRating = [...playing].sort(
      (x, y) =>
        seededRating(y) - seededRating(x) || (jitter.get(x) ?? 0) - (jitter.get(y) ?? 0),
    );
    const groups: string[][] = [];
    for (let i = 0; i < byRating.length; i += PLAYERS_PER_COURT) {
      groups.push(byRating.slice(i, i + PLAYERS_PER_COURT));
    }

    refineGroups(groups, ratings, history, sessionSoFar, weights);

    // Strongest four on the lowest court number, which is the usual convention.
    const ranked = groups
      .map((group) => ({
        group,
        avg:
          group.reduce((sum, id) => sum + ratingOf(ratings, id), 0) / Math.max(1, group.length),
      }))
      .sort((a, b) => b.avg - a.avg);

    const courtNumbers = slot.courts.map((c) => c.courtNumber).slice(0, ranked.length);

    const matches: Match[] = [];
    for (let g = 0; g < ranked.length; g += 1) {
      const entry = ranked[g];
      const courtNumber = courtNumbers[g];
      if (!entry || courtNumber === undefined) continue;

      const pairing = bestPairing(entry.group, ratings, history, sessionSoFar, weights);
      totalCost += pairing.cost;

      const match: Match = {
        slotIndex: slot.slotIndex,
        courtNumber,
        teamA: pairing.teamA,
        teamB: pairing.teamB,
      };
      matches.push(match);
      allMatches.push(match);

      history.record(match, session.date);
      sessionSoFar.record(match);
      for (const id of [...pairing.teamA, ...pairing.teamB]) {
        remaining.set(id, (remaining.get(id) ?? 0) - 1);
        playedCount.set(id, (playedCount.get(id) ?? 0) + 1);
      }
    }

    rounds.push({
      slotIndex: slot.slotIndex,
      startMinutes: slot.startMinutes,
      matches: matches.sort((a, b) => a.courtNumber - b.courtNumber),
      sittingOut,
    });
  }

  const allocations: PlayerAllocation[] = signups.map((s) => ({
    playerId: s.playerId,
    requested: requested.get(s.playerId) ?? 0,
    scheduled: playedCount.get(s.playerId) ?? 0,
  }));

  return {
    rounds,
    matches: allMatches,
    allocations,
    shortfalls: allocations.filter((a) => a.scheduled < a.requested),
    idleCourtBlocks,
    repeats: summariseRepeats(allMatches),
    totalCost,
  };
}

/**
 * Rebuild the round-by-round view from a schedule that was saved earlier.
 *
 * The stored matches say who plays where; they do not record who was waiting.
 * That is recovered by walking the blocks in order and tracking how many games
 * each player has left, so "sitting out" means genuinely waiting for a court
 * rather than already finished for the evening.
 */
export function reconstructRounds(
  session: Session,
  confirmed: Signup[],
  matches: Match[],
): Round[] {
  const timeline = buildTimeline(session).filter((slot) => slot.courts.length > 0);
  const remaining = new Map(confirmed.map((s) => [s.playerId, s.requestedSlots]));
  const earliest = new Map(confirmed.map((s) => [s.playerId, s.earliestStartMinutes]));

  const rounds: Round[] = [];
  for (const slot of timeline) {
    const slotMatches = matches
      .filter((m) => m.slotIndex === slot.slotIndex)
      .sort((a, b) => a.courtNumber - b.courtNumber);
    const playing = new Set(slotMatches.flatMap((m) => [...m.teamA, ...m.teamB]));

    const sittingOut = confirmed
      .map((s) => s.playerId)
      .filter(
        (id) =>
          !playing.has(id) &&
          (remaining.get(id) ?? 0) > 0 &&
          slot.startMinutes >= (earliest.get(id) ?? Number.POSITIVE_INFINITY),
      );

    for (const id of playing) remaining.set(id, (remaining.get(id) ?? 0) - 1);

    if (slotMatches.length > 0 || sittingOut.length > 0) {
      rounds.push({
        slotIndex: slot.slotIndex,
        startMinutes: slot.startMinutes,
        matches: slotMatches,
        sittingOut,
      });
    }
  }
  return rounds;
}

export interface ScheduleDrift {
  /** In the saved draw but no longer attending. */
  scheduledButNotAttending: string[];
  /** Confirmed to play but absent from the saved draw. */
  confirmedButNotScheduled: string[];
  isStale: boolean;
}

/**
 * Compare a saved draw against the current signup list.
 *
 * Signups keep moving after the line-ups are drawn — someone drops out, a
 * reserve moves up, a court gets added. When that happens the saved draw is
 * quietly wrong, and the payment split that follows from it is wrong too. This
 * spots the mismatch so the admin is told to redraw rather than sending out
 * stale line-ups.
 */
export function detectScheduleDrift(confirmed: Signup[], matches: Match[]): ScheduleDrift {
  const scheduled = new Set(matches.flatMap((m) => [...m.teamA, ...m.teamB]));
  const confirmedIds = new Set(confirmed.map((s) => s.playerId));

  const scheduledButNotAttending = [...scheduled].filter((id) => !confirmedIds.has(id));
  const confirmedButNotScheduled = [...confirmedIds].filter((id) => !scheduled.has(id));

  return {
    scheduledButNotAttending,
    confirmedButNotScheduled,
    isStale:
      matches.length > 0 &&
      (scheduledButNotAttending.length > 0 || confirmedButNotScheduled.length > 0),
  };
}
