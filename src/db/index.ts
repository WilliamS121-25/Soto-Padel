import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { ADDED_COLUMNS, SCHEMA } from "./schema";
import { clampRating, normaliseRating } from "@/domain/rating";
import type { PlayerRatingChange } from "@/domain/rating-updates";
import type { MatchRecord } from "@/domain/history";
import { HistoryIndex } from "@/domain/history";
import { MAX_GAMES_PER_BLOCK } from "@/domain/types";
import type {
  CourtBooking,
  Match,
  PaymentMethod,
  Player,
  RatingChange,
  Session,
  SessionStatus,
  Signup,
  SignupStatus,
} from "@/domain/types";

/**
 * One SQLite file, opened once per process. The connection is cached on
 * `globalThis` so Next's dev-server hot reload reuses it rather than opening a
 * new handle on every edit.
 */
const globalForDb = globalThis as unknown as { sotoPadelDb?: Database.Database };

/** Where the database file is, or would be. */
export function databasePath(): string {
  // The database path is configuration, so it cannot be known at build time.
  // The ignore comment tells the bundler that on purpose; without it the tracer
  // assumes the worst and copies the entire project into the server output.
  return resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH ?? "./data/soto-padel.db");
}

function open(): Database.Database {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}

/** Bring a database created by an earlier version up to the current shape. */
function addMissingColumns(db: Database.Database): void {
  for (const { table, column, type } of ADDED_COLUMNS) {
    // Table and column names come from a hardcoded list, never from input.
    const existing = db
      .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    if (!existing.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

export function getDb(): Database.Database {
  if (!globalForDb.sotoPadelDb) globalForDb.sotoPadelDb = open();
  return globalForDb.sotoPadelDb;
}

const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

/* ---------------------------------------------------------------- players -- */

interface PlayerRow {
  id: string;
  name: string;
  phone: string | null;
  rating: number;
  active: number;
  notes: string | null;
  created_at: string;
}

const toPlayer = (row: PlayerRow): Player => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  rating: row.rating,
  active: row.active === 1,
  notes: row.notes,
  createdAt: row.created_at,
});

export function listPlayers(includeInactive = false): Player[] {
  const rows = getDb()
    .prepare<[], PlayerRow>(
      `SELECT * FROM players ${includeInactive ? "" : "WHERE active = 1"} ORDER BY name COLLATE NOCASE`,
    )
    .all();
  return rows.map(toPlayer);
}

export function getPlayer(id: string): Player | null {
  const row = getDb().prepare<[string], PlayerRow>("SELECT * FROM players WHERE id = ?").get(id);
  return row ? toPlayer(row) : null;
}

export function createPlayer(
  input: { name: string; rating: number; phone?: string | null; notes?: string | null },
  admin: string,
): Player {
  const db = getDb();
  const id = newId();
  const rating = normaliseRating(input.rating);
  const createdAt = nowIso();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO players (id, name, phone, rating, active, notes, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, input.name.trim(), input.phone?.trim() || null, rating, input.notes?.trim() || null, createdAt);

    db.prepare(
      `INSERT INTO rating_changes (id, player_id, previous_rating, new_rating, changed_at, changed_by, reason)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    ).run(newId(), id, rating, createdAt, admin, "Initial rating");
  })();

  const created = getPlayer(id);
  if (!created) throw new Error("Failed to create player");
  return created;
}

export function updatePlayer(
  id: string,
  patch: { name?: string; phone?: string | null; notes?: string | null; active?: boolean },
): void {
  const existing = getPlayer(id);
  if (!existing) throw new Error(`Unknown player ${id}`);

  getDb()
    .prepare("UPDATE players SET name = ?, phone = ?, notes = ?, active = ? WHERE id = ?")
    .run(
      patch.name?.trim() ?? existing.name,
      patch.phone === undefined ? existing.phone : patch.phone?.trim() || null,
      patch.notes === undefined ? existing.notes : patch.notes?.trim() || null,
      (patch.active ?? existing.active) ? 1 : 0,
      id,
    );
}

/**
 * Change a player's rating and record why. The history is the point: ratings
 * drift over a season and an admin needs to see how a player got where they are.
 */
export function setPlayerRating(
  id: string,
  newRating: number,
  admin: string,
  reason?: string | null,
  options: { snap?: boolean } = {},
): void {
  const db = getDb();
  const existing = getPlayer(id);
  if (!existing) throw new Error(`Unknown player ${id}`);

  // Manual changes come off a quarter-point dropdown and are snapped. Changes
  // derived from results are not: they legitimately land between steps.
  const rating = (options.snap ?? true) ? normaliseRating(newRating) : clampRating(newRating);
  if (rating === existing.rating) return;

  db.transaction(() => {
    db.prepare("UPDATE players SET rating = ? WHERE id = ?").run(rating, id);
    db.prepare(
      `INSERT INTO rating_changes (id, player_id, previous_rating, new_rating, changed_at, changed_by, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), id, existing.rating, rating, nowIso(), admin, reason?.trim() || null);
  })();
}

