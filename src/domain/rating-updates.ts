import { clampRating } from "./rating";
import { DEFAULT_RATING_SCALE, type RatingScale } from "./types";

/**
 * Deriving ratings from results.
 *
 * This is Elo, adapted for padel doubles in two ways.
 *
 * A team's strength is the average of its two ratings, so a result says
 * something about both players equally — there is no way to tell from a score
 * which of the pair carried it.
 *
 * The outcome is the *share of games won*, not just who won. A 6-0 and a 6-5
 * are both wins but say very different things about the gap between two pairs,
 * and in a 30-minute social block the game count is the only signal of margin
 * available.
 */

export interface RatingUpdateOptions {
  /**
   * The rating gap at which the stronger pair is expected to win about ten
   * games to one. A full point on the classic 1-7 scale is a wide gap in padel
   * — a 4.0 pair rarely takes games off a 5.0 pair — so the default is 1.0.
   */
  spread: number;
  /**
   * How far one 30-minute game can move a rating, before the session cap.
   *
   * Calibrated against measured cases rather than picked: at 0.25, winning
   * every block 6-3 against evenly matched pairs moves a player about 0.17 over
   * a four-game evening, so two or three such nights cross a quarter-point step
   * on the classic scale, while a player performing to their rating barely
   * moves. Lower values make the whole feature inert — at 0.08 a dominant
   * evening moved a rating by 0.05, which would take twenty sessions to show up
   * as a single step.
   */
  k: number;
  /**
   * The most a single session may move one rating, in either direction.
   *
   * The per-game surprise term is small in the ordinary case but can approach
   * 1.0 when a pair beats opponents they had almost no business beating. A `k`
   * responsive enough to matter on a normal night would let one freak block
   * move a rating two steps, so the total is capped instead. Ratings feed the
   * draw, so thrashing them is worse than moving them slowly.
   */
  maxSessionChange: number;
  scale: RatingScale;
}

export const DEFAULT_RATING_UPDATE_OPTIONS: RatingUpdateOptions = {
  spread: 1,
  k: 0.25,
  maxSessionChange: 0.5,
  scale: DEFAULT_RATING_SCALE,
};

export interface MatchResult {
  teamA: readonly [string, string];
  teamB: readonly [string, string];
  /** Games won by team A in the block. */
  gamesA: number;
  /** Games won by team B in the block. */
  gamesB: number;
}

/** Share of games the first team is expected to win, between 0 and 1. */
export function expectedWinShare(
  teamRating: number,
  opponentRating: number,
  spread: number = DEFAULT_RATING_UPDATE_OPTIONS.spread,
): number {
  return 1 / (1 + 10 ** ((opponentRating - teamRating) / spread));
}

export interface PlayerRatingChange {
  playerId: string;
  from: number;
  to: number;
  /** `to - from`, at stored precision. */
  delta: number;
  /** How many scored games fed this change. */
  gamesCounted: number;
}

/** A score of 0-0 carries no information and is treated as "not recorded". */
export function hasScore(result: Pick<MatchResult, "gamesA" | "gamesB">): boolean {
  return (
    Number.isFinite(result.gamesA) &&
    Number.isFinite(result.gamesB) &&
    result.gamesA >= 0 &&
    result.gamesB >= 0 &&
    result.gamesA + result.gamesB > 0
  );
}

/**
 * Work out what a set of results implies for each player's rating.
 *
 * Every match is judged against the ratings players held *before* the session,
 * not against ratings that shift as the evening is processed. Otherwise the
 * order the blocks happened to be entered in would change the answer, and the
 * same night re-entered would give a different result.
 */
export function ratingChangesFromResults(
  results: MatchResult[],
  ratings: ReadonlyMap<string, number>,
  options: Partial<RatingUpdateOptions> = {},
): PlayerRatingChange[] {
  const { spread, k, maxSessionChange, scale } = {
    ...DEFAULT_RATING_UPDATE_OPTIONS,
    ...options,
  };

  const totals = new Map<string, { delta: number; games: number }>();
  const bump = (playerId: string, delta: number) => {
    const current = totals.get(playerId) ?? { delta: 0, games: 0 };
    totals.set(playerId, { delta: current.delta + delta, games: current.games + 1 });
  };

  for (const result of results) {
    if (!hasScore(result)) continue;

    const ratingOf = (id: string) => ratings.get(id) ?? scale.min;
    const teamA = (ratingOf(result.teamA[0]) + ratingOf(result.teamA[1])) / 2;
    const teamB = (ratingOf(result.teamB[0]) + ratingOf(result.teamB[1])) / 2;

    const expected = expectedWinShare(teamA, teamB, spread);
    const actual = result.gamesA / (result.gamesA + result.gamesB);
    const delta = k * (actual - expected);

    for (const id of result.teamA) bump(id, delta);
    // Exactly the mirror of team A's delta, so each match is zero-sum in raw
    // terms. The totals across a session are only approximately conserved:
    // rounding to stored precision, the session cap, and clamping at the ends
    // of the scale all break it, and a player already at the top of the scale
    // genuinely cannot absorb a further gain.
    for (const id of result.teamB) bump(id, -delta);
  }

  const changes: PlayerRatingChange[] = [];
  for (const [playerId, { delta, games }] of totals) {
    const from = ratings.get(playerId) ?? scale.min;
    const capped = Math.max(-maxSessionChange, Math.min(maxSessionChange, delta));
    const to = clampRating(from + capped, scale);
    changes.push({
      playerId,
      from,
      to,
      delta: Number((to - from).toFixed(2)),
      gamesCounted: games,
    });
  }

  return changes.sort(
    (a, b) => b.delta - a.delta || a.playerId.localeCompare(b.playerId),
  );
}

/** Only the players whose stored rating would actually change. */
export function materialRatingChanges(changes: PlayerRatingChange[]): PlayerRatingChange[] {
  return changes.filter((change) => change.to !== change.from);
}
