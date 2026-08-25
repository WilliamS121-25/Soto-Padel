import { describe, expect, it } from "vitest";
import {
  formatRating,
  isValidRating,
  normaliseRating,
  ratingBand,
  ratingOptions,
} from "@/domain/rating";
import { DEFAULT_RATING_SCALE, RATING_SCALE_PRESETS } from "@/domain/types";

describe("classic padel rating scale", () => {
  it("snaps to the nearest quarter point", () => {
    expect(normaliseRating(3.3)).toBe(3.25);
    expect(normaliseRating(3.4)).toBe(3.5);
    expect(normaliseRating(4)).toBe(4);
  });

  it("clamps outside the scale", () => {
    expect(normaliseRating(0.2)).toBe(DEFAULT_RATING_SCALE.min);
    expect(normaliseRating(99)).toBe(DEFAULT_RATING_SCALE.max);
  });

  it("does not leave binary-float artefacts", () => {
    for (const option of ratingOptions()) {
      expect(String(option)).not.toMatch(/000000|999999/);
    }
  });

  it("validates only on-scale values", () => {
    expect(isValidRating(3.25)).toBe(true);
    expect(isValidRating(3.3)).toBe(false);
    expect(isValidRating(8)).toBe(false);
    expect(isValidRating(Number.NaN)).toBe(false);
  });

  it("enumerates every step on the scale", () => {
    const options = ratingOptions();
    expect(options[0]).toBe(1);
    expect(options.at(-1)).toBe(7);
    expect(options).toHaveLength(25);
  });

  it("supports other club scales", () => {
    expect(normaliseRating(5.37, RATING_SCALE_PRESETS.playtomic!)).toBe(5.4);
    expect(ratingOptions(RATING_SCALE_PRESETS.tenPoint!).at(-1)).toBe(10);
  });

  it("formats and bands for display", () => {
    expect(formatRating(3.5)).toBe("3.50");
    expect(ratingBand(1.5)).toBe("Improver");
    expect(ratingBand(6.5)).toBe("Elite");
  });
});