interface RatingChangeRow {
  id: string;
  player_id: string;
  previous_rating: number | null;
  new_rating: number;
  changed_at: string;
  changed_by: string;
  reason: string | null;
}

export function listRatingHistory(playerId: string): RatingChange[] {
  // The rowid tiebreak matters: two changes in the same millisecond share a
  // timestamp, and without it the newest-first order — and so the rating shown
  // as current — would be arbitrary.
  return getDb()
    .prepare<[string], RatingChangeRow>(
      `SELECT * FROM rating_changes WHERE player_id = ?
       ORDER BY changed_at DESC, rowid DESC`,
    )
    .all(playerId)
    .map((row) => ({
      id: row.id,
      playerId: row.player_id,
      previousRating: row.previous_rating,
      newRating: row.new_rating,
      changedAt: row.changed_at,
      changedBy: row.changed_by,
      reason: row.reason,
    }));
}

/* --------------------------------------------------------------- sessions -- */

interface SessionRow {
  id: string;
  name: string;
  date: string;
  start_minutes: number;
  slot_count: number;
  cost_per_court_slot: number;
  currency: string;
  status: string;
  created_at: string;
  created_by: string;
  ratings_applied_at: string | null;
}

interface CourtRow {
  court_number: number;
  start_minutes: number;
  slot_count: number;
}

function courtsFor(sessionId: string): CourtBooking[] {
  return getDb()
    .prepare<[string], CourtRow>(
      "SELECT court_number, start_minutes, slot_count FROM session_courts WHERE session_id = ? ORDER BY court_number",
    )
    .all(sessionId)
    .map((row) => ({
      courtNumber: row.court_number,
      startMinutes: row.start_minutes,
      slotCount: row.slot_count,
    }));
}

const toSession = (row: SessionRow): Session => ({
  id: row.id,
  name: row.name,
  date: row.date,
  startMinutes: row.start_minutes,
  slotCount: row.slot_count,
  courts: courtsFor(row.id),
  costPerCourtSlot: row.cost_per_court_slot,
  currency: row.currency,
  status: row.status as SessionStatus,
  createdAt: row.created_at,
  createdBy: row.created_by,
  ratingsAppliedAt: row.ratings_applied_at,
});

export function listSessions(): Session[] {
  return getDb()
    .prepare<[], SessionRow>("SELECT * FROM sessions ORDER BY date DESC, start_minutes DESC")
    .all()
    .map(toSession);
}

export function getSession(id: string): Session | null {
  const row = getDb().prepare<[string], SessionRow>("SELECT * FROM sessions WHERE id = ?").get(id);
  return row ? toSession(row) : null;
}

export function createSession(
  input: {
    name: string;
    date: string;
    startMinutes: number;
    slotCount: number;
    courts: CourtBooking[];
    costPerCourtSlot: number;
    currency?: string;
  },
  admin: string,
): Session {
  const db = getDb();
  const id = newId();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions
         (id, name, date, start_minutes, slot_count, cost_per_court_slot, currency, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
    ).run(
      id,
      input.name.trim(),
      input.date,
      input.startMinutes,
      input.slotCount,
      input.costPerCourtSlot,
      input.currency ?? "EUR",
      nowIso(),
      admin,
    );
    writeCourts(id, input.courts);
  })();

  const created = getSession(id);
  if (!created) throw new Error("Failed to create session");
  return created;
}

