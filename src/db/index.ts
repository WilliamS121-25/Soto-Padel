import { clampRating, normaliseRating } from "@/domain/rating";
import type { PlayerRatingChange } from "@/domain/rating-updates";
import { HistoryIndex, type MatchRecord } from "@/domain/history";
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
import {
  connectionString,
  localDataDirectory,
  openClient,
  serverlessHost,
  wrongSchemeIn,
  type SqlClient,
} from "./client";
import { ADDED_COLUMNS, INDEXES, SCHEMA } from "./schema";

/**
 * One connection per process, cached on `globalThis` so Next's dev-server hot
 * reload reuses it rather than opening a new one on every edit. The promise
 * itself is cached, so concurrent first requests share a single open rather
 * than racing to create the schema.
 */
const globalForDb = globalThis as unknown as { sotoPadelDb?: Promise<SqlClient> };

async function open(): Promise<SqlClient> {
  const client = await openClient();
  await client.exec(SCHEMA);
  // Columns before indexes: an upgraded database has the old tables but not the
  // new columns, and an index over a column that does not exist yet fails.
  await addMissingColumns(client);
  await client.exec(INDEXES);
  return client;
}

/** Bring a database created by an earlier version up to the current shape. */
async function addMissingColumns(client: SqlClient): Promise<void> {
  for (const { table, column, type } of ADDED_COLUMNS) {
    // Table and column names come from a hardcoded list, never from input.
    await client.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
  }
}

export function getDb(): Promise<SqlClient> {
  if (!globalForDb.sotoPadelDb) {
    globalForDb.sotoPadelDb = open().catch((error) => {
      // A failed open must not be cached, or the app could never recover
      // without a restart once the database came back.
      globalForDb.sotoPadelDb = undefined;
      throw error;
    });
  }
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
  active: boolean;
  notes: string | null;
  created_at: string;
}

const toPlayer = (row: PlayerRow): Player => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  rating: Number(row.rating),
  active: row.active,
  notes: row.notes,
  createdAt: row.created_at,
});

export async function listPlayers(includeInactive = false): Promise<Player[]> {
  const db = await getDb();
  const { rows } = await db.query<PlayerRow>(
    `SELECT * FROM players ${includeInactive ? "" : "WHERE active"} ORDER BY LOWER(name)`,
  );
  return rows.map(toPlayer);
}

export async function getPlayer(id: string): Promise<Player | null> {
  const db = await getDb();
  const { rows } = await db.query<PlayerRow>("SELECT * FROM players WHERE id = $1", [id]);
  const row = rows[0];
  return row ? toPlayer(row) : null;
}

export async function createPlayer(
  input: { name: string; rating: number; phone?: string | null; notes?: string | null },
  admin: string,
): Promise<Player> {
  const db = await getDb();
  const id = newId();
  const rating = normaliseRating(input.rating);
  const createdAt = nowIso();

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO players (id, name, phone, rating, active, notes, created_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6)`,
      [id, input.name.trim(), input.phone?.trim() || null, rating, input.notes?.trim() || null, createdAt],
    );
    await tx.query(
      `INSERT INTO rating_changes (id, player_id, previous_rating, new_rating, changed_at, changed_by, reason)
       VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
      [newId(), id, rating, createdAt, admin, "Initial rating"],
    );
  });

  const created = await getPlayer(id);
  if (!created) throw new Error("Failed to create player");
  return created;
}

/** A mixin, named just enough to point the organiser at it. */
export interface SessionRef {
  id: string;
  name: string;
  date: string;
}

export type DeletePlayerOutcome =
  | { deleted: true; removedFromSessions: number }
  | { deleted: false; playedIn: SessionRef[] };

/**
 * Remove a player, along with their signups and rating history.
 *
 * Refused when the player appears in a saved draw. `matches` references
 * `players` with no cascade, so the database would reject it anyway — but the
 * reason matters more than the error: a draw containing a deleted player is not
 * just a broken row, it invalidates the line-ups, the payment schedule derived
 * from them and any score recorded against them. Making the player inactive is
 * the right move there, and the page says so.
 *
 * Where it does go ahead, the signups go with the player, so the count is
 * returned and reported rather than left for the organiser to notice.
 */
