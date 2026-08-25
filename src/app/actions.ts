"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as db from "@/db";
import { parseSignupText } from "@/domain/parse-signups";
import { normaliseRating } from "@/domain/rating";
import { generateSchedule } from "@/domain/scheduler";
import {
  materialRatingChanges,
  ratingChangesFromResults,
  type MatchResult,
} from "@/domain/rating-updates";
import { parseTime } from "@/domain/time";
import { formatDateLong } from "@/domain/time";
import { FACILITY_COURTS, type CourtBooking, type PaymentMethod, type SessionStatus } from "@/domain/types";
import { parseMoney } from "@/domain/payments";
import { getAdmin, passcodeMatches, requireAdmin, signIn, signOut } from "@/lib/auth";

/* ------------------------------------------------------------- form helpers */

function str(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function int(form: FormData, key: string, fallback: number): number {
  const value = Number.parseInt(str(form, key), 10);
  return Number.isFinite(value) ? value : fallback;
}

/** Redirect back to a page carrying a message for the user to read. */
function backTo(path: string, params: Record<string, string> = {}): never {
  const query = new URLSearchParams(params).toString();
  redirect(query ? `${path}?${query}` : path);
}

/**
 * Read the court picker: a checkbox per physical court, each with its own start
 * time and length, because courts are often booked in staggered blocks.
 */
function readCourts(form: FormData, fallbackStart: number, fallbackSlots: number): CourtBooking[] {
  const courts: CourtBooking[] = [];
  for (const number of FACILITY_COURTS) {
    if (!form.get(`court-${number}`)) continue;

    const rawStart = str(form, `court-${number}-start`);
    let startMinutes = fallbackStart;
    if (rawStart) {
      try {
        startMinutes = parseTime(rawStart);
      } catch {
        startMinutes = fallbackStart;
      }
    }
    courts.push({
      courtNumber: number,
      startMinutes,
      slotCount: Math.max(1, int(form, `court-${number}-slots`, fallbackSlots)),
    });
  }
  return courts;
}

/* -------------------------------------------------------------------- auth  */

export async function loginAction(form: FormData): Promise<void> {
  const name = str(form, "name");
  const passcode = str(form, "passcode");

  if (!name) backTo("/login", { error: "Enter your name so changes can be attributed." });
  if (!passcodeMatches(passcode)) backTo("/login", { error: "That passcode is not right." });

  await signIn(name);
  redirect("/");
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}

/* ------------------------------------------------------------------ players */

export async function createPlayerAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const name = str(form, "name");
  if (!name) backTo("/players", { error: "A player needs a name." });

  const rating = Number(str(form, "rating"));
  if (!Number.isFinite(rating)) backTo("/players", { error: "Pick a rating for the player." });

  db.createPlayer(
    { name, rating, phone: str(form, "phone") || null, notes: str(form, "notes") || null },
    admin,
  );
  revalidatePath("/players");
  backTo("/players", { notice: `${name} added.` });
}

export async function setRatingAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const playerId = str(form, "playerId");
  const rating = Number(str(form, "rating"));
  if (!playerId || !Number.isFinite(rating)) backTo("/players", { error: "Could not read that rating." });

  db.setPlayerRating(playerId, normaliseRating(rating), admin, str(form, "reason") || null);
  revalidatePath("/players");
  revalidatePath(`/players/${playerId}`);
  backTo(`/players/${playerId}`, { notice: "Rating updated." });
}

export async function updatePlayerAction(form: FormData): Promise<void> {
  await requireAdmin();
  const playerId = str(form, "playerId");
  if (!playerId) backTo("/players", { error: "Unknown player." });

  db.updatePlayer(playerId, {
    name: str(form, "name") || undefined,
    phone: str(form, "phone") || null,
    notes: str(form, "notes") || null,
    active: Boolean(form.get("active")),
  });
  revalidatePath("/players");
  revalidatePath(`/players/${playerId}`);
  backTo(`/players/${playerId}`, { notice: "Player updated." });
}

/* ----------------------------------------------------------------- sessions */

