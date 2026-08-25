import { describe, expect, it } from "vitest";
import { buildPaymentSchedule } from "@/domain/payments";
import { generateSchedule } from "@/domain/scheduler";
import { allocateSignups } from "@/domain/signups";
import { computeCapacity } from "@/domain/timeline";
import {
  availabilityMessage,
  paymentMessage,
  scheduleMessage,
  signupOpenMessage,
} from "@/domain/whatsapp";
import { court, ladder, makeSession, makeSignup, ratingMap } from "./fixtures";

const players = ladder(9, 3, 5);
const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? id;

const session = makeSession({
  name: "Soto Padel Friday Mixin",
  date: "2025-08-29",
  slotCount: 4,
  courts: [court(1, "18:00", 4), court(3, "19:00", 3)],
  costPerCourtSlot: 600,
});

describe("signup message", () => {
  const text = signupOpenMessage(session);

  it("states the date, the courts and their real start times", () => {
    expect(text).toContain("Soto Padel Friday Mixin");
    expect(text).toContain("Friday 29 Aug 2025");
    expect(text).toContain("Court 1 — 18:00-20:00");
    expect(text).toContain("Court 3 — 19:00-20:30");
  });

  it("advertises the number of places in 30-minute slots", () => {
    // 7 court-blocks x 4 seats.
    expect(text).toContain("28 x 30-minute game slots");
  });

  it("tells people what to reply", () => {
    expect(text).toContain("number of 30-min games");
  });
});

describe("availability message", () => {
  const signups = [
    ...players.slice(0, 7).map((p, i) => makeSignup(p.id, 4, "18:00", i + 1)),
    makeSignup("p8", 2, "18:00", 8),
    makeSignup("p9", 3, "18:00", 9),
  ];
  const allocation = allocateSignups(session, signups);
  const text = availabilityMessage({
    session,
    confirmed: allocation.confirmed,
    reserves: allocation.reserves,
    capacity: computeCapacity(session, allocation.committedPlayerBlocks),
    playerName: nameOf,
  });

  it("lists the confirmed players with their games and start time", () => {
    expect(text).toContain(`✅ *Confirmed (${allocation.confirmed.length})*`);
    expect(text).toMatch(/1\. p1 — 4 x 30min, from 18:00/);
  });

  it("lists reserves in queue order when the mixin is full", () => {
    expect(allocation.reserves.length).toBeGreaterThan(0);
    expect(text).toContain("Reserves");
    expect(text).toContain("in order");
  });

  it("says how much space is left", () => {
    expect(text).toMatch(/Still available:|The mixin is full/);
  });

  it("reports being full rather than offering negative space", () => {
    const full = availabilityMessage({
      session,
      confirmed: allocation.confirmed,
      reserves: [],
      capacity: computeCapacity(session, 999),
      playerName: nameOf,
    });
    expect(full).toContain("The mixin is full");
    expect(full).not.toMatch(/-\d+ x 30-minute/);
  });
});

describe("schedule message", () => {
  const signups = players.slice(0, 8).map((p, i) => makeSignup(p.id, 2, "18:00", i + 1));
  const result = generateSchedule({ session, signups, ratings: ratingMap(players) });
  const text = scheduleMessage({ session, rounds: result.rounds, playerName: nameOf });

  it("shows each block with its courts and teams", () => {
    expect(text).toContain("*18:00-18:30*");
    expect(text).toMatch(/Court 1: \w+ & \w+ {2}vs {2}\w+ & \w+/);
  });

  it("only lists a court in the blocks it is actually booked", () => {
    const firstBlock = text.split("*18:30-19:00*")[0] ?? "";
    expect(firstBlock).not.toContain("Court 3");
    expect(text).toContain("Court 3");
  });

  it("can hide the sitting-out line", () => {
    const hidden = scheduleMessage({
      session,
      rounds: result.rounds,
      playerName: nameOf,
      showSittingOut: false,
    });
    expect(hidden).not.toContain("Sitting out");
  });
});

describe("payment message", () => {
  const signups = [
    makeSignup("p1", 4, "18:00", 1, { paymentMethod: "RECEPTION" }),
    makeSignup("p2", 4, "18:00", 2, { paymentMethod: "REVOLUT" }),
    makeSignup("p3", 4, "18:00", 3, { paymentMethod: "PLAYTOMIC" }),
    makeSignup("p4", 4, "18:00", 4),
  ];
  const blocks = new Map(signups.map((s) => [s.playerId, 4]));
  const schedule = buildPaymentSchedule(session, signups, blocks);
  const text = paymentMessage({ session, schedule, playerName: nameOf });

  it("groups players under each payment method", () => {
    expect(text).toContain("*Reception*");
    expect(text).toContain("*Revolut*");
    expect(text).toContain("*Playtomic*");
  });

  it("shows amounts in euros with a subtotal per method", () => {
    // 7 court-blocks x 6.00 = 42.00, split four ways.
    expect(text).toContain("€42.00");
    expect(text).toContain("€10.50");
    expect(text).toContain("Subtotal");
  });

  it("chases anyone who has not picked a method", () => {
    expect(text).toContain("Payment method not chosen yet");
    expect(text).toContain("Reception, Revolut or Playtomic");
  });

  it("ends with a total that matches the court cost", () => {
    expect(text).toContain("*Total: €42.00*");
    expect(schedule.totalCollected).toBe(schedule.totalCourtCost);
  });
});
