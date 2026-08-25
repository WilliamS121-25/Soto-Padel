import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA } from "./schema";
import { normaliseRating } from "@/domain/rating";
import type { MatchRecord } from "@/domain/history";
import { HistoryIndex } from "@/domain/history";
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

function open(): Database.Database {
  // The database path is configuration, so it cannot be known at build time.
  // The ignore comment tells the bundler that on purpose; without it the tracer
  // assumes the worst and copies the entire project into the server output.
  const path = resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH ?? "./data/soto-padel.db");
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
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
): void {
  const db = getDb();
  const existing = getPlayer(id);
  if (!existing) throw new Error(`Unknown player ${id}`);

  const rating = normaliseRating(newRating);
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
}

const toMatch = (row: MatchRow): Match => ({
  slotIndex: row.slot_index,
  courtNumber: row.court_number,
  teamA: [row.team_a1, row.team_a2] as const,
  teamB: [row.team_b1, row.team_b2] as const,
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
