import { describe, expect, it } from "vitest";
import { parseTime } from "@/domain/time";
import {
  buildTimeline,
  computeCapacity,
  playableBlocksFrom,
  sessionEndMinutes,
} from "@/domain/timeline";
import { court, makeSession } from "./fixtures";

describe("timeline with staggered court starts", () => {
  const session = makeSession({
    startMinutes: parseTime("18:00"),
    slotCount: 4,
    // Court 1 runs the whole session; court 3 joins an hour late and runs on.
    courts: [court(1, "18:00", 4), court(3, "19:00", 3)],
  });

  it("puts each court in only the blocks it is booked for", () => {
    const timeline = buildTimeline(session);
    expect(timeline.map((s) => s.courts.map((c) => c.courtNumber))).toEqual([
      [1],
      [1],
      [1, 3],
      [1, 3],
      [3],
    ]);
  });

  it("extends the grid past the advertised end when a court runs later", () => {
    expect(sessionEndMinutes(session)).toBe(parseTime("20:30"));
    expect(buildTimeline(session).at(-1)?.startMinutes).toBe(parseTime("20:00"));
  });

  it("counts capacity in player-blocks, four per court per block", () => {
    const capacity = computeCapacity(session);
    expect(capacity.totalCourtBlocks).toBe(7);
    expect(capacity.totalPlayerBlocks).toBe(28);
    expect(capacity.perSlot.map((s) => s.seats)).toEqual([4, 4, 8, 8, 4]);
  });

  it("tracks committed and remaining blocks", () => {
    const capacity = computeCapacity(session, 20);
    expect(capacity.remainingPlayerBlocks).toBe(8);
  });

  it("knows how much a late arrival could actually play", () => {
    expect(playableBlocksFrom(session, parseTime("18:00"))).toBe(5);
    expect(playableBlocksFrom(session, parseTime("19:00"))).toBe(3);
    expect(playableBlocksFrom(session, parseTime("20:30"))).toBe(0);
  });
});
