import { formatTime } from "./time";
import { buildTimeline } from "./timeline";
import { PLAYERS_PER_COURT, type Match, type Session, type Signup } from "./types";

/**
 * Everything that can be wrong with a line-up an admin typed by hand.
 *
 * The generated draw cannot break any of these — it allocates from the same
 * remaining-games counters it decrements — but a hand edit can, and silently
 * accepting one produces line-ups that cannot be played: somebody on two courts
 * at once, or down for more games than they signed up for.
 *
 * Deliberately structured rather than pre-worded, because the domain has no
 * player names. `describeLineupProblem` turns one into a sentence.
 */
export type LineupProblem =
  /** Somebody on court who is not a confirmed player for this mixin. */
  | { kind: "NOT_ATTENDING"; playerId: string }
  /** The same person filling two of the four seats on one court. */
  | { kind: "REPEATED_IN_MATCH"; playerId: string; slotIndex: number; courtNumber: number }
  /** The same person on two courts in the same half-hour. */
  | { kind: "DOUBLE_BOOKED"; playerId: string; slotIndex: number; courtNumbers: number[] }
  /** Down to play a block that starts before they said they could get there. */
  | {
      kind: "NOT_ARRIVED";
      playerId: string;
      slotIndex: number;
      startMinutes: number;
      earliestStartMinutes: number;
    }
  /** Down for more games than they asked for. */
  | { kind: "TOO_MANY_GAMES"; playerId: string; scheduled: number; requested: number };

export interface LineupCheckInput {
  session: Session;
  /** Confirmed signups — the people who are actually playing. */
  confirmed: Signup[];
  /** The whole proposed draw, not just the part that changed. */
  matches: Match[];
}

/**
 * Check a proposed draw against the mixin it belongs to.
 *
 * Takes the **whole** draw rather than the edited round, because two of the
 * rules span rounds: how many games someone ends up with is a property of the
 * evening, and moving a player between blocks can only be judged against the
 * rest. Returns every problem it finds, in a stable order, so the admin can fix
 * them in one pass instead of one refusal at a time.
 */
export function checkLineups(input: LineupCheckInput): LineupProblem[] {
  const { session, confirmed, matches } = input;

  const requested = new Map(confirmed.map((s) => [s.playerId, s.requestedSlots]));
  const earliest = new Map(confirmed.map((s) => [s.playerId, s.earliestStartMinutes]));
  const slotStart = new Map(
    buildTimeline(session).map((slot) => [slot.slotIndex, slot.startMinutes]),
  );

  const problems: LineupProblem[] = [];
  const unknown = new Set<string>();
  const scheduled = new Map<string, number>();
  /** slotIndex -> playerId -> the courts they are down for in that block. */
  const perSlot = new Map<number, Map<string, number[]>>();

  const ordered = [...matches].sort(
    (a, b) => a.slotIndex - b.slotIndex || a.courtNumber - b.courtNumber,
  );

  for (const match of ordered) {
    const four = [...match.teamA, ...match.teamB];
    const seenHere = new Set<string>();
    let courts = perSlot.get(match.slotIndex);
    if (!courts) {
      courts = new Map();
      perSlot.set(match.slotIndex, courts);
    }

    for (const playerId of four) {
      if (!requested.has(playerId)) {
        if (!unknown.has(playerId)) {
          unknown.add(playerId);
          problems.push({ kind: "NOT_ATTENDING", playerId });
        }
        continue;
      }

      // The same name twice on one court is its own mistake: reporting it as a
      // double booking would name one court and read like a puzzle.
      if (seenHere.has(playerId)) {
        problems.push({
          kind: "REPEATED_IN_MATCH",
          playerId,
          slotIndex: match.slotIndex,
          courtNumber: match.courtNumber,
        });
        continue;
      }
      seenHere.add(playerId);

      courts.set(playerId, [...(courts.get(playerId) ?? []), match.courtNumber]);
      scheduled.set(playerId, (scheduled.get(playerId) ?? 0) + 1);

      const start = slotStart.get(match.slotIndex);
      const from = earliest.get(playerId);
      if (start !== undefined && from !== undefined && start < from) {
        problems.push({
          kind: "NOT_ARRIVED",
          playerId,
          slotIndex: match.slotIndex,
          startMinutes: start,
          earliestStartMinutes: from,
        });
      }
    }
  }

  for (const [slotIndex, courts] of [...perSlot].sort((a, b) => a[0] - b[0])) {
    for (const [playerId, courtNumbers] of courts) {
      if (courtNumbers.length > 1) {
        problems.push({ kind: "DOUBLE_BOOKED", playerId, slotIndex, courtNumbers });
      }
    }
  }

  for (const signup of confirmed) {
    const count = scheduled.get(signup.playerId) ?? 0;
    if (count > signup.requestedSlots) {
      problems.push({
        kind: "TOO_MANY_GAMES",
        playerId: signup.playerId,
        scheduled: count,
        requested: signup.requestedSlots,
      });
    }
  }

  return problems;
}

/** One problem as a sentence, given a way to turn a player id into a name. */
export function describeLineupProblem(
  problem: LineupProblem,
  playerName: (playerId: string) => string,
): string {
  const who = playerName(problem.playerId);
  switch (problem.kind) {
    case "NOT_ATTENDING":
      return `${who} is not a confirmed player for this mixin.`;
    case "REPEATED_IN_MATCH":
      return `${who} is down twice on court ${problem.courtNumber}.`;
    case "DOUBLE_BOOKED":
      return `${who} is on courts ${problem.courtNumbers.join(" and ")} at the same time.`;
    case "NOT_ARRIVED":
      return `${who} cannot play at ${formatTime(problem.startMinutes)} — they said they can only start at ${formatTime(problem.earliestStartMinutes)}.`;
    case "TOO_MANY_GAMES":
      return `${who} is down for ${problem.scheduled} games but only signed up for ${problem.requested}.`;
  }
}

/** True when two matches put a different set of people on the same court. */
export function lineupChanged(before: Match, after: Match): boolean {
  const seats = (match: Match) => [...match.teamA, ...match.teamB];
  const a = seats(before);
  const b = seats(after);
  return a.length !== b.length || a.some((id, index) => id !== b[index]);
}

/** How many games each confirmed player is currently down for. */
export function gamesScheduled(matches: Match[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of matches) {
    for (const playerId of [...match.teamA, ...match.teamB]) {
      counts.set(playerId, (counts.get(playerId) ?? 0) + 1);
    }
  }
  return counts;
}

/** Guard for a form: exactly four seats, all filled. */
export function isCompleteFour(seats: string[]): seats is [string, string, string, string] {
  return seats.length === PLAYERS_PER_COURT && seats.every((id) => id.length > 0);
}
