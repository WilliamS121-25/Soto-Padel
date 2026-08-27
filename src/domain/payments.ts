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
  /** The session's flat price per head, in minor units. */
  costPerPlayer: number;
  /** How many players are being charged. */
  payingPlayers: number;
  /** 30-minute blocks played across everyone. Context, not a divisor. */
  totalBlocksPlayed: number;
  lines: PaymentLine[];
  byMethod: Record<PaymentMethod, PaymentLine[]>;
  /** Players who have not told us how they are paying. */
  unassigned: PaymentLine[];
  /** Sum of all lines — `costPerPlayer * payingPlayers` by construction. */
  totalCollected: number;
}

/**
 * Charge every player who took the court the mixin's flat per-head price.
 *
 * The club charges per court, but the organiser announces one price per person
 * and that is what goes in the group, so the app works the same way: the number
 * of games somebody played does not change what they owe. It is still reported
 * on each line, because it is the first thing anyone checks when they think a
 * figure looks wrong.
 *
 * Someone confirmed who ended up in no match at all is not charged — they did
 * not play. That is the one thing games played still decides.
 */
export function buildPaymentSchedule(
  session: Session,
  signups: Signup[],
  blocksPlayedByPlayer: ReadonlyMap<string, number>,
): PaymentSchedule {
  const costPerPlayer = session.costPerPlayer;

  // Left in signup order, which is the order the confirmed list is already
  // shown in. With one price for everybody there is nothing to rank by.
  const lines: PaymentLine[] = signups
    .filter((s) => s.status === "CONFIRMED")
    .map((s) => ({
      playerId: s.playerId,
      method: s.paymentMethod,
      blocksPlayed: blocksPlayedByPlayer.get(s.playerId) ?? 0,
    }))
    .filter((p) => p.blocksPlayed > 0)
    .map((p) => ({ ...p, amount: costPerPlayer }));

  const byMethod = Object.fromEntries(
    PAYMENT_METHODS.map((method) => [method, lines.filter((l) => l.method === method)]),
  ) as Record<PaymentMethod, PaymentLine[]>;

  return {
    currency: session.currency,
    costPerPlayer,
    payingPlayers: lines.length,
    totalBlocksPlayed: lines.reduce((sum, l) => sum + l.blocksPlayed, 0),
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
