/** Core domain types for running a social padel mixin. */

export const PLAYERS_PER_COURT = 4;

/** The club has 5 physical courts. */
export const FACILITY_COURTS = [1, 2, 3, 4, 5] as const;

/**
 * Padel rating scale. Defaults to the widely used 1.0-7.0 level scale in 0.25
 * steps. It is configurable because clubs differ — see `RATING_SCALE_PRESETS`.
 */
export interface RatingScale {
  min: number;
  max: number;
  step: number;
}

export const DEFAULT_RATING_SCALE: RatingScale = { min: 1, max: 7, step: 0.25 };

export const RATING_SCALE_PRESETS: Record<string, RatingScale> = {
  /** Classic 1.0-7.0 padel level scale in quarter steps. */
  classic: { min: 1, max: 7, step: 0.25 },
  /** Playtomic-style 0.0-7.0 in tenths. */
  playtomic: { min: 0, max: 7, step: 0.1 },
  /** Simple 1-10 club ladder. */
  tenPoint: { min: 1, max: 10, step: 0.5 },
};

export interface Player {
  id: string;
  name: string;
  /** Optional phone / WhatsApp handle, used only to identify people. */
  phone: string | null;
  rating: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
}

export interface RatingChange {
  id: string;
  playerId: string;
  previousRating: number | null;
  newRating: number;
  changedAt: string;
  changedBy: string;
  reason: string | null;
}

/**
 * A court held for part of the session. `startMinutes` is deliberately
 * independent of the session start: courts are often booked in staggered
 * blocks, so court 3 may start at 19:00 while the mixin starts at 18:00.
 */
export interface CourtBooking {
  courtNumber: number;
  startMinutes: number;
  /** Number of consecutive 30-minute blocks this court is held for. */
  slotCount: number;
}

export type SessionStatus = "OPEN" | "CLOSED" | "SCHEDULED" | "COMPLETE";

export interface Session {
  id: string;
  name: string;
  /** Club-local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Advertised start time of the mixin. */
  startMinutes: number;
  /** Advertised length of the mixin, in 30-minute blocks. */
  slotCount: number;
  courts: CourtBooking[];
  /** Court hire cost per court per 30-minute block, in minor units (cents). */
  costPerCourtSlot: number;
  currency: string;
  status: SessionStatus;
  createdAt: string;
  createdBy: string;
}

export type SignupStatus = "CONFIRMED" | "RESERVE" | "WITHDRAWN";

export const PAYMENT_METHODS = ["RECEPTION", "REVOLUT", "PLAYTOMIC"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  RECEPTION: "Reception",
  REVOLUT: "Revolut",
  PLAYTOMIC: "Playtomic",
};

export interface Signup {
  id: string;
  sessionId: string;
  playerId: string;
  /** How many 30-minute games the player asked for. */
  requestedSlots: number;
  /** Earliest the player can start, as minutes from midnight. */
  earliestStartMinutes: number;
  status: SignupStatus;
  /** Order the player signed up in; drives the reserve sequence. */
  queuePosition: number;
  paymentMethod: PaymentMethod | null;
  note: string | null;
}

/** One court's game in one 30-minute block. */
export interface Match {
  slotIndex: number;
  courtNumber: number;
  teamA: readonly [string, string];
  teamB: readonly [string, string];
}

export interface Round {
  slotIndex: number;
  startMinutes: number;
  matches: Match[];
  /** Confirmed players available in this block who did not get a court. */
  sittingOut: string[];
}

export interface TimelineSlot {
  slotIndex: number;
  startMinutes: number;
  /** Courts running during this block. */
  courts: CourtBooking[];
}
