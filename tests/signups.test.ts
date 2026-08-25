import { describe, expect, it } from "vitest";
import { allocateSignups, withdrawAndPromote } from "@/domain/signups";
import { court, makeSession, makeSignup } from "./fixtures";

// One court for four half-hours = 16 player-blocks, which makes the
// arithmetic in these tests easy to follow.
const oneCourt = makeSession({ courts: [court(1, "18:00", 4)], slotCount: 4 });

describe("place allocation", () => {
  it("confirms players in signup order until the blocks run out", () => {
    const signups = [
      makeSignup("p1", 4, "18:00", 1),
      makeSignup("p2", 4, "18:00", 2),
      makeSignup("p3", 4, "18:00", 3),
      makeSignup("p4", 4, "18:00", 4),
      makeSignup("p5", 4, "18:00", 5),
    ];
    const result = allocateSignups(oneCourt, signups);

    expect(result.confirmed.map((s) => s.playerId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(result.reserves.map((s) => s.playerId)).toEqual(["p5"]);
    expect(result.committedPlayerBlocks).toBe(16);
    expect(result.remainingPlayerBlocks).toBe(0);
  });

  it("measures capacity in blocks, not head count", () => {
    // Eight players wanting two games each still fits on one court.
    const signups = Array.from({ length: 8 }, (_, i) =>
      makeSignup(`p${i + 1}`, 2, "18:00", i + 1),
    );
    const result = allocateSignups(oneCourt, signups);
    expect(result.confirmed).toHaveLength(8);
    expect(result.remainingPlayerBlocks).toBe(0);
  });

  it("lets a smaller signup take space a bigger one cannot use", () => {
    const signups = [
      makeSignup("p1", 4, "18:00", 1),
      makeSignup("p2", 4, "18:00", 2),
      makeSignup("p3", 4, "18:00", 3),
      makeSignup("p4", 3, "18:00", 4),
      makeSignup("p5", 4, "18:00", 5), // does not fit in the 1 remaining block
      makeSignup("p6", 1, "18:00", 6), // does
    ];
    const result = allocateSignups(oneCourt, signups);
    expect(result.confirmed.map((s) => s.playerId)).toEqual(["p1", "p2", "p3", "p4", "p6"]);
    expect(result.reserves.map((s) => s.playerId)).toEqual(["p5"]);
  });

  it("can keep the queue strictly first-come-first-served instead", () => {
    const signups = [
      makeSignup("p1", 4, "18:00", 1),
      makeSignup("p2", 4, "18:00", 2),
      makeSignup("p3", 4, "18:00", 3),
      makeSignup("p4", 3, "18:00", 4),
      makeSignup("p5", 4, "18:00", 5),
      makeSignup("p6", 1, "18:00", 6),
    ];
    const result = allocateSignups(oneCourt, signups, { allowSkipAhead: false });
    expect(result.confirmed.map((s) => s.playerId)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(result.reserves.map((s) => s.playerId)).toEqual(["p5", "p6"]);
  });

  it("flags a player who arrives after the last court finishes", () => {
    const result = allocateSignups(oneCourt, [makeSignup("late", 2, "20:30", 1)]);
    expect(result.issues[0]?.kind).toBe("ARRIVES_TOO_LATE");
    expect(result.confirmed).toHaveLength(0);
    expect(result.reserves.map((s) => s.playerId)).toEqual(["late"]);
  });

  it("caps a request that cannot fit after the player's start time", () => {
    const result = allocateSignups(oneCourt, [makeSignup("p1", 4, "19:30", 1)]);
    expect(result.issues[0]?.kind).toBe("REQUEST_EXCEEDS_AVAILABILITY");
    expect(result.confirmed[0]?.requestedSlots).toBe(1);
    expect(result.committedPlayerBlocks).toBe(1);
  });
});

describe("reserves moving up when someone drops out", () => {
  const signups = [
    makeSignup("p1", 4, "18:00", 1),
    makeSignup("p2", 4, "18:00", 2),
    makeSignup("p3", 4, "18:00", 3),
    makeSignup("p4", 4, "18:00", 4),
    makeSignup("p5", 4, "18:00", 5),
    makeSignup("p6", 4, "18:00", 6),
  ];

  it("promotes the next reserve in sequence", () => {
    const result = withdrawAndPromote(oneCourt, signups, "p2");
    expect(result.promoted).toEqual(["p5"]);
    expect(result.allocation.confirmed.map((s) => s.playerId)).toEqual([
      "p1",
      "p3",
      "p4",
      "p5",
    ]);
    expect(result.stillWaiting).toEqual(["p6"]);
  });

  it("leaves the withdrawing player out of the lists", () => {
    const result = withdrawAndPromote(oneCourt, signups, "p1");
    expect(result.allocation.confirmed.map((s) => s.playerId)).not.toContain("p1");
    expect(result.allocation.withdrawn.map((s) => s.playerId)).toEqual(["p1"]);
  });
});
