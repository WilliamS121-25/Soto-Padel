import { describe, expect, it } from "vitest";
import {
  formatDateLong,
  formatSlotCount,
  formatSlotRange,
  formatTime,
  parseTime,
  roundUpToSlot,
} from "@/domain/time";

describe("time", () => {
  it("round-trips HH:MM", () => {
    expect(parseTime("18:30")).toBe(18 * 60 + 30);
    expect(formatTime(parseTime("08:05"))).toBe("08:05");
    expect(formatTime(parseTime("9:15"))).toBe("09:15");
  });

  it("rejects nonsense times", () => {
    expect(() => parseTime("25:00")).toThrow();
    expect(() => parseTime("18:75")).toThrow();
    expect(() => parseTime("evening")).toThrow();
  });

  it("formats slot ranges and durations", () => {
    expect(formatSlotRange(parseTime("18:00"), 4)).toBe("18:00-20:00");
    expect(formatSlotRange(parseTime("19:30"))).toBe("19:30-20:00");
    expect(formatSlotCount(1)).toBe("30min");
    expect(formatSlotCount(2)).toBe("1h");
    expect(formatSlotCount(3)).toBe("1h30");
  });

  it("rounds up to the next half hour", () => {
    expect(roundUpToSlot(parseTime("18:00"))).toBe(parseTime("18:00"));
    expect(roundUpToSlot(parseTime("18:10"))).toBe(parseTime("18:30"));
    expect(roundUpToSlot(parseTime("18:45"))).toBe(parseTime("19:00"));
  });

  it("formats dates without timezone drift", () => {
    expect(formatDateLong("2025-08-29")).toBe("Friday 29 Aug 2025");
    expect(formatDateLong("2026-01-01")).toBe("Thursday 1 Jan 2026");
  });
});
