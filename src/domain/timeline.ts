import { SLOT_MINUTES } from "./time";
import { PLAYERS_PER_COURT, type CourtBooking, type Session, type TimelineSlot } from "./types";

/**
 * Build the 30-minute grid for a session.
 *
 * The grid spans from the earliest of (advertised session start, earliest court
 * start) to the latest of (advertised session end, latest court end), so a court
 * booked outside the advertised window is still scheduled rather than silently
 * dropped. Slots with no active court are omitted from the returned list only if
 * `includeEmpty` is false.
 */
export function buildTimeline(session: Session, includeEmpty = false): TimelineSlot[] {
  const courtStarts = session.courts.map((c) => c.startMinutes);
  const courtEnds = session.courts.map((c) => c.startMinutes + c.slotCount * SLOT_MINUTES);

  const start = Math.min(session.startMinutes, ...courtStarts);
  const end = Math.max(session.startMinutes + session.slotCount * SLOT_MINUTES, ...courtEnds);

  const slots: TimelineSlot[] = [];
  let slotIndex = 0;
  for (let t = start; t < end; t += SLOT_MINUTES) {
    const courts = session.courts
      .filter((c) => t >= c.startMinutes && t < c.startMinutes + c.slotCount * SLOT_MINUTES)
      .sort((a, b) => a.courtNumber - b.courtNumber);
    if (courts.length > 0 || includeEmpty) {
      slots.push({ slotIndex, startMinutes: t, courts });
    }
    slotIndex += 1;
  }
  return slots;
}

/** Courts active during a given absolute time. */
export function courtsAt(session: Session, minutes: number): CourtBooking[] {
  return session.courts.filter(
    (c) => minutes >= c.startMinutes && minutes < c.startMinutes + c.slotCount * SLOT_MINUTES,
  );
}

/** When the last booked court finishes. */
export function sessionEndMinutes(session: Session): number {
  if (session.courts.length === 0) return session.startMinutes + session.slotCount * SLOT_MINUTES;
  return Math.max(...session.courts.map((c) => c.startMinutes + c.slotCount * SLOT_MINUTES));
}

export interface Capacity {
  /**
   * Total player-blocks on offer: every court, for every 30-minute block it is
   * held, seats 4 players. This is the real currency of a mixin — one player
   * asking for four 30-minute games consumes four player-blocks.
   */
  totalPlayerBlocks: number;
  /** Player-blocks committed to confirmed signups. */
  committedPlayerBlocks: number;
  /** Player-blocks still unsold. */
  remainingPlayerBlocks: number;
  /** Court-blocks booked (courts x blocks), used for costing. */
  totalCourtBlocks: number;
  perSlot: { slotIndex: number; startMinutes: number; seats: number }[];
}

export function computeCapacity(
  session: Session,
  committedPlayerBlocks = 0,
): Capacity {
  const timeline = buildTimeline(session);
  const perSlot = timeline.map((slot) => ({
    slotIndex: slot.slotIndex,
    startMinutes: slot.startMinutes,
    seats: slot.courts.length * PLAYERS_PER_COURT,
  }));
  const totalCourtBlocks = session.courts.reduce((sum, c) => sum + c.slotCount, 0);
  const totalPlayerBlocks = totalCourtBlocks * PLAYERS_PER_COURT;
  return {
    totalPlayerBlocks,
    committedPlayerBlocks,
    remainingPlayerBlocks: Math.max(0, totalPlayerBlocks - committedPlayerBlocks),
    totalCourtBlocks,
    perSlot,
  };
}

/**
 * How many 30-minute blocks a player could actually play, given the courts on
 * offer and the earliest time they can arrive. Used to detect signups that can
 * never be satisfied (e.g. arriving after the last court finishes) and to cap
 * over-optimistic requests.
 */
export function playableBlocksFrom(session: Session, earliestStartMinutes: number): number {
  return buildTimeline(session).filter(
    (slot) => slot.startMinutes >= earliestStartMinutes && slot.courts.length > 0,
  ).length;
}
