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