export async function deletePlayer(playerId: string): Promise<DeletePlayerOutcome> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { rows: played } = await tx.query<{ id: string; name: string; date: string }>(
      `SELECT DISTINCT s.id, s.name, s.date
         FROM matches m JOIN sessions s ON s.id = m.session_id
        WHERE $1 IN (m.team_a1, m.team_a2, m.team_b1, m.team_b2)
        ORDER BY s.date DESC`,
      [playerId],
    );
    if (played.length > 0) return { deleted: false, playedIn: played };

    const { rows: counted } = await tx.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM signups WHERE player_id = $1",
      [playerId],
    );
    const removedFromSessions = Number(counted[0]?.count ?? 0);

    // Signups and rating history cascade from the player row.
    await tx.query("DELETE FROM players WHERE id = $1", [playerId]);
    return { deleted: true, removedFromSessions };
  });
}

export async function updatePlayer(
  id: string,
  patch: { name?: string; phone?: string | null; notes?: string | null; active?: boolean },
): Promise<void> {
  const existing = await getPlayer(id);
  if (!existing) throw new Error(`Unknown player ${id}`);
  const db = await getDb();

  await db.query("UPDATE players SET name = $1, phone = $2, notes = $3, active = $4 WHERE id = $5", [
    patch.name?.trim() ?? existing.name,
    patch.phone === undefined ? existing.phone : patch.phone?.trim() || null,
    patch.notes === undefined ? existing.notes : patch.notes?.trim() || null,
    patch.active ?? existing.active,
    id,
  ]);
}

/**
 * Change a player's rating and record why. The history is the point: ratings
 * drift over a season and an admin needs to see how a player got where they are.
 */
export async function setPlayerRating(
  id: string,
  newRating: number,
  admin: string,
  reason?: string | null,
  options: { snap?: boolean } = {},
): Promise<void> {
  const existing = await getPlayer(id);
  if (!existing) throw new Error(`Unknown player ${id}`);

  // Manual changes come off a quarter-point dropdown and are snapped. Changes
  // derived from results are not: they legitimately land between steps.
  const rating = (options.snap ?? true) ? normaliseRating(newRating) : clampRating(newRating);
  if (rating === existing.rating) return;

  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query("UPDATE players SET rating = $1 WHERE id = $2", [rating, id]);
    await tx.query(
      `INSERT INTO rating_changes (id, player_id, previous_rating, new_rating, changed_at, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId(), id, existing.rating, rating, nowIso(), admin, reason?.trim() || null],
    );
  });
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

export async function listRatingHistory(playerId: string): Promise<RatingChange[]> {
  const db = await getDb();
  // The seq tiebreak matters: two changes in the same millisecond share a
  // timestamp, and without it the newest-first order — and so the rating shown
  // as current — would be arbitrary.
  const { rows } = await db.query<RatingChangeRow>(
    `SELECT * FROM rating_changes WHERE player_id = $1
     ORDER BY changed_at DESC, seq DESC`,
    [playerId],
  );
  return rows.map((row) => ({
    id: row.id,
    playerId: row.player_id,
    previousRating: row.previous_rating === null ? null : Number(row.previous_rating),
    newRating: Number(row.new_rating),
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
  cost_per_player: number;
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

async function courtsFor(sessionId: string): Promise<CourtBooking[]> {
  const db = await getDb();
  const { rows } = await db.query<CourtRow>(
    `SELECT court_number, start_minutes, slot_count FROM session_courts
     WHERE session_id = $1 ORDER BY court_number`,
    [sessionId],
  );
  return rows.map((row) => ({
    courtNumber: row.court_number,
    startMinutes: row.start_minutes,
    slotCount: row.slot_count,
  }));
}

async function toSession(row: SessionRow): Promise<Session> {
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    startMinutes: row.start_minutes,
    slotCount: row.slot_count,
    courts: await courtsFor(row.id),
    costPerPlayer: row.cost_per_player,
    currency: row.currency,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    createdBy: row.created_by,
    ratingsAppliedAt: row.ratings_applied_at,
  };
}

export async function listSessions(): Promise<Session[]> {
  const db = await getDb();
  const { rows } = await db.query<SessionRow>(
    "SELECT * FROM sessions ORDER BY date DESC, start_minutes DESC",
  );
  return Promise.all(rows.map(toSession));
}

export async function getSession(id: string): Promise<Session | null> {
  const db = await getDb();
  const { rows } = await db.query<SessionRow>("SELECT * FROM sessions WHERE id = $1", [id]);
  const row = rows[0];
  return row ? toSession(row) : null;
}

export async function createSession(
  input: {
    name: string;
    date: string;
    startMinutes: number;
    slotCount: number;
    courts: CourtBooking[];
    costPerPlayer: number;
    currency?: string;
  },
  admin: string,
): Promise<Session> {
  const db = await getDb();
  const id = newId();

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO sessions
         (id, name, date, start_minutes, slot_count, cost_per_player, currency, status, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9)`,
      [
        id,
        input.name.trim(),
        input.date,
        input.startMinutes,
        input.slotCount,
        input.costPerPlayer,
        input.currency ?? "EUR",
        nowIso(),
        admin,
      ],
    );
    await writeCourts(tx, id, input.courts);
  });

  const created = await getSession(id);
  if (!created) throw new Error("Failed to create session");
  return created;
}

