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
  // The price is per head for the whole mixin, so the courts booked and the
  // games played do not enter into what anybody owes.
  const session = makeSession({
    courts: [court(1, "18:00", 4), court(2, "18:00", 4)],
    costPerPlayer: 1000,
  });

  it("charges every player the same flat price", () => {
    const signups = ["p1", "p2", "p3", "p4"].map((id, i) => makeSignup(id, 4, "18:00", i + 1));
    const blocks = new Map(signups.map((s) => [s.playerId, 4]));
    const schedule = buildPaymentSchedule(session, signups, blocks);

    expect(schedule.costPerPlayer).toBe(1000);
    expect(schedule.payingPlayers).toBe(4);
    for (const line of schedule.lines) expect(line.amount).toBe(1000);
    expect(schedule.totalCollected).toBe(4000);
  });

  it("charges someone who played half as many games the same", () => {
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
    expect(byPlayer.get("p1")).toBe(1000);
    expect(byPlayer.get("p2")).toBe(1000);
    expect(schedule.totalCollected).toBe(2000);
  });

  it("still reports the games played, since that is what people query", () => {
    const signups = [makeSignup("p1", 4, "18:00", 1), makeSignup("p2", 2, "18:00", 2)];
    const schedule = buildPaymentSchedule(
      session,
      signups,
      new Map([
        ["p1", 4],
        ["p2", 2],
      ]),
    );
    expect(schedule.lines.map((l) => l.blocksPlayed)).toEqual([4, 2]);
    expect(schedule.totalBlocksPlayed).toBe(6);
  });

  it("adds up exactly, whatever the price and however many are playing", () => {
    for (const price of [0, 1, 333, 999, 1050, 123_45]) {
      for (const count of [1, 3, 7, 12, 23]) {
        const priced = makeSession({
          courts: [court(1, "18:00", 4)],
          costPerPlayer: price,
        });
        const signups = Array.from({ length: count }, (_, i) =>
          makeSignup(`p${i}`, 2, "18:00", i + 1),
        );
        const blocks = new Map(signups.map((sign) => [sign.playerId, 2]));
        const schedule = buildPaymentSchedule(priced, signups, blocks);
        // No division, so no rounding remainder to lose: the total is the price
        // times the heads, and every line is identical.
        expect(schedule.totalCollected).toBe(price * count);
        expect(new Set(schedule.lines.map((l) => l.amount))).toEqual(new Set([price]));
      }
    }
  });

  it("charges nothing when no price has been set", () => {
    const free = makeSession({ courts: [court(1, "18:00", 2)], costPerPlayer: 0 });
    const signups = ["p1", "p2"].map((id, i) => makeSignup(id, 1, "18:00", i + 1));
    const schedule = buildPaymentSchedule(free, signups, new Map(signups.map((x) => [x.playerId, 1])));
    expect(schedule.lines.map((l) => l.amount)).toEqual([0, 0]);
    expect(schedule.totalCollected).toBe(0);
  });

  it("keeps the lines in signup order", () => {
    const signups = ["third", "first", "second"].map((id, i) =>
      makeSignup(id, 4, "18:00", i + 1),
    );
    const blocks = new Map(signups.map((x) => [x.playerId, 4]));
    const schedule = buildPaymentSchedule(session, signups, blocks);
    expect(schedule.lines.map((l) => l.playerId)).toEqual(["third", "first", "second"]);
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
    expect(schedule.lines[0]?.amount).toBe(1000);
    expect(schedule.payingPlayers).toBe(1);
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
