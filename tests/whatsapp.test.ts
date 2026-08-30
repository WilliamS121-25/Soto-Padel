import { describe, expect, it } from "vitest";
import { buildPaymentSchedule } from "@/domain/payments";
import { generateSchedule } from "@/domain/scheduler";
import { allocateSignups } from "@/domain/signups";
import { computeCapacity } from "@/domain/timeline";
import {
  availabilityMessage,
  paymentMessage,
  playerListMessage,
  scheduleMessage,
  signupOpenMessage,
  teamTotal,
} from "@/domain/whatsapp";
import { court, ladder, makePlayer, makeSession, makeSignup, ratingMap } from "./fixtures";

const players = ladder(9, 3, 5);
const nameOf = (id: string) => players.find((p) => p.id === id)?.name ?? id;

const session = makeSession({
  name: "Soto Padel Friday Mixin",
  date: "2025-08-29",
  slotCount: 4,
  courts: [court(1, "18:00", 4), court(3, "19:00", 3)],
  costPerPlayer: 1000,
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
    // Four players at the flat 10.00 a head.
    expect(text).toContain("€10.00 per person");
    expect(text).toContain("4 players playing");
    expect(text).toContain("Subtotal");
  });

  it("still shows how many games each person played", () => {
    expect(text).toContain("(4 x 30min)");
  });

  it("chases anyone who has not picked a method", () => {
    expect(text).toContain("Payment method not chosen yet");
    expect(text).toContain("Reception, Revolut or Playtomic");
  });

  it("ends with the total to be collected", () => {
    expect(text).toContain("*Total: €40.00*");
    expect(schedule.totalCollected).toBe(schedule.costPerPlayer * schedule.payingPlayers);
  });
});

describe("team totals in the line-ups", () => {
  const players = ladder(8, 3.0, 5.0);
  const session = makeSession({
    slotCount: 2,
    courts: [court(1, "18:00", 2), court(2, "18:00", 2)],
  });
  const signups = players.map((p, i) => makeSignup(p.id, 2, "18:00", i + 1));
  const ratings = ratingMap(players);
  const result = generateSchedule({ session, signups, ratings });

  it("adds the two ratings, not averages them", () => {
    expect(teamTotal(["p1", "p2"], new Map([["p1", 3.5], ["p2", 4.25]]))).toBe(7.75);
  });

  it("treats an unknown player as zero rather than NaN", () => {
    expect(teamTotal(["p1", "ghost"], new Map([["p1", 3.5]]))).toBe(3.5);
  });

  it("prints a total beside each pair when ratings are given", () => {
    const text = scheduleMessage({
      session,
      rounds: result.rounds,
      playerName: (id) => id,
      ratings,
    });
    // Every court line carries two totals, one per pair.
    for (const line of text.split("\n").filter((l) => l.startsWith("Court "))) {
      expect(line.match(/\(\d+\.\d\d\)/g)).toHaveLength(2);
    }
  });

  it("leaves the names bare when no ratings are given", () => {
    const text = scheduleMessage({ session, rounds: result.rounds, playerName: (id) => id });
    expect(text).not.toMatch(/\(\d+\.\d\d\)/);
  });

  it("shows the two sides of a court as near-equal totals", () => {
    const text = scheduleMessage({
      session,
      rounds: result.rounds,
      playerName: (id) => id,
      ratings,
    });
    for (const line of text.split("\n").filter((l) => l.startsWith("Court "))) {
      const totals = [...line.matchAll(/\((\d+\.\d\d)\)/g)].map((m) => Number(m[1]));
      expect(Math.abs((totals[0] ?? 0) - (totals[1] ?? 0))).toBeLessThan(1);
    }
  });
});

describe("the player list for the group", () => {
  const players = [
    makePlayer("p1", 4.5, "Bruno", { gender: "MALE" }),
    makePlayer("p2", 3.0, "Ana", { gender: "FEMALE", similarLevelOnly: true }),
    makePlayer("p3", 4.5, "Alba"),
    makePlayer("p4", 5.5, "Javi", { active: false }),
  ];

  it("lists strongest first, and breaks a tie by name", () => {
    const lines = playerListMessage({ players }).split("\n").filter((l) => l.startsWith("•"));
    expect(lines[0]).toContain("Javi");
    expect(lines[1]).toContain("Alba");
    expect(lines[2]).toContain("Bruno");
    expect(lines[3]).toContain("Ana");
  });

  it("shows each rating so people can check their own", () => {
    expect(playerListMessage({ players })).toContain("• Bruno — 4.50");
  });

  it("can leave the ratings out", () => {
    const text = playerListMessage({ players, showRatings: false });
    expect(text).toContain("• Bruno");
    expect(text).not.toContain("4.50");
  });

  it("tags what is worth knowing and nothing else", () => {
    const text = playerListMessage({ players });
    expect(text).toContain("• Ana — 3.00 [Female, own level only]");
    expect(text).toContain("• Javi — 5.50 [inactive]");
    // Alba has nothing recorded, so she gets no brackets at all.
    expect(text).toContain("• Alba — 4.50\n");
  });

  it("counts the players in the heading", () => {
    expect(playerListMessage({ players })).toContain("*Players (4)*");
  });

  it("says so when there is nobody yet", () => {
    expect(playerListMessage({ players: [] })).toContain("No players yet");
  });
});