async function writeCourts(tx: SqlClient, sessionId: string, courts: CourtBooking[]): Promise<void> {
  await tx.query("DELETE FROM session_courts WHERE session_id = $1", [sessionId]);
  for (const court of courts) {
    await tx.query(
      `INSERT INTO session_courts (session_id, court_number, start_minutes, slot_count)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, court.courtNumber, court.startMinutes, court.slotCount],
    );
  }
}

export async function updateSession(
  id: string,
  patch: {
    name?: string;
    date?: string;
    startMinutes?: number;
    slotCount?: number;
    courts?: CourtBooking[];
    costPerPlayer?: number;
    currency?: string;
    status?: SessionStatus;
  },
): Promise<void> {
  const existing = await getSession(id);
  if (!existing) throw new Error(`Unknown session ${id}`);
  const db = await getDb();

  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE sessions SET name = $1, date = $2, start_minutes = $3, slot_count = $4,
         cost_per_player = $5, currency = $6, status = $7 WHERE id = $8`,
      [
        patch.name?.trim() ?? existing.name,
        patch.date ?? existing.date,
        patch.startMinutes ?? existing.startMinutes,
        patch.slotCount ?? existing.slotCount,
        patch.costPerPlayer ?? existing.costPerPlayer,
        patch.currency ?? existing.currency,
        patch.status ?? existing.status,
        id,
      ],
    );
    if (patch.courts) await writeCourts(tx, id, patch.courts);
  });
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDb();
  await db.query("DELETE FROM sessions WHERE id = $1", [id]);
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

export async function listSignups(sessionId: string): Promise<Signup[]> {
  const db = await getDb();
  const { rows } = await db.query<SignupRow>(
    "SELECT * FROM signups WHERE session_id = $1 ORDER BY queue_position, id",
    [sessionId],
  );
  return rows.map(toSignup);
}

/** Adds a signup at the back of the queue, which is what signing up means. */
export async function addSignup(input: {
  sessionId: string;
  playerId: string;
  requestedSlots: number;
  earliestStartMinutes: number;
  note?: string | null;
}): Promise<Signup> {
  const db = await getDb();
  const { rows: nextRows } = await db.query<{ next: number }>(
    "SELECT COALESCE(MAX(queue_position), 0) + 1 AS next FROM signups WHERE session_id = $1",
    [input.sessionId],
  );

  const id = newId();
  const { rows } = await db.query<SignupRow>(
    `INSERT INTO signups
       (id, session_id, player_id, requested_slots, earliest_start_minutes, status, queue_position, payment_method, note)
     VALUES ($1, $2, $3, $4, $5, 'CONFIRMED', $6, NULL, $7)
     RETURNING *`,
    [
      id,
      input.sessionId,
      input.playerId,
      input.requestedSlots,
      input.earliestStartMinutes,
      Number(nextRows[0]?.next ?? 1),
      input.note?.trim() || null,
    ],
  );

  const row = rows[0];
  if (!row) throw new Error("Failed to create signup");
  return toSignup(row);
}

