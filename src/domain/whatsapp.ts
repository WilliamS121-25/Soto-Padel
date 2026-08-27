import { buildPaymentSchedule, formatMoney, type PaymentSchedule } from "./payments";
import { formatDateLong, formatSlotCount, formatSlotRange, formatTime } from "./time";
import { computeCapacity, type Capacity } from "./timeline";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type Round,
  type Session,
  type Signup,
} from "./types";

/**
 * These builders produce plain text meant to be copied straight into the
 * WhatsApp group. WhatsApp renders `*text*` as bold. Nothing here talks to
 * WhatsApp itself — the app never needs the WhatsApp Business API, the admin
 * copies and pastes.
 */

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", GBP: "£", USD: "$" };

export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code.toUpperCase()] ?? `${code} `;
}

export type PlayerNameLookup = (playerId: string) => string;

function money(amount: number, currency: string): string {
  return `${currencySymbol(currency)}${formatMoney(amount)}`;
}

function courtLines(session: Session): string[] {
  return [...session.courts]
    .sort((a, b) => a.courtNumber - b.courtNumber || a.startMinutes - b.startMinutes)
    .map(
      (court) =>
        `• Court ${court.courtNumber} — ${formatSlotRange(court.startMinutes, court.slotCount)} (${formatSlotCount(court.slotCount)})`,
    );
}

function header(session: Session): string[] {
  return [
    `\u{1F3BE} *${session.name}*`,
    `\u{1F4C5} ${formatDateLong(session.date)}`,
    `\u{1F551} From ${formatTime(session.startMinutes)}`,
  ];
}

/** Opening message: what is booked and how to sign up. */
export function signupOpenMessage(session: Session): string {
  const capacity = computeCapacity(session);
  return [
    ...header(session),
    "",
    "*Courts booked*",
    ...courtLines(session),
    "",
    `*Places:* ${capacity.totalPlayerBlocks} x 30-minute game slots`,
    "",
    "To sign up, reply with:",
    "Name — number of 30-min games — your start time",
    `for example: Ana — 3 — ${formatTime(session.startMinutes)}`,
  ].join("\n");
}

export interface AvailabilityInput {
  session: Session;
  confirmed: Signup[];
  reserves: Signup[];
  capacity: Capacity;
  playerName: PlayerNameLookup;
}

/** Running update: who is in, who is waiting, how much space is left. */
export function availabilityMessage(input: AvailabilityInput): string {
  const { session, confirmed, reserves, capacity, playerName } = input;

  const describe = (signup: Signup, index: number) =>
    `${index + 1}. ${playerName(signup.playerId)} — ${signup.requestedSlots} x 30min, from ${formatTime(signup.earliestStartMinutes)}`;

  const lines = [
    ...header(session),
    "",
    `✅ *Confirmed (${confirmed.length})*`,
    ...(confirmed.length > 0 ? confirmed.map(describe) : ["(nobody yet)"]),
  ];

  if (reserves.length > 0) {
    lines.push("", `⏳ *Reserves (${reserves.length})* — in order`, ...reserves.map(describe));
  }

  lines.push("");
  if (capacity.remainingPlayerBlocks > 0) {
    lines.push(
      `*Still available:* ${capacity.remainingPlayerBlocks} x 30-minute game slots`,
      "Reply to claim a place.",
    );
  } else {
    lines.push("*The mixin is full.* Reply to go on the reserve list — places often free up.");
  }

  return lines.join("\n");
}

export interface ScheduleMessageInput {
  session: Session;
  rounds: Round[];
  playerName: PlayerNameLookup;
  /** Include the "sitting out" line for each round. Default true. */
  showSittingOut?: boolean;
}

/** The running order, round by round. */
export function scheduleMessage(input: ScheduleMessageInput): string {
  const { session, rounds, playerName, showSittingOut = true } = input;
  const lines = [`\u{1F3BE} *Line-ups — ${session.name}*`, `\u{1F4C5} ${formatDateLong(session.date)}`];

  for (const round of rounds) {
    if (round.matches.length === 0 && round.sittingOut.length === 0) continue;
    lines.push("", `*${formatSlotRange(round.startMinutes)}*`);
    for (const match of round.matches) {
      const teamA = match.teamA.map(playerName).join(" & ");
      const teamB = match.teamB.map(playerName).join(" & ");
      lines.push(`Court ${match.courtNumber}: ${teamA}  vs  ${teamB}`);
    }
    if (showSittingOut && round.sittingOut.length > 0) {
      lines.push(`_Sitting out: ${round.sittingOut.map(playerName).join(", ")}_`);
    }
  }

  return lines.join("\n");
}

export interface PaymentMessageInput {
  session: Session;
  schedule: PaymentSchedule;
  playerName: PlayerNameLookup;
}

/** Payment schedule, grouped by how each person is paying. */
export function paymentMessage(input: PaymentMessageInput): string {
  const { session, schedule, playerName } = input;
  const lines = [
    `\u{1F4B3} *Payment — ${session.name}*`,
    `\u{1F4C5} ${formatDateLong(session.date)}`,
    "",
    `${money(schedule.costPerPlayer, schedule.currency)} per person`,
    `${schedule.payingPlayers} ${schedule.payingPlayers === 1 ? "player" : "players"} playing`,
  ];

  for (const method of PAYMENT_METHODS) {
    const group = schedule.byMethod[method];
    if (group.length === 0) continue;
    const subtotal = group.reduce((sum, line) => sum + line.amount, 0);
    lines.push("", `*${PAYMENT_METHOD_LABELS[method]}*`);
    for (const line of group) {
      lines.push(
        `• ${playerName(line.playerId)} — ${money(line.amount, schedule.currency)} (${line.blocksPlayed} x 30min)`,
      );
    }
    lines.push(`_Subtotal: ${money(subtotal, schedule.currency)}_`);
  }

  if (schedule.unassigned.length > 0) {
    lines.push("", "*Payment method not chosen yet*");
    for (const line of schedule.unassigned) {
      lines.push(
        `• ${playerName(line.playerId)} — ${money(line.amount, schedule.currency)} (${line.blocksPlayed} x 30min)`,
      );
    }
    lines.push("_Please reply with Reception, Revolut or Playtomic._");
  }

  lines.push("", `*Total: ${money(schedule.totalCollected, schedule.currency)}*`);
  return lines.join("\n");
}

/** Convenience wrapper when you have matches rather than a prepared schedule. */
export function paymentMessageFromMatches(
  session: Session,
  signups: Signup[],
  blocksPlayed: ReadonlyMap<string, number>,
  playerName: PlayerNameLookup,
): string {
  const schedule = buildPaymentSchedule(session, signups, blocksPlayed);
  return paymentMessage({ session, schedule, playerName });
}
