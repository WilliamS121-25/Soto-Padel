import { parseTime } from "@/domain/time";
import type { CourtBooking, Player, Session, Signup } from "@/domain/types";

export function court(courtNumber: number, start: string, slotCount: number): CourtBooking {
  return { courtNumber, startMinutes: parseTime(start), slotCount };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "Friday Mixin",
    date: "2025-08-29",
    startMinutes: parseTime("18:00"),
    slotCount: 4,
    courts: [court(1, "18:00", 4), court(2, "18:00", 4)],
    costPerCourtSlot: 600,
    currency: "EUR",
    status: "OPEN",
    createdAt: "2025-08-01T00:00:00.000Z",
    createdBy: "admin",
    ratingsAppliedAt: null,
    ...overrides,
  };
}

export function makePlayer(id: string, rating: number, name = id): Player {
  return {
    id,
    name,
    phone: null,
    rating,
    active: true,
    notes: null,
    createdAt: "2025-08-01T00:00:00.000Z",
  };
}

export function makeSignup(
  playerId: string,
  requestedSlots: number,
  start: string,
  queuePosition: number,
  overrides: Partial<Signup> = {},
): Signup {
  return {
    id: `sg-${playerId}`,
    sessionId: "s1",
    playerId,
    requestedSlots,
    earliestStartMinutes: parseTime(start),
    status: "CONFIRMED",
    queuePosition,
    paymentMethod: null,
    note: null,
    ...overrides,
  };
}

/** `count` players with ratings spread evenly over the classic scale. */
export function ladder(count: number, from = 2.5, to = 5.5): Player[] {
  return Array.from({ length: count }, (_, i) => {
    const rating = count === 1 ? from : from + ((to - from) * i) / (count - 1);
    return makePlayer(`p${i + 1}`, Number(rating.toFixed(2)));
  });
}

export function ratingMap(players: Player[]): Map<string, number> {
  return new Map(players.map((p) => [p.id, p.rating]));
}