function writeCourts(sessionId: string, courts: CourtBooking[]): void {
  const db = getDb();
  db.prepare("DELETE FROM session_courts WHERE session_id = ?").run(sessionId);
  const insert = db.prepare(
    "INSERT INTO session_courts (session_id, court_number, start_minutes, slot_count) VALUES (?, ?, ?, ?)",
  );
  for (const court of courts) {
    insert.run(sessionId, court.courtNumber, court.startMinutes, court.slotCount);
  }
}

export function updateSession(
  id: string,
  patch: {
    name?: string;
    date?: string;
    startMinutes?: number;
    slotCount?: number;
    courts?: CourtBooking[];
    costPerCourtSlot?: number;
    currency?: string;
    status?: SessionStatus;
  },
): void {
  const db = getDb();
  const existing = getSession(id);
  if (!existing) throw new Error(`Unknown session ${id}`);

  db.transaction(() => {
    db.prepare(
      `UPDATE sessions SET name = ?, date = ?, start_minutes = ?, slot_count = ?,
         cost_per_court_slot = ?, currency = ?, status = ? WHERE id = ?`,
    ).run(
      patch.name?.trim() ?? existing.name,
      patch.date ?? existing.date,
      patch.startMinutes ?? existing.startMinutes,
      patch.slotCount ?? existing.slotCount,
      patch.costPerCourtSlot ?? existing.costPerCourtSlot,
      patch.currency ?? existing.currency,
      patch.status ?? existing.status,
      id,
    );
    if (patch.courts) writeCourts(id, patch.courts);
  })();
}

