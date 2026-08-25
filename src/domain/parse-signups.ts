import { parseTime, roundUpToSlot } from "./time";

/**
 * One line of pasted WhatsApp text, as understood by the parser. Nothing is
 * silently guessed: whatever the parser could not work out comes back as `null`
 * with a note in `problems`, so the admin can correct it before it is saved.
 */
export interface ParsedSignupLine {
  raw: string;
  name: string | null;
  games: number | null;
  startMinutes: number | null;
  problems: string[];
}

/** Lines WhatsApp itself inserts, which are never signups. */
const NOISE = [
  /end-to-end encrypted/i,
  /<media omitted>/i,
  /\bjoined using this group's invite link\b/i,
  /\badded\b.*\bto the group\b/i,
  /\bleft\b$/i,
  /\bmessages and calls\b/i,
  /^\s*$/,
];

/** `[28/08/2025, 18:04] Ana:` or `28/08/2025, 18:04 - Ana:` */
const EXPORT_PREFIX =
  /^\[?\s*\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\s*,?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*\]?\s*(?:-\s*)?/i;

/**
 * `Ana:` at the start of a line, as WhatsApp writes it. Digits are excluded from
 * the name so that the colon inside a time is never mistaken for the sender
 * delimiter — without that, "Ana - 3 - 18:00" parses as a sender called
 * "Ana - 3 - 18".
 */
const SENDER = /^([^:\d]{1,40}?)\s*:\s*/;

const GAME_WORDS = "games?|game|juegos?|partidos?|sets?|slots?|x\\s*30|half\\s*hours?|halves";

function extractTime(text: string): { minutes: number | null; rest: string } {
  // 18:30 / 8:00
  const hhmm = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (hhmm) {
    try {
      return {
        minutes: parseTime(`${hhmm[1]}:${hhmm[2]}`),
        rest: text.replace(hhmm[0], " "),
      };
    } catch {
      /* fall through to the other formats */
    }
  }

  // 6pm / 6.30pm / 6 pm
  const ampm = /\b(\d{1,2})(?:[.:](\d{2}))?\s*([ap])\.?m\.?\b/i.exec(text);
  if (ampm) {
    let hour = Number(ampm[1]) % 12;
    if (ampm[3]?.toLowerCase() === "p") hour += 12;
    const mins = Number(ampm[2] ?? 0);
    if (hour <= 23 && mins <= 59) {
      return { minutes: hour * 60 + mins, rest: text.replace(ampm[0], " ") };
    }
  }

  // 18h / 18h30
  const hFormat = /\b(\d{1,2})h(\d{2})?\b/i.exec(text);
  if (hFormat) {
    const hour = Number(hFormat[1]);
    const mins = Number(hFormat[2] ?? 0);
    if (hour <= 23 && mins <= 59) {
      return { minutes: hour * 60 + mins, rest: text.replace(hFormat[0], " ") };
    }
  }

  return { minutes: null, rest: text };
}

function extractGames(text: string): { games: number | null; rest: string } {
  // Explicit: "3 games", "2 x 30", "4 juegos"
  const explicit = new RegExp(`\\b(\\d{1,2})\\s*(?:${GAME_WORDS})\\b`, "i").exec(text);
  if (explicit) {
    return { games: Number(explicit[1]), rest: text.replace(explicit[0], " ") };
  }

  // Reverse wording: "games 3"
  const reversed = new RegExp(`\\b(?:${GAME_WORDS})\\s*[:=]?\\s*(\\d{1,2})\\b`, "i").exec(text);
  if (reversed) {
    return { games: Number(reversed[1]), rest: text.replace(reversed[0], " ") };
  }

  // Bare small number, e.g. "Ana - 3 - 18:30" once the time is already removed.
  const bare = /(?:^|[\s,;|\-–—])(\d{1,2})(?:$|[\s,;|\-–—])/.exec(text);
  if (bare) {
    const value = Number(bare[1]);
    if (value >= 1 && value <= 12) {
      return { games: value, rest: text.replace(bare[0], " ") };
    }
  }

  return { games: null, rest: text };
}

function cleanName(text: string): string | null {
  const cleaned = text
    .replace(/\b(?:from|desde|a\s+las|at|start(?:ing)?|please|por\s+favor|pls|thanks|gracias)\b/gi, " ")
    .replace(/[-–—,;|:+*]+/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;
  // Keep it to a plausible name, not a whole sentence.
  const words = cleaned.split(" ").slice(0, 4).join(" ");
  return words.length > 40 ? words.slice(0, 40).trim() : words;
}

export interface ParseDefaults {
  /** Used when a line does not say how many games. */
  games?: number;
  /** Used when a line does not say a start time. */
  startMinutes?: number;
}

/**
 * Turn pasted WhatsApp text into candidate signups.
 *
 * Handles both plain lists typed by an admin ("Ana - 3 - 18:30") and raw
 * WhatsApp exports ("[28/08/2025, 18:04] Ana: 3 games from 18:30"), in English
 * or Spanish. Times are rounded up to the next 30-minute boundary because the
 * schedule runs on half-hour blocks.
 */
export function parseSignupText(text: string, defaults: ParseDefaults = {}): ParsedSignupLine[] {
  const results: ParsedSignupLine[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (raw === "") continue;
    if (NOISE.some((pattern) => pattern.test(raw))) continue;

    const problems: string[] = [];

    let body = raw.replace(EXPORT_PREFIX, "");
    let senderName: string | null = null;
    const sender = SENDER.exec(body);
    if (sender?.[1] && /\p{L}/u.test(sender[1])) {
      senderName = sender[1].trim();
      body = body.slice(sender[0].length);
    }

    const timeResult = extractTime(body);
    const gameResult = extractGames(timeResult.rest);

    const name = senderName ?? cleanName(gameResult.rest);
    if (!name) problems.push("Could not find a name.");

    let games = gameResult.games;
    if (games === null) {
      if (defaults.games !== undefined) games = defaults.games;
      else problems.push("Could not find the number of games.");
    }

    let startMinutes = timeResult.minutes;
    if (startMinutes === null) {
      if (defaults.startMinutes !== undefined) startMinutes = defaults.startMinutes;
      else problems.push("Could not find a start time.");
    } else {
      const rounded = roundUpToSlot(startMinutes);
      if (rounded !== startMinutes) {
        problems.push(`Start time rounded up to the next half hour.`);
        startMinutes = rounded;
      }
    }

    results.push({ raw, name, games, startMinutes, problems });
  }

  return results;
}
