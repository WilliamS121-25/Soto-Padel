import { computeCapacity, playableBlocksFrom } from "./timeline";
import type { Session, Signup } from "./types";

export interface SignupIssue {
  signupId: string;
  playerId: string;
  kind: "ARRIVES_TOO_LATE" | "REQUEST_EXCEEDS_AVAILABILITY";
  message: string;
  /** For REQUEST_EXCEEDS_AVAILABILITY, the most they could actually play. */
  playableBlocks: number;
}

export interface AllocationResult {
  confirmed: Signup[];
  reserves: Signup[];
  withdrawn: Signup[];
  committedPlayerBlocks: number;
  totalPlayerBlocks: number;
  remainingPlayerBlocks: number;
  issues: SignupIssue[];
}

function byQueue(a: Signup, b: Signup): number {
  return a.queuePosition - b.queuePosition || a.id.localeCompare(b.id);
}

/**
 * Decide who is in and who waits.
 *
 * Places are allocated in signup order (the WhatsApp queue) and measured in
 * player-blocks, not head count: someone asking for four 30-minute games takes
 * four of the available blocks. Once the next signup in the queue does not fit,
 * they go on the reserve list.
 *
 * `allowSkipAhead` controls what happens when the next reserve is too big for
 * the space left. With it on (the default) a smaller signup further down the
 * queue can take the space rather than leaving a court seat empty; the skipped
 * player keeps their place in the queue for the next opening. With it off, the
 * queue is strictly first-come-first-served and the remaining blocks go unused.
 */
export function allocateSignups(
  session: Session,
  signups: Signup[],
  options: { allowSkipAhead?: boolean } = {},
): AllocationResult {
  const allowSkipAhead = options.allowSkipAhead ?? true;
  const { totalPlayerBlocks } = computeCapacity(session);

  const withdrawn = signups.filter((s) => s.status === "WITHDRAWN").sort(byQueue);
  const active = signups.filter((s) => s.status !== "WITHDRAWN").sort(byQueue);

  const confirmed: Signup[] = [];
  const reserves: Signup[] = [];
  const issues: SignupIssue[] = [];
  let committed = 0;

  for (const signup of active) {
    const playable = playableBlocksFrom(session, signup.earliestStartMinutes);

    if (playable === 0) {
      issues.push({
        signupId: signup.id,
        playerId: signup.playerId,
        kind: "ARRIVES_TOO_LATE",
        message: "No court is running at or after this player's start time.",
        playableBlocks: 0,
      });
      reserves.push({ ...signup, status: "RESERVE" });
      continue;
    }

    if (signup.requestedSlots > playable) {
      issues.push({
        signupId: signup.id,
        playerId: signup.playerId,
        kind: "REQUEST_EXCEEDS_AVAILABILITY",
        message: `Asked for ${signup.requestedSlots} games but only ${playable} fit after their start time.`,
        playableBlocks: playable,
      });
    }

    // Never commit more blocks than the player could physically play.
    const effectiveBlocks = Math.min(signup.requestedSlots, playable);
    const fits = committed + effectiveBlocks <= totalPlayerBlocks;

    if (fits) {
      committed += effectiveBlocks;
      confirmed.push({ ...signup, status: "CONFIRMED", requestedSlots: effectiveBlocks });
    } else {
      reserves.push({ ...signup, status: "RESERVE" });
      if (!allowSkipAhead) {
        // Strict queue: everyone after the first player who does not fit waits too.
        const index = active.indexOf(signup);
        for (const rest of active.slice(index + 1)) {
          reserves.push({ ...rest, status: "RESERVE" });
        }
        break;
      }
    }
  }

  return {
    confirmed,
    reserves,
    withdrawn,
    committedPlayerBlocks: committed,
    totalPlayerBlocks,
    remainingPlayerBlocks: Math.max(0, totalPlayerBlocks - committed),
    issues,
  };
}

export interface PromotionResult {
  allocation: AllocationResult;
  /** Players moved from reserve to confirmed by this change. */
  promoted: string[];
  /** Reserves who still do not fit, in queue order. */
  stillWaiting: string[];
}

/**
 * Recalculate the lists after someone drops out. Reserves are reconsidered in
 * queue order, so the next person in line gets the freed place.
 */
export function withdrawAndPromote(
  session: Session,
  signups: Signup[],
  withdrawingPlayerId: string,
  options: { allowSkipAhead?: boolean } = {},
): PromotionResult {
  const before = allocateSignups(session, signups, options);
  const confirmedBefore = new Set(before.confirmed.map((s) => s.playerId));

  const updated = signups.map((s) =>
    s.playerId === withdrawingPlayerId ? { ...s, status: "WITHDRAWN" as const } : s,
  );
  const after = allocateSignups(session, updated, options);
  const confirmedAfter = new Set(after.confirmed.map((s) => s.playerId));

  const promoted = [...confirmedAfter].filter(
    (id) => !confirmedBefore.has(id) && id !== withdrawingPlayerId,
  );

  return {
    allocation: after,
    promoted,
    stillWaiting: after.reserves.map((s) => s.playerId),
  };
}