export function deleteSession(id: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/* ---------------------------------------------------------------- signups -- */

interface SignupRow {
  id: string;
  session_id: string;
  player_id: string;
  requested_slots: number;
  earliest_start_minutes: number;
  status: string;
  queue_position: number;
  payment_method: string | null;
  note: string | null;
}

const toSignup = (row: SignupRow): Signup => ({
  id: row.id,
  sessionId: row.session_id,
  playerId: row.player_id,
  requestedSlots: row.requested_slots,
  earliestStartMinutes: row.earliest_start_minutes,
  status: row.status as SignupStatus,
  queuePosition: row.queue_position,
  paymentMethod: row.payment_method as PaymentMethod | null,
  note: row.note,
});

export function listSignups(sessionId: string): Signup[] {
  return getDb()
    .prepare<[string], SignupRow>(
      "SELECT * FROM signups WHERE session_id = ? ORDER BY queue_position, id",
    )
    .all(sessionId)
    .map(toSignup);
}

/** Adds a signup at the back of the queue, which is what signing up means. */
export function addSignup(input: {
  sessionId: string;
  playerId: string;
  requestedSlots: number;
  earliestStartMinutes: number;
  note?: string | null;
}): Signup {
  const db = getDb();
  const next = db
    .prepare<[string], { next: number }>(
      "SELECT COALESCE(MAX(queue_position), 0) + 1 AS next FROM signups WHERE session_id = ?",
    )
    .get(input.sessionId);

  const id = newId();
  db.prepare(
    `INSERT INTO signups
       (id, session_id, player_id, requested_slots, earliest_start_minutes, status, queue_position, payment_method, note)
     VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, NULL, ?)`,
  ).run(
    id,
    input.sessionId,
    input.playerId,
    input.requestedSlots,
    input.earliestStartMinutes,
    next?.next ?? 1,
    input.note?.trim() || null,
  );

  const row = db.prepare<[string], SignupRow>("SELECT * FROM signups WHERE id = ?").get(id);
  if (!row) throw new Error("Failed to create signup");
  return toSignup(row);
}

export function updateSignup(
  id: string,
  patch: {
    requestedSlots?: number;
    earliestStartMinutes?: number;
    status?: SignupStatus;
    paymentMethod?: PaymentMethod | null;
    note?: string | null;
  },
): void {
  const db = getDb();
  const row = db.prepare<[string], SignupRow>("SELECT * FROM signups WHERE id = ?").get(id);
  if (!row) throw new Error(`Unknown signup ${id}`);

  db.prepare(
    `UPDATE signups SET requested_slots = ?, earliest_start_minutes = ?, status = ?,
       payment_method = ?, note = ? WHERE id = ?`,
  ).run(
    patch.requestedSlots ?? row.requested_slots,
    patch.earliestStartMinutes ?? row.earliest_start_minutes,
    patch.status ?? row.status,
    patch.paymentMethod === undefined ? row.payment_method : patch.paymentMethod,
    patch.note === undefined ? row.note : patch.note?.trim() || null,
    id,
  );
}

export function removeSignup(id: string): void {
  getDb().prepare("DELETE FROM signups WHERE id = ?").run(id);
}

/* ---------------------------------------------------------------- matches -- */

interface MatchRow {
  slot_index: number;
  court_number: number;
  team_a1: string;
  team_a2: string;
  team_b1: string;
  team_b2: string;
  score_a: number | null;
  score_b: number | null;
}

const toMatch = (row: MatchRow): Match => ({
  slotIndex: row.slot_index,
  courtNumber: row.court_number,
  teamA: [row.team_a1, row.team_a2] as const,
  teamB: [row.team_b1, row.team_b2] as const,
  scoreA: row.score_a,
  scoreB: row.score_b,
});

export function listMatches(sessionId: string): Match[] {
  return getDb()
    .prepare<[string], MatchRow>(
      "SELECT * FROM matches WHERE session_id = ? ORDER BY slot_index, court_number",
    )
    .all(sessionId)
    .map(toMatch);
}

/** Replaces a session's schedule wholesale, which is what regenerating means. */
export function replaceMatches(sessionId: string, matches: Match[]): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM matches WHERE session_id = ?").run(sessionId);
    // Scores are deliberately not carried over: a regenerated draw puts
    // different people on court, so any previously recorded result is void.
    const insert = db.prepare(
      `INSERT INTO matches (id, session_id, slot_index, court_number, team_a1, team_a2, team_b1, team_b2)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const match of matches) {
      insert.run(
        newId(),
        sessionId,
        match.slotIndex,
        match.courtNumber,
        match.teamA[0],
        match.teamA[1],
        match.teamB[0],
        match.teamB[1],
      );
    }
  })();
}

interface MatchRecordRow extends MatchRow {
  session_id: string;
  date: string;
}

/**
 * Every match ever played, for the partner/opponent history. `excludeSessionId`
 * leaves out the session being scheduled, so regenerating a draw does not treat
 * its own previous attempt as history to avoid.
 */
export function listMatchRecords(excludeSessionId?: string): MatchRecord[] {
  const sql = `SELECT m.*, s.date FROM matches m
               JOIN sessions s ON s.id = m.session_id
               ${excludeSessionId ? "WHERE m.session_id != ?" : ""}
               ORDER BY s.date, m.slot_index`;
  const statement = getDb().prepare<string[], MatchRecordRow>(sql);
  const rows = excludeSessionId ? statement.all(excludeSessionId) : statement.all();

  return rows.map((row) => ({
    sessionId: row.session_id,
    date: row.date,
    slotIndex: row.slot_index,
    courtNumber: row.court_number,
    teamA: [row.team_a1, row.team_a2] as const,
    teamB: [row.team_b1, row.team_b2] as const,
  }));
}

export function buildHistoryIndex(excludeSessionId?: string): HistoryIndex {
  return new HistoryIndex(listMatchRecords(excludeSessionId));
}

/* ----------------------------------------------------------------- scores -- */

/**
 * Record the games each team won in one block.
 *
 * Identified by slot and court rather than by match id, because ids are
 * reissued whenever a draw is regenerated while "court 3 at 19:00" is what the
 * admin is actually looking at. Pass nulls to clear a score.
 */
export function setMatchScore(
  sessionId: string,
  slotIndex: number,
  courtNumber: number,
  scoreA: number | null,
  scoreB: number | null,
): void {
  // Bounded on purpose: a 30-minute block cannot yield more than a handful of
  // games, so "64" is a mistyped "6-4". Clamping keeps one slip from moving a
  // rating by the maximum the cap allows.
  const clean = (value: number | null) =>
    value === null || !Number.isFinite(value)
      ? null
      : Math.min(MAX_GAMES_PER_BLOCK, Math.max(0, Math.trunc(value)));

  getDb()
    .prepare(
      `UPDATE matches SET score_a = ?, score_b = ?
       WHERE session_id = ? AND slot_index = ? AND court_number = ?`,
    )
    .run(clean(scoreA), clean(scoreB), sessionId, slotIndex, courtNumber);
}

/**
 * Write the rating changes a session's results imply, once.
 *
 * Idempotent by design: the session records when its results were applied, and
 * a second attempt is refused rather than double-counting every game. Each
 * change lands in the rating history with the session named, so a player can
 * always see which night moved them.
 */
export function applyRatingChanges(
  sessionId: string,
  changes: PlayerRatingChange[],
  admin: string,
  sessionLabel: string,
): { applied: number; alreadyApplied: boolean } {
  const db = getDb();
  const session = getSession(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  if (session.ratingsAppliedAt) return { applied: 0, alreadyApplied: true };

  const material = changes.filter((change) => change.to !== change.from);

  db.transaction(() => {
    for (const change of material) {
      const sign = change.delta > 0 ? "+" : "";
      setPlayerRating(
        change.playerId,
        change.to,
        admin,
        `${sessionLabel}: ${sign}${change.delta.toFixed(2)} from ${change.gamesCounted} game${change.gamesCounted === 1 ? "" : "s"}`,
        { snap: false },
      );
    }
    db.prepare("UPDATE sessions SET ratings_applied_at = ? WHERE id = ?").run(nowIso(), sessionId);
  })();

  return { applied: material.length, alreadyApplied: false };
}

/**
 * Applying is deliberately one-way, and there is no "un-apply" here.
 *
 * Re-running would measure the same results against ratings those results have
 * already moved, counting every game twice. Doing it safely would mean storing
 * each player's pre-session baseline so a re-run could start from it, which is
 * more machinery than a mistyped score is worth. A wrong score after the fact is
 * corrected by editing the player's rating directly, which is already audited in
 * the rating history.
 */

/* ------------------------------------------------------------- diagnostics -- */

export interface DatabaseProblem {
  /** The errno, where there is one: EROFS, EACCES, ENOENT and so on. */
  code: string;
  /** Where the app tried to put the database. */
  path: string;
  /** The underlying error, for an admin to read. */
  detail: string;
  /** What is most likely wrong, in plain words. */
  summary: string;
  /** What to do about it. */
  remedy: string;
}

/**
 * Turn a failure to open the database into something an admin can act on.
 *
 * Pure, so every branch is testable: most of these errnos cannot be provoked on
 * demand, least of all EROFS, which is the one that matters most because it is
 * what a serverless host produces.
 */
export function describeDatabaseError(
  error: NodeJS.ErrnoException,
  path: string,
): DatabaseProblem {
  const code = error.code ?? "UNKNOWN";
  const base = { code, path, detail: error.message };

  switch (code) {
    case "EROFS":
      return {
        ...base,
        summary: "The filesystem is read-only, so the database cannot be created.",
        remedy:
          "This is what a serverless host gives you. The app needs a persistent, writable disk — see the deployment notes in README.md. No environment variable will fix it.",
      };
    case "EACCES":
    case "EPERM":
      return {
        ...base,
        summary: "The app is not allowed to write to that location.",
        remedy:
          "Give the process write access to the directory above, or point DATABASE_PATH somewhere it can write.",
      };
    case "ENOENT":
    case "ENOTDIR":
      return {
        ...base,
        summary: "That path cannot be created.",
        remedy:
          "Check DATABASE_PATH. Every directory above the file has to be creatable — in a container that usually means a volume mounted there.",
      };
    case "ENOSPC":
      return {
        ...base,
        summary: "The disk is full.",
        remedy: "Free space on the volume, or grow it.",
      };
    default:
      return {
        ...base,
        summary: "The database could not be opened.",
        remedy:
          "Check DATABASE_PATH and that the disk it points at is mounted and writable.",
      };
  }
}

/**
 * Check the database can actually be opened, and explain it if not.
 *
 * Without this a host that cannot give the app a writable disk produces a bare
 * crash page: `open()` throws out of `mkdirSync` or the SQLite constructor, no
 * code catches it, and the admin is left with "server error" and nothing to act
 * on. The single most common cause is deploying to a serverless platform, where
 * the filesystem is read-only and no configuration can make SQLite work.
 *
 * A failed open caches nothing, so this keeps reporting the problem until it is
 * actually fixed, and starts working the moment it is.
 */
export function databaseProblem(): DatabaseProblem | null {
  try {
    getDb().prepare("SELECT 1 AS ok").get();
    return null;
  } catch (error) {
    return describeDatabaseError(error as NodeJS.ErrnoException, databasePath());
  }
}