export async function updateSignup(
  id: string,
  patch: {
    requestedSlots?: number;
    earliestStartMinutes?: number;
    status?: SignupStatus;
    paymentMethod?: PaymentMethod | null;
    note?: string | null;
  },
): Promise<void> {
  const db = await getDb();
  const { rows } = await db.query<SignupRow>("SELECT * FROM signups WHERE id = $1", [id]);
  const row = rows[0];
  if (!row) throw new Error(`Unknown signup ${id}`);

  await db.query(
    `UPDATE signups SET requested_slots = $1, earliest_start_minutes = $2, status = $3,
       payment_method = $4, note = $5 WHERE id = $6`,
    [
      patch.requestedSlots ?? row.requested_slots,
      patch.earliestStartMinutes ?? row.earliest_start_minutes,
      patch.status ?? row.status,
      patch.paymentMethod === undefined ? row.payment_method : patch.paymentMethod,
      patch.note === undefined ? row.note : patch.note?.trim() || null,
      id,
    ],
  );
}

export async function removeSignup(id: string): Promise<void> {
  const db = await getDb();
  await db.query("DELETE FROM signups WHERE id = $1", [id]);
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

export async function listMatches(sessionId: string): Promise<Match[]> {
  const db = await getDb();
  const { rows } = await db.query<MatchRow>(
    "SELECT * FROM matches WHERE session_id = $1 ORDER BY slot_index, court_number",
    [sessionId],
  );
  return rows.map(toMatch);
}

/** Replaces a session's schedule wholesale, which is what regenerating means. */
export async function replaceMatches(sessionId: string, matches: Match[]): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.query("DELETE FROM matches WHERE session_id = $1", [sessionId]);
    // Scores are deliberately not carried over: a regenerated draw puts
    // different people on court, so any previously recorded result is void.
    for (const match of matches) {
      await tx.query(
        `INSERT INTO matches (id, session_id, slot_index, court_number, team_a1, team_a2, team_b1, team_b2)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newId(),
          sessionId,
          match.slotIndex,
          match.courtNumber,
          match.teamA[0],
          match.teamA[1],
          match.teamB[0],
          match.teamB[1],
        ],
      );
    }
  });
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
export async function listMatchRecords(excludeSessionId?: string): Promise<MatchRecord[]> {
  const db = await getDb();
  const { rows } = await db.query<MatchRecordRow>(
    `SELECT m.*, s.date FROM matches m
     JOIN sessions s ON s.id = m.session_id
     ${excludeSessionId ? "WHERE m.session_id <> $1" : ""}
     ORDER BY s.date, m.slot_index`,
    excludeSessionId ? [excludeSessionId] : [],
  );

  return rows.map((row) => ({
    sessionId: row.session_id,
    date: row.date,
    slotIndex: row.slot_index,
    courtNumber: row.court_number,
    teamA: [row.team_a1, row.team_a2] as const,
    teamB: [row.team_b1, row.team_b2] as const,
  }));
}

export async function buildHistoryIndex(excludeSessionId?: string): Promise<HistoryIndex> {
  return new HistoryIndex(await listMatchRecords(excludeSessionId));
}

/* ----------------------------------------------------------------- scores -- */

/**
 * Record the games each team won in one block.
 *
 * Identified by slot and court rather than by match id, because ids are
 * reissued whenever a draw is regenerated while "court 3 at 19:00" is what the
 * admin is actually looking at. Pass nulls to clear a score.
 */
export async function setMatchScore(
  sessionId: string,
  slotIndex: number,
  courtNumber: number,
  scoreA: number | null,
  scoreB: number | null,
): Promise<void> {
  // Bounded on purpose: a 30-minute block cannot yield more than a handful of
  // games, so "64" is a mistyped "6-4". Clamping keeps one slip from moving a
  // rating by the maximum the cap allows.
  const clean = (value: number | null) =>
    value === null || !Number.isFinite(value)
      ? null
      : Math.min(MAX_GAMES_PER_BLOCK, Math.max(0, Math.trunc(value)));

  const db = await getDb();
  await db.query(
    `UPDATE matches SET score_a = $1, score_b = $2
     WHERE session_id = $3 AND slot_index = $4 AND court_number = $5`,
    [clean(scoreA), clean(scoreB), sessionId, slotIndex, courtNumber],
  );
}

/**
 * Write the rating changes a session's results imply, once.
 *
 * Idempotent by design: the session records when its results were applied, and
 * a second attempt is refused rather than double-counting every game. Each
 * change lands in the rating history with the session named, so a player can
 * always see which night moved them.
 *
 * Applying is deliberately one-way, and there is no "un-apply". Re-running
 * would measure the same results against ratings those results have already
 * moved, counting every game twice. A wrong score after the fact is corrected
 * by editing the player's rating directly, which is audited in the history.
 */
export async function applyRatingChanges(
  sessionId: string,
  changes: PlayerRatingChange[],
  admin: string,
  sessionLabel: string,
): Promise<{ applied: number; alreadyApplied: boolean }> {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  if (session.ratingsAppliedAt) return { applied: 0, alreadyApplied: true };

  const material = changes.filter((change) => change.to !== change.from);

  for (const change of material) {
    const sign = change.delta > 0 ? "+" : "";
    await setPlayerRating(
      change.playerId,
      change.to,
      admin,
      `${sessionLabel}: ${sign}${change.delta.toFixed(2)} from ${change.gamesCounted} game${change.gamesCounted === 1 ? "" : "s"}`,
      { snap: false },
    );
  }

  const db = await getDb();
  await db.query("UPDATE sessions SET ratings_applied_at = $1 WHERE id = $2", [nowIso(), sessionId]);

  return { applied: material.length, alreadyApplied: false };
}

/* ------------------------------------------------------------- diagnostics -- */

export interface DatabaseProblem {
  /** The error code, where there is one. */
  code: string;
  /** Where the app tried to reach the database. */
  path: string;
  /** The underlying error, for an admin to read. */
  detail: string;
  /** What is most likely wrong, in plain words. */
  summary: string;
  /** What to do about it. */
  remedy: string;
}

/** A description of where the database lives, safe to show — never the password. */
export function databaseLocation(): string {
  const url = connectionString();
  if (!url) {
    const host = serverlessHost();
    // Naming the local directory on a serverless host is actively misleading:
    // it reads as "the database is there", when in fact there is no database.
    if (host) return `nowhere — DATABASE_URL is not set (running on ${host})`;
    return `${localDataDirectory()} (local PGlite, no DATABASE_URL set)`;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "the configured DATABASE_URL";
  }
}

/**
 * The error code, looked for in every place one hides.
 *
 * Not every failure here is a `NodeJS.ErrnoException`: PGlite fails inside
 * WebAssembly and can throw a plain object, and a driver may wrap the real
 * errno in `cause`. Reading only `.code` reported `UNKNOWN` for exactly the
 * failures that most needed naming.
 */
function errorCode(error: unknown, depth = 0): string {
  const like = error as { code?: unknown; errno?: unknown; cause?: unknown } | null | undefined;
  if (typeof like?.code === "string" && like.code) return like.code;
  if (typeof like?.errno === "string" && like.errno) return like.errno;
  if (like?.cause != null && like.cause !== error && depth < 4) {
    const inherited = errorCode(like.cause, depth + 1);
    if (inherited !== "UNKNOWN") return inherited;
  }
  return "UNKNOWN";
}

/**
 * The underlying error as text an admin can read.
 *
 * Anything can be thrown, and `String(value)` on a plain object gives
 * "[object Object]" — which is what the diagnostics page showed on a real
 * deployment, telling the reader nothing whatsoever.
 */
function errorDetail(error: unknown, depth = 0): string {
  if (typeof error === "string") return error;
  if (error == null) return "no further detail was available";

  if (error instanceof Error) {
    const cause =
      error.cause != null && error.cause !== error && depth < 3
        ? ` (caused by ${errorDetail(error.cause, depth + 1)})`
        : "";
    return `${error.message || error.name}${cause}`;
  }

  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}" && json !== "null") return json;
    } catch {
      // Circular, or something that refuses to serialise. Fall through.
    }
    const keys = Object.keys(error as object);
    return keys.length
      ? `a ${error.constructor?.name ?? "value"} carrying no message (${keys.join(", ")})`
      : `an empty ${error.constructor?.name ?? "object"} was thrown`;
  }

  return `${typeof error} was thrown: ${String(error)}`;
}

/**
 * Turn a failure to reach the database into something an admin can act on.
 *
 * Pure, so every branch is testable: most of these cannot be provoked on demand.
 */
export function describeDatabaseError(error: unknown, location: string): DatabaseProblem {
  const code = errorCode(error);
  const message = errorDetail(error);
  const base = { code, path: location, detail: message };
  const configured = Boolean(connectionString());
  const host = (error as { host?: string } | null)?.host ?? serverlessHost();

  /**
   * No connection string at all. The commonest cause by a distance is a
   * variable added to a hosting dashboard *after* the running deployment was
   * built, which does not reach it until the next deploy — so say that rather
   * than only "set DATABASE_URL", which the reader believes they have done.
   */
  const noConnectionString = (): DatabaseProblem =>
    host
      ? {
          ...base,
          summary: `DATABASE_URL is not set, so the app has nowhere to keep its data: ${host} gives it no writable disk of its own.`,
          remedy:
            "Add DATABASE_URL, a Postgres connection string, to the project's environment variables and then redeploy — a variable added after a deployment was built does not reach it until the next one. If it is already there, check it is enabled for the environment you are looking at: one set for Production only is missing from a preview URL, and a blank value counts as unset.",
        }
      : {
          ...base,
          summary: "No DATABASE_URL is set, and the local fallback database could not be opened.",
          remedy:
            "Set DATABASE_URL to a Postgres connection string, or check the local data directory is writable.",
        };

  if (code === "NO_DATABASE_URL") return noConnectionString();

  if (code === "WRONG_DATABASE_SCHEME") {
    const scheme = (error as { scheme?: string }).scheme ?? "unknown";
    const named =
      scheme === "mongodb" || scheme === "mongodb+srv"
        ? "MongoDB"
        : scheme === "mysql"
          ? "MySQL"
          : `a "${scheme}" database`;
    return {
      ...base,
      summary: `The connection string points at ${named}, but this app stores its data in Postgres.`,
      remedy:
        "Create a Postgres database and use its connection string instead. In a hosting dashboard it is usually listed under the provider's name rather than as 'Postgres' — Neon and Supabase are both Postgres.",
    };
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      ...base,
      summary: "The database host in DATABASE_URL could not be found.",
      remedy: "Check the hostname in DATABASE_URL. If the database was just created, it may still be starting.",
    };
  }
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ECONNRESET") {
    return {
      ...base,
      summary: "The database refused the connection or did not answer.",
      remedy:
        "Check the host and port in DATABASE_URL, and that the database allows connections from this app.",
    };
  }
  if (/password authentication failed|role .* does not exist/i.test(message)) {
    return {
      ...base,
      summary: "The database rejected the username or password.",
      remedy: "Check the credentials in DATABASE_URL. Copy it again from your database provider.",
    };
  }
  if (/database .* does not exist/i.test(message)) {
    return {
      ...base,
      summary: "That database name does not exist on the server.",
      remedy: "Check the path at the end of DATABASE_URL, or create the database.",
    };
  }
  if (/self.signed|certificate/i.test(message)) {
    return {
      ...base,
      summary: "The TLS certificate was rejected.",
      remedy: "Most hosted Postgres needs sslmode=require in DATABASE_URL.",
    };
  }
  if (/too many clients|connection limit/i.test(message)) {
    return {
      ...base,
      summary: "The database is out of connections.",
      remedy:
        "Use your provider's pooled connection string, and keep DATABASE_POOL_MAX at 1 on a serverless host.",
    };
  }
  // Last, because a connection string that is missing cannot have produced any
  // of the failures above, but it can produce anything at all down here.
  if (!configured) return noConnectionString();

  return {
    ...base,
    summary: "The database could not be reached.",
    remedy: "Check DATABASE_URL and that the database is running and reachable from here.",
  };
}

/**
 * Check the database can actually be reached, and explain it if not.
 *
 * Without this, an unreachable database produces a bare crash page: the error
 * throws out of the first query, nothing catches it, and Next replaces the
 * message with a generic string in production, so the admin is left with
 * "server error" and nothing to act on.
 *
 * A failed open caches nothing, so this keeps reporting until it is fixed and
 * starts working the moment it is.
 */
export async function databaseProblem(): Promise<DatabaseProblem | null> {
  try {
    const db = await getDb();
    await db.query("SELECT 1 AS ok");
    return null;
  } catch (error) {
    return describeDatabaseError(error, databaseLocation());
  }
}
