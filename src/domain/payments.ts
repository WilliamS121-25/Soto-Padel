import { computeCapacity } from "./timeline";
import {
  PAYMENT_METHODS,
  type PaymentMethod,
  type Session,
  type Signup,
} from "./types";

export interface PaymentLine {
  playerId: string;
  blocksPlayed: number;
  /** Amount owed in minor units (cents). */
  amount: number;
  method: PaymentMethod | null;
}

export interface PaymentSchedule {
  currency: string;
  /** What the club charges for the courts, in minor units. */
  totalCourtCost: number;
  totalCourtBlocks: number;
  totalBlocksPlayed: number;
  lines: PaymentLine[];
  byMethod: Record<PaymentMethod, PaymentLine[]>;
  /** Players who have not told us how they are paying. */
  unassigned: PaymentLine[];
  /** Sum of all lines — equal to `totalCourtCost` by construction. */
  totalCollected: number;
}

/**
 * Split the court hire cost across players in proportion to the number of
 * 30-minute blocks each actually played.
 *
 * The club charges for the courts it booked whether or not every seat was
 * filled, so the total is fixed and the split is proportional. Amounts are
 * integer minor units throughout, and the rounding remainder is handed to the
 * largest fractional shares so the lines always add up to the total exactly —
 * never a cent over or under what has to be paid at reception.
 */
export function buildPaymentSchedule(
  session: Session,
  signups: Signup[],
  blocksPlayedByPlayer: ReadonlyMap<string, number>,
): PaymentSchedule {
  const { totalCourtBlocks } = computeCapacity(session);
  const totalCourtCost = totalCourtBlocks * session.costPerCourtSlot;

  const participants = signups
    .filter((s) => s.status === "CONFIRMED")
    .map((s) => ({
      playerId: s.playerId,
      method: s.paymentMethod,
      blocksPlayed: blocksPlayedByPlayer.get(s.playerId) ?? 0,
    }))
    .filter((p) => p.blocksPlayed > 0);

  const totalBlocksPlayed = participants.reduce((sum, p) => sum + p.blocksPlayed, 0);

  let lines: PaymentLine[];
  if (totalBlocksPlayed === 0 || totalCourtCost === 0) {
    lines = participants.map((p) => ({ ...p, amount: 0 }));
  } else {
    const exact = participants.map((p) => ({
      ...p,
      raw: (totalCourtCost * p.blocksPlayed) / totalBlocksPlayed,
    }));
    const floored = exact.map((p) => ({ ...p, amount: Math.floor(p.raw) }));
    let remainder = totalCourtCost - floored.reduce((sum, p) => sum + p.amount, 0);

    // Hand out the leftover cents to the biggest fractional parts first.
    const order = [...floored].sort(
      (a, b) => b.raw - Math.floor(b.raw) - (a.raw - Math.floor(a.raw)) ||
        a.playerId.localeCompare(b.playerId),
    );
    for (const entry of order) {
      if (remainder <= 0) break;
      entry.amount += 1;
      remainder -= 1;
    }

    lines = floored.map(({ playerId, blocksPlayed, amount, method }) => ({
      playerId,
      blocksPlayed,
      amount,
      method,
    }));
  }

  lines.sort((a, b) => b.amount - a.amount || a.playerId.localeCompare(b.playerId));

  const byMethod = Object.fromEntries(
    PAYMENT_METHODS.map((method) => [method, lines.filter((l) => l.method === method)]),
  ) as Record<PaymentMethod, PaymentLine[]>;

  return {
    currency: session.currency,
    totalCourtCost,
    totalCourtBlocks,
    totalBlocksPlayed,
    lines,
    byMethod,
    unassigned: lines.filter((l) => l.method === null),
    totalCollected: lines.reduce((sum, l) => sum + l.amount, 0),
  };
}

/** Blocks played per player, derived from a generated schedule. */
export function blocksPlayedFromMatches(
  matches: { teamA: readonly [string, string]; teamB: readonly [string, string] }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of matches) {
    for (const id of [...match.teamA, ...match.teamB]) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Format minor units as a currency string, e.g. 1250 -> "12.50". */
export function formatMoney(minorUnits: number): string {
  const sign = minorUnits < 0 ? "-" : "";
  const abs = Math.abs(minorUnits);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Parse a user-entered amount like "12.50" or "12,50" into minor units. */
export function parseMoney(value: string): number {
  const cleaned = value.trim().replace(/[^\d.,-]/g, "").replace(",", ".");
  if (cleaned === "" || cleaned === "-") throw new Error(`Invalid amount "${value}"`);
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) throw new Error(`Invalid amount "${value}"`);
  return Math.round(amount * 100);
}
