import { DEFAULT_RATING_SCALE, type RatingScale } from "./types";

/** Snap a rating to the nearest valid step and clamp it into the scale. */
export function normaliseRating(value: number, scale: RatingScale = DEFAULT_RATING_SCALE): number {
  if (!Number.isFinite(value)) throw new Error("Rating must be a finite number");
  const clamped = Math.min(scale.max, Math.max(scale.min, value));
  const steps = Math.round((clamped - scale.min) / scale.step);
  const snapped = scale.min + steps * scale.step;
  // Avoid binary-float artefacts like 3.7500000000000004.
  return Number(snapped.toFixed(4));
}

export function isValidRating(value: number, scale: RatingScale = DEFAULT_RATING_SCALE): boolean {
  if (!Number.isFinite(value)) return false;
  if (value < scale.min || value > scale.max) return false;
  return Math.abs(value - normaliseRating(value, scale)) < 1e-6;
}

/** Every legal value on the scale, for populating a dropdown. */
export function ratingOptions(scale: RatingScale = DEFAULT_RATING_SCALE): number[] {
  const options: number[] = [];
  const count = Math.round((scale.max - scale.min) / scale.step);
  for (let i = 0; i <= count; i += 1) {
    options.push(Number((scale.min + i * scale.step).toFixed(4)));
  }
  return options;
}

/** Display form — two decimals reads naturally on the 0.25-step classic scale. */
export function formatRating(value: number): string {
  return value.toFixed(2);
}

/**
 * Coarse band used to group players for display and to keep mixed-level rounds
 * readable in WhatsApp messages. Bands are quarter-scale slices.
 */
export function ratingBand(value: number, scale: RatingScale = DEFAULT_RATING_SCALE): string {
  const span = scale.max - scale.min;
  const position = span === 0 ? 0 : (value - scale.min) / span;
  if (position < 0.25) return "Improver";
  if (position < 0.5) return "Intermediate";
  if (position < 0.75) return "Advanced";
  return "Elite";
}

/**
 * The three levels the line-ups are colour-coded by.
 *
 * Coarser than `ratingBand` on purpose: on court there are only three groups
 * worth telling apart at a glance, and the club named them. Elite shares the
 * advanced colour rather than introducing a fourth that nobody asked for; the
 * band label still says Elite where it applies.
 */
export type RatingLevel = "improver" | "intermediate" | "advanced";

export const RATING_LEVEL_LABELS: Record<RatingLevel, string> = {
  improver: "Improving",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

export function ratingLevel(
  value: number,
  scale: RatingScale = DEFAULT_RATING_SCALE,
): RatingLevel {
  const span = scale.max - scale.min;
  const position = span === 0 ? 0 : (value - scale.min) / span;
  if (position < 0.25) return "improver";
  if (position < 0.5) return "intermediate";
  return "advanced";
}

/**
 * Clamp a rating into the scale without snapping it to a step.
 *
 * Manual rating changes come off a dropdown and land on clean quarter points.
 * Ratings derived from results do not: a night's play might move someone by
 * 0.13, and forcing that onto the nearest quarter would either overstate the
 * move or throw it away entirely, so a rating earned from results is allowed to
 * sit between steps. Two decimals is the stored precision.
 */
export function clampRating(value: number, scale: RatingScale = DEFAULT_RATING_SCALE): number {
  if (!Number.isFinite(value)) throw new Error("Rating must be a finite number");
  return Number(Math.min(scale.max, Math.max(scale.min, value)).toFixed(2));
}
