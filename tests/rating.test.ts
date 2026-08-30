import { describe, expect, it } from "vitest";
import {
  RATING_LEVEL_LABELS,
  formatRating,
  isValidRating,
  normaliseRating,
  ratingBand,
  ratingLevel,
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

describe("the three levels the line-ups are coloured by", () => {
  it("splits the classic scale at the quarter and the half", () => {
    expect(ratingLevel(1.0)).toBe("improver");
    expect(ratingLevel(2.4)).toBe("improver");
    expect(ratingLevel(2.5)).toBe("intermediate");
    expect(ratingLevel(3.9)).toBe("intermediate");
    expect(ratingLevel(4.0)).toBe("advanced");
    expect(ratingLevel(7.0)).toBe("advanced");
  });

  it("folds Elite into advanced rather than adding a fourth colour", () => {
    // The band label still distinguishes them; the colour does not.
    expect(ratingBand(6.5)).toBe("Elite");
    expect(ratingLevel(6.5)).toBe("advanced");
    expect(ratingLevel(4.5)).toBe("advanced");
  });

  it("uses fractions of the scale, so a different scale still works", () => {
    const tenPoint = { min: 1, max: 10, step: 0.5 };
    expect(ratingLevel(2, tenPoint)).toBe("improver");
    expect(ratingLevel(4, tenPoint)).toBe("intermediate");
    expect(ratingLevel(8, tenPoint)).toBe("advanced");
  });

  it("copes with a scale of zero width rather than dividing by it", () => {
    expect(ratingLevel(3, { min: 3, max: 3, step: 0.5 })).toBe("improver");
  });

  it("has a label for every level", () => {
    for (const level of ["improver", "intermediate", "advanced"] as const) {
      expect(RATING_LEVEL_LABELS[level]).toBeTruthy();
    }
  });
});