export async function createSessionAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();

  const name = str(form, "name") || "Social Mixin";
  const date = str(form, "date");
  if (!date) backTo("/", { error: "Pick a date for the mixin." });

  let startMinutes: number;
  try {
    startMinutes = parseTime(str(form, "startTime"));
  } catch {
    backTo("/", { error: "Enter a start time as HH:MM." });
  }

  const slotCount = Math.max(1, int(form, "slotCount", 4));
  const courts = readCourts(form, startMinutes, slotCount);
  if (courts.length === 0) backTo("/", { error: "Select at least one court." });

  let costPerCourtSlot = 0;
  const rawCost = str(form, "costPerCourtSlot");
  if (rawCost) {
    try {
      costPerCourtSlot = parseMoney(rawCost);
    } catch {
      backTo("/", { error: "Enter the court cost as a number, e.g. 6.00." });
    }
  }

  const session = db.createSession(
    { name, date, startMinutes, slotCount, courts, costPerCourtSlot, currency: str(form, "currency") || "EUR" },
    admin,
  );
  revalidatePath("/");
  redirect(`/sessions/${session.id}`);
}

export async function updateSessionAction(form: FormData): Promise<void> {
  await requireAdmin();
  const sessionId = str(form, "sessionId");
  const existing = db.getSession(sessionId);
  if (!existing) backTo("/", { error: "That mixin no longer exists." });

  let startMinutes = existing.startMinutes;
  const rawStart = str(form, "startTime");
  if (rawStart) {
    try {
      startMinutes = parseTime(rawStart);
    } catch {
      backTo(`/sessions/${sessionId}`, { error: "Enter a start time as HH:MM." });
    }
  }

  const slotCount = Math.max(1, int(form, "slotCount", existing.slotCount));
  const courts = readCourts(form, startMinutes, slotCount);
  if (courts.length === 0) {
    backTo(`/sessions/${sessionId}`, { error: "Select at least one court." });
  }

  let costPerCourtSlot = existing.costPerCourtSlot;
  const rawCost = str(form, "costPerCourtSlot");
  if (rawCost) {
    try {
      costPerCourtSlot = parseMoney(rawCost);
    } catch {
      backTo(`/sessions/${sessionId}`, { error: "Enter the court cost as a number." });
    }
  }

  db.updateSession(sessionId, {
    name: str(form, "name") || existing.name,
    date: str(form, "date") || existing.date,
    startMinutes,
    slotCount,
    courts,
    costPerCourtSlot,
    status: (str(form, "status") || existing.status) as SessionStatus,
  });
  revalidatePath("/");
  revalidatePath(`/sessions/${sessionId}`);
  backTo(`/sessions/${sessionId}`, { notice: "Mixin updated." });
}

export async function deleteSessionAction(form: FormData): Promise<void> {
  await requireAdmin();
  const sessionId = str(form, "sessionId");
  db.deleteSession(sessionId);
  revalidatePath("/");
  backTo("/", { notice: "Mixin deleted." });
}

/* ------------------------------------------------------------------ signups */

export async function addSignupAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const sessionId = str(form, "sessionId");
  const session = db.getSession(sessionId);
  if (!session) backTo("/", { error: "That mixin no longer exists." });

  let playerId = str(form, "playerId");

  // The admin can sign up someone who is not on the books yet.
  if (!playerId) {
    const newName = str(form, "newPlayerName");
    if (!newName) backTo(`/sessions/${sessionId}`, { error: "Pick a player or type a new name." });

    const rating = Number(str(form, "newPlayerRating"));
    if (!Number.isFinite(rating)) {
      backTo(`/sessions/${sessionId}`, { error: "Give the new player a rating." });
    }
    playerId = db.createPlayer({ name: newName, rating }, admin).id;
  }

  let earliestStartMinutes = session.startMinutes;
  const rawStart = str(form, "earliestStart");
  if (rawStart) {
    try {
      earliestStartMinutes = parseTime(rawStart);
    } catch {
      backTo(`/sessions/${sessionId}`, { error: "Enter the player's start time as HH:MM." });
    }
  }

  try {
    db.addSignup({
      sessionId,
      playerId,
      requestedSlots: Math.max(1, int(form, "requestedSlots", 2)),
      earliestStartMinutes,
      note: str(form, "note") || null,
    });
  } catch {
    backTo(`/sessions/${sessionId}`, { error: "That player is already signed up." });
  }

  revalidatePath(`/sessions/${sessionId}`);
  backTo(`/sessions/${sessionId}`, { notice: "Signup added." });
}

/**
 * Bulk import from a block of WhatsApp text. Players already on the books are
 * matched by name; anyone new is created at the rating given on the form and
 * listed back so the admin can check it.
 */
