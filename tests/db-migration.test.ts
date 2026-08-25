import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Safe to import at the top: it is pure and never opens a connection.
import { ratingChangesFromResults } from "@/domain/rating-updates";

/**
 * Opens a database created by the version that predates score recording and
 * checks it is upgraded in place, with its existing rows intact. Migrations are
 * where data quietly disappears, so this is worth its own file.
 */
let db: typeof import("@/db");
let dir: string;
let dbPath: string;

const OLD_SCHEMA = `
CREATE TABLE players (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, rating REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, notes TEXT, created_at TEXT NOT NULL
);
CREATE TABLE rating_changes (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL, previous_rating REAL,
  new_rating REAL NOT NULL, changed_at TEXT NOT NULL, changed_by TEXT NOT NULL, reason TEXT
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, date TEXT NOT NULL,
  start_minutes INTEGER NOT NULL, slot_count INTEGER NOT NULL,
  cost_per_court_slot INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL DEFAULT 'OPEN', created_at TEXT NOT NULL, created_by TEXT NOT NULL
);
CREATE TABLE session_courts (
  session_id TEXT NOT NULL, court_number INTEGER NOT NULL,
  start_minutes INTEGER NOT NULL, slot_count INTEGER NOT NULL,
  PRIMARY KEY (session_id, court_number)
);
CREATE TABLE signups (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, player_id TEXT NOT NULL,
  requested_slots INTEGER NOT NULL, earliest_start_minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONFIRMED', queue_position INTEGER NOT NULL,
  payment_method TEXT, note TEXT, UNIQUE (session_id, player_id)
);
CREATE TABLE matches (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, slot_index INTEGER NOT NULL,
  court_number INTEGER NOT NULL, team_a1 TEXT NOT NULL, team_a2 TEXT NOT NULL,
  team_b1 TEXT NOT NULL, team_b2 TEXT NOT NULL
);
`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "soto-padel-migrate-"));
  dbPath = join(dir, "old.db");

  // Build a database exactly as the previous version left it, with real data.
  const old = new Database(dbPath);
  old.exec(OLD_SCHEMA);
  const insertPlayer = old.prepare(
    "INSERT INTO players (id, name, phone, rating, active, notes, created_at) VALUES (?, ?, NULL, ?, 1, NULL, ?)",
  );
  for (const [id, name, rating] of [
    ["p1", "Legacy Ana", 3.5],
    ["p2", "Legacy Luis", 4],
    ["p3", "Legacy Marta", 4.25],
    ["p4", "Legacy Javi", 3.75],
  ] as const) {
    insertPlayer.run(id, name, rating, "2025-08-01T00:00:00.000Z");
  }
  old.prepare(
    `INSERT INTO sessions (id, name, date, start_minutes, slot_count, cost_per_court_slot, currency, status, created_at, created_by)
     VALUES ('s1', 'Legacy Mixin', '2025-08-29', 1080, 1, 600, 'EUR', 'COMPLETE', '2025-08-01T00:00:00.000Z', 'will')`,
  ).run();
  old.prepare(
    "INSERT INTO session_courts (session_id, court_number, start_minutes, slot_count) VALUES ('s1', 1, 1080, 1)",
  ).run();
  old.prepare(
    `INSERT INTO matches (id, session_id, slot_index, court_number, team_a1, team_a2, team_b1, team_b2)
     VALUES ('m1', 's1', 0, 1, 'p1', 'p2', 'p3', 'p4')`,
  ).run();
  old.close();

  process.env.DATABASE_PATH = dbPath;
  db = await import("@/db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("upgrading a database from before score recording", () => {
  it("keeps the existing players, session and match", () => {
    expect(db.listPlayers(true).map((p) => p.name)).toContain("Legacy Ana");
    expect(db.getSession("s1")?.name).toBe("Legacy Mixin");
    expect(db.listMatches("s1")).toHaveLength(1);
    expect(db.listMatches("s1")[0]?.teamA).toEqual(["p1", "p2"]);
  });

  it("adds the new columns with empty values rather than failing to read", () => {
    expect(db.listMatches("s1")[0]?.scoreA).toBeNull();
    expect(db.listMatches("s1")[0]?.scoreB).toBeNull();
    expect(db.getSession("s1")?.ratingsAppliedAt).toBeNull();
  });

  it("can record a score against the migrated match", () => {
    db.setMatchScore("s1", 0, 1, 6, 2);
    expect(db.listMatches("s1")[0]).toMatchObject({ scoreA: 6, scoreB: 2 });
  });

  it("can apply rating changes on the migrated session", () => {
    const matches = db.listMatches("s1");
    const changes = ratingChangesFromResults(
      matches.map((m) => ({
        teamA: m.teamA,
        teamB: m.teamB,
        gamesA: m.scoreA ?? 0,
        gamesB: m.scoreB ?? 0,
      })),
      new Map(db.listPlayers(true).map((p) => [p.id, p.rating])),
    );
    const result = db.applyRatingChanges("s1", changes, "will", "Legacy Mixin");
    expect(result.alreadyApplied).toBe(false);
    expect(result.applied).toBeGreaterThan(0);
    expect(db.getSession("s1")?.ratingsAppliedAt).not.toBeNull();
  });

  it("is safe to open twice — the migration does not re-run destructively", async () => {
    const before = db.listMatches("s1")[0];
    const reopened = new Database(dbPath);
    const columns = reopened
      .prepare("PRAGMA table_info(matches)")
      .all()
      .map((row) => (row as { name: string }).name);
    reopened.close();

    expect(columns.filter((c) => c === "score_a")).toHaveLength(1);
    expect(db.listMatches("s1")[0]).toEqual(before);
  });
});
