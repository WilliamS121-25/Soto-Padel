import { describe, expect, it } from "vitest";
import {
  blocksPlayedFromMatches,
  buildPaymentSchedule,
  formatMoney,
  parseMoney,
} from "@/domain/payments";
import { court, makeSession, makeSignup } from "./fixtures";

describe("money formatting", () => {
  it("renders minor units", () => {
    expect(formatMoney(1250)).toBe("12.50");
    expect(formatMoney(600)).toBe("6.00");
    expect(formatMoney(5)).toBe("0.05");
    expect(formatMoney(-250)).toBe("-2.50");
  });

  it("parses what a person would type", () => {
    expect(parseMoney("12.50")).toBe(1250);
    expect(parseMoney("12,50")).toBe(1250);
    expect(parseMoney("€6")).toBe(600);
    expect(parseMoney(" 7.05 ")).toBe(705);
    expect(() => parseMoney("abc")).toThrow();
  });
});

describe("payment schedule", () => {
  // 2 courts x 4 blocks at 6.00 per court-block = 48.00 of court hire.
  const session = makeSession({
    courts: [court(1, "18:00", 4), court(2, "18:00", 4)],
    costPerCourtSlot: 600,
  });

  it("splits the court cost by games played", () => {
    const signups = ["p1", "p2", "p3", "p4"].map((id, i) => makeSignup(id, 4, "18:00", i + 1));
    const blocks = new Map(signups.map((s) => [s.playerId, 4]));
    const schedule = buildPaymentSchedule(session, signups, blocks);

    expect(schedule.totalCourtCost).toBe(4800);
    expect(schedule.totalBlocksPlayed).toBe(16);
    for (const line of schedule.lines) expect(line.amount).toBe(1200);
    expect(schedule.totalCollected).toBe(4800);
  });

  it("charges someone who played half as much half as much", () => {
    const signups = [
      makeSignup("p1", 4, "18:00", 1),
      makeSignup("p2", 2, "18:00", 2),
    ];
    const blocks = new Map([
      ["p1", 4],
      ["p2", 2],
    ]);
    const schedule = buildPaymentSchedule(session, signups, blocks);
    const byPlayer = new Map(schedule.lines.map((l) => [l.playerId, l.amount]));
    expect(byPlayer.get("p1")).toBe(3200);
    expect(byPlayer.get("p2")).toBe(1600);
    expect(schedule.totalCollected).toBe(4800);
  });

  it("never loses or invents a cent when the split does not divide", () => {
    // 10.00 across three players is 3.333... each.
    const oddSession = makeSession({ courts: [court(1, "18:00", 2)], costPerCourtSlot: 500 });
    const signups = ["p1", "p2", "p3"].map((id, i) => makeSignup(id, 1, "18:00", i + 1));
    const blocks = new Map(signups.map((s) => [s.playerId, 1]));
    const schedule = buildPaymentSchedule(oddSession, signups, blocks);

    expect(schedule.totalCourtCost).toBe(1000);
    expect(schedule.lines.map((l) => l.amount)).toEqual([334, 333, 333]);
    expect(schedule.totalCollected).toBe(1000);
  });

  it("groups by payment method and flags who has not chosen", () => {
    const signups = [
      makeSignup("p1", 4, "18:00", 1, { paymentMethod: "RECEPTION" }),
      makeSignup("p2", 4, "18:00", 2, { paymentMethod: "REVOLUT" }),
      makeSignup("p3", 4, "18:00", 3, { paymentMethod: "PLAYTOMIC" }),
      makeSignup("p4", 4, "18:00", 4),
    ];
    const blocks = new Map(signups.map((s) => [s.playerId, 4]));
    const schedule = buildPaymentSchedule(session, signups, blocks);

    expect(schedule.byMethod.RECEPTION.map((l) => l.playerId)).toEqual(["p1"]);
    expect(schedule.byMethod.REVOLUT.map((l) => l.playerId)).toEqual(["p2"]);
    expect(schedule.byMethod.PLAYTOMIC.map((l) => l.playerId)).toEqual(["p3"]);
    expect(schedule.unassigned.map((l) => l.playerId)).toEqual(["p4"]);
  });

  it("leaves out players who did not actually play", () => {
    const signups = [
      makeSignup("played", 2, "18:00", 1),
      makeSignup("noshow", 2, "18:00", 2),
    ];
    const schedule = buildPaymentSchedule(session, signups, new Map([["played", 2]]));
    expect(schedule.lines.map((l) => l.playerId)).toEqual(["played"]);
    expect(schedule.lines[0]?.amount).toBe(4800);
  });

  it("ignores reserves who never got a place", () => {
    const signups = [
      makeSignup("in", 4, "18:00", 1),
      makeSignup("waiting", 4, "18:00", 2, { status: "RESERVE" }),
    ];
    const blocks = new Map([
      ["in", 4],
      ["waiting", 4],
    ]);
    const schedule = buildPaymentSchedule(session, signups, blocks);
    expect(schedule.lines.map((l) => l.playerId)).toEqual(["in"]);
  });

  it("counts blocks played straight off the matches", () => {
    const counts = blocksPlayedFromMatches([
      { teamA: ["a", "b"], teamB: ["c", "d"] },
      { teamA: ["a", "c"], teamB: ["b", "d"] },
    ]);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("d")).toBe(2);
  });
});