export async function importSignupsAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const sessionId = str(form, "sessionId");
  const session = db.getSession(sessionId);
  if (!session) backTo("/", { error: "That mixin no longer exists." });

  const text = String(form.get("text") ?? "");
  if (!text.trim()) backTo(`/sessions/${sessionId}`, { error: "Paste some text first." });

  const defaultRating = Number(str(form, "defaultRating"));
  const parsed = parseSignupText(text, {
    games: Math.max(1, int(form, "defaultGames", 2)),
    startMinutes: session.startMinutes,
  });

  const players = db.listPlayers(true);
  const byName = new Map(players.map((p) => [p.name.toLowerCase(), p]));
  const existing = new Set(db.listSignups(sessionId).map((s) => s.playerId));

  let added = 0;
  const created: string[] = [];
  const skipped: string[] = [];

  for (const line of parsed) {
    if (!line.name || line.games === null || line.startMinutes === null) {
      skipped.push(line.raw);
      continue;
    }

    let player = byName.get(line.name.toLowerCase());
    if (!player) {
      if (!Number.isFinite(defaultRating)) {
        skipped.push(`${line.raw} (new player, no rating given)`);
        continue;
      }
      player = db.createPlayer(
        { name: line.name, rating: defaultRating, notes: "Added by WhatsApp import — check rating" },
        admin,
      );
      byName.set(player.name.toLowerCase(), player);
      created.push(player.name);
    }

    if (existing.has(player.id)) {
      skipped.push(`${line.name} (already signed up)`);
      continue;
    }

    db.addSignup({
      sessionId,
      playerId: player.id,
      requestedSlots: line.games,
      earliestStartMinutes: line.startMinutes,
    });
    existing.add(player.id);
    added += 1;
  }

  revalidatePath(`/sessions/${sessionId}`);

  const parts = [`Imported ${added}.`];
  if (created.length > 0) parts.push(`New players (check their ratings): ${created.join(", ")}.`);
  if (skipped.length > 0) parts.push(`Could not read ${skipped.length}: ${skipped.slice(0, 5).join(" | ")}`);

  backTo(`/sessions/${sessionId}`, {
    [skipped.length > 0 ? "error" : "notice"]: parts.join(" "),
  });
}

export async function updateSignupAction(form: FormData): Promise<void> {
  await requireAdmin();
  const sessionId = str(form, "sessionId");
  const signupId = str(form, "signupId");

  let earliestStartMinutes: number | undefined;
  const rawStart = str(form, "earliestStart");
  if (rawStart) {
    try {
      earliestStartMinutes = parseTime(rawStart);
    } catch {
      backTo(`/sessions/${sessionId}`, { error: "Enter a start time as HH:MM." });
    }
  }

  const method = str(form, "paymentMethod");
  db.updateSignup(signupId, {
    requestedSlots: form.get("requestedSlots") ? Math.max(1, int(form, "requestedSlots", 1)) : undefined,
    earliestStartMinutes,
    paymentMethod: form.has("paymentMethod") ? ((method || null) as PaymentMethod | null) : undefined,
  });

  revalidatePath(`/sessions/${sessionId}`);
  backTo(`/sessions/${sessionId}`, { notice: "Signup updated." });
}

/** Marks someone as unable to attend; reserves move up automatically. */
export async function withdrawSignupAction(form: FormData): Promise<void> {
  await requireAdmin();
  const sessionId = str(form, "sessionId");
  db.updateSignup(str(form, "signupId"), { status: "WITHDRAWN" });
  revalidatePath(`/sessions/${sessionId}`);
  backTo(`/sessions/${sessionId}`, {
    notice: "Marked as not attending. The reserve list has moved up.",
  });
}

export async function restoreSignupAction(form: FormData): Promise<void> {
  await requireAdmin();
  const sessionId = str(form, "sessionId");
  db.updateSignup(str(form, "signupId"), { status: "CONFIRMED" });
  revalidatePath(`/sessions/${sessionId}`);
  backTo(`/sessions/${sessionId}`, { notice: "Back on the list." });
}

export async function removeSignupAction(form: FormData): Promise<void> {
  await requireAdmin();
  const sessionId = str(form, "sessionId");
  db.removeSignup(str(form, "signupId"));
  revalidatePath(`/sessions/${sessionId}`);
  backTo(`/sessions/${sessionId}`, { notice: "Signup removed." });
}

/* ---------------------------------------------------------------- schedule  */

export async function generateScheduleAction(form: FormData): Promise<void> {
  await requireAdmin();
  const sessionId = str(form, "sessionId");
  const session = db.getSession(sessionId);
  if (!session) backTo("/", { error: "That mixin no longer exists." });

  const { allocateSignups } = await import("@/domain/signups");
  const allocation = allocateSignups(session, db.listSignups(sessionId));
  if (allocation.confirmed.length < 4) {
    backTo(`/sessions/${sessionId}`, { error: "At least four confirmed players are needed." });
  }

  const players = db.listPlayers(true);
  const result = generateSchedule({
    session,
    signups: allocation.confirmed,
    ratings: new Map(players.map((p) => [p.id, p.rating])),
    // The session's own previous draw must not count as history to avoid.
    history: db.buildHistoryIndex(sessionId),
    seed: form.get("reroll") ? Date.now() % 100000 : undefined,
  });

  db.replaceMatches(sessionId, result.matches);
  if (session.status === "OPEN" || session.status === "CLOSED") {
    db.updateSession(sessionId, { status: "SCHEDULED" });
  }

  revalidatePath(`/sessions/${sessionId}`);
  const shortfall =
    result.shortfalls.length > 0
      ? ` ${result.shortfalls.length} player(s) got fewer games than asked.`
      : "";
  backTo(`/sessions/${sessionId}`, {
    notice: `Line-ups generated: ${result.matches.length} games.${shortfall}`,
  });
}

export async function clearScheduleAction(form: FormData): Promise<void> {
  await requireAdmin();
  const sessionId = str(form, "sessionId");
  db.replaceMatches(sessionId, []);
  revalidatePath(`/sessions/${sessionId}`);
  backTo(`/sessions/${sessionId}`, { notice: "Line-ups cleared." });
}

/** Exposed for pages that want to show who is signed in without importing auth. */
export async function currentAdmin(): Promise<string | null> {
  return getAdmin();
}

/* ------------------------------------------------------------------ scores */

/** Record (or clear) the games each team won in one block. */
export async function setScoreAction(form: FormData): Promise<void> {
  await requireAdmin();
  const sessionId = str(form, "sessionId");
  const slotIndex = int(form, "slotIndex", -1);
  const courtNumber = int(form, "courtNumber", -1);
  if (slotIndex < 0 || courtNumber < 0) {
    backTo(`/sessions/${sessionId}`, { error: "Could not tell which game that score was for." });
  }

  const rawA = str(form, "scoreA");
  const rawB = str(form, "scoreB");

  // Both blank clears the result; one blank is almost certainly a slip.
  if (rawA === "" && rawB === "") {
    db.setMatchScore(sessionId, slotIndex, courtNumber, null, null);
  } else if (rawA === "" || rawB === "") {
    backTo(`/sessions/${sessionId}`, { error: "Enter games for both teams, or leave both blank." });
  } else {
    db.setMatchScore(sessionId, slotIndex, courtNumber, Number(rawA), Number(rawB));
  }

  revalidatePath(`/sessions/${sessionId}`);
  backTo(`/sessions/${sessionId}`, { notice: "Score saved." });
}

/**
 * Turn the recorded results into rating changes.
 *
 * Deliberately a single explicit step rather than something that fires as each
 * score is typed. Ratings feed the draw, so moving them mid-evening would change
 * the line-ups already on court, and a one-shot apply gives the admin a preview
 * to check before anything moves. It can only run once per mixin.
 */
export async function applyRatingsAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  const sessionId = str(form, "sessionId");
  const session = db.getSession(sessionId);
  if (!session) backTo("/", { error: "That mixin no longer exists." });

  if (session.ratingsAppliedAt) {
    backTo(`/sessions/${sessionId}`, {
      error: "Ratings have already been updated from this mixin.",
    });
  }

  const results: MatchResult[] = db.listMatches(sessionId).map((match) => ({
    teamA: match.teamA,
    teamB: match.teamB,
    gamesA: match.scoreA ?? 0,
    gamesB: match.scoreB ?? 0,
  }));

  const changes = ratingChangesFromResults(
    results,
    new Map(db.listPlayers(true).map((player) => [player.id, player.rating])),
  );
  const material = materialRatingChanges(changes);

  if (material.length === 0) {
    backTo(`/sessions/${sessionId}`, {
      error: "No scores recorded yet, or the results imply no rating change.",
    });
  }

  const { applied, alreadyApplied } = db.applyRatingChanges(
    sessionId,
    changes,
    admin,
    `${session.name} (${formatDateLong(session.date)})`,
  );

  revalidatePath(`/sessions/${sessionId}`);
  revalidatePath("/players");
  backTo(`/sessions/${sessionId}`, {
    notice: alreadyApplied
      ? "Ratings had already been updated from this mixin."
      : `Updated ${applied} player rating${applied === 1 ? "" : "s"} from the results.`,
  });
}
