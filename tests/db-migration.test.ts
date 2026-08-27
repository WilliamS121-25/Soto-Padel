import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { ratingChangesFromResults } from "@/domain/rating-updates";

/**
 * Opens a database created by a version that predates score recording and
 * checks it is upgraded in place with its rows intact. Migrations are where
 * data quietly disappears, so this is worth its own file.
 */
let db: typeof import("@/db");
let dir: string;

/** The schema as it stood before scores, the applied marker and the sequence. */
const OLD_SCHEMA = `
CREATE TABLE players (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, rating DOUBLE PRECISION NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE, notes TEXT, created_at TEXT NOT NULL
);
CREATE TABLE rating_changes (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL, previous_rating DOUBLE PRECISION,
  new_rating DOUBLE PRECISION NOT NULL, changed_at TEXT NOT NULL, changed_by TEXT NOT NULL, reason TEXT
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
  const dataDir = join(dir, "pg");

  // Build a database exactly as the previous version left it, with real rows.
  const old = await PGlite.create(dataDir);
  await old.exec(OLD_SCHEMA);
  for (const [id, name, rating] of [
    ["p1", "Legacy Ana", 3.5],
    ["p2", "Legacy Luis", 4],
    ["p3", "Legacy Marta", 4.25],
    ["p4", "Legacy Javi", 3.75],
  ] as const) {
    await old.query(
      "INSERT INTO players (id, name, phone, rating, active, notes, created_at) VALUES ($1, $2, NULL, $3, TRUE, NULL, $4)",
      [id, name, rating, "2025-08-01T00:00:00.000Z"],
    );
  }
  await old.exec(`
    INSERT INTO sessions (id, name, date, start_minutes, slot_count, cost_per_court_slot, currency, status, created_at, created_by)
    VALUES ('s1', 'Legacy Mixin', '2025-08-29', 1080, 1, 600, 'EUR', 'COMPLETE', '2025-08-01T00:00:00.000Z', 'will');
    INSERT INTO session_courts (session_id, court_number, start_minutes, slot_count) VALUES ('s1', 1, 1080, 1);
    INSERT INTO matches (id, session_id, slot_index, court_number, team_a1, team_a2, team_b1, team_b2)
    VALUES ('m1', 's1', 0, 1, 'p1', 'p2', 'p3', 'p4');
  `);
  await old.close();

  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  process.env.DATABASE_PATH = dataDir;
  // The connection is cached per process, so make sure this file opens its own.
  (globalThis as { sotoPadelDb?: unknown }).sotoPadelDb = undefined;
  db = await import("@/db");
  // PGlite compiles and initialises WebAssembly on the first query, which takes
  // seconds on a cold cache. Doing it here rather than letting it land inside
  // the first test keeps that cost out of the per-test timeout.
  await db.listPlayers();
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("upgrading a database from before score recording", () => {
  it("keeps the existing players, session and match", async () => {
    expect((await db.listPlayers(true)).map((p) => p.name)).toContain("Legacy Ana");
    expect((await db.getSession("s1"))?.name).toBe("Legacy Mixin");
    const matches = await db.listMatches("s1");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.teamA).toEqual(["p1", "p2"]);
  });

  it("adds the new columns with empty values rather than failing to read", async () => {
    const match = (await db.listMatches("s1"))[0];
    expect(match?.scoreA).toBeNull();
    expect(match?.scoreB).toBeNull();
    expect((await db.getSession("s1"))?.ratingsAppliedAt).toBeNull();
  });

  it("can record a score against the migrated match", async () => {
    await db.setMatchScore("s1", 0, 1, 6, 2);
    expect((await db.listMatches("s1"))[0]).toMatchObject({ scoreA: 6, scoreB: 2 });
  });

  it("can apply rating changes on the migrated session", async () => {
    const matches = await db.listMatches("s1");
    const players = await db.listPlayers(true);
    const changes = ratingChangesFromResults(
      matches.map((m) => ({
        teamA: m.teamA,
        teamB: m.teamB,
        gamesA: m.scoreA ?? 0,
        gamesB: m.scoreB ?? 0,
      })),
      new Map(players.map((p) => [p.id, p.rating])),
    );
    const result = await db.applyRatingChanges("s1", changes, "will", "Legacy Mixin");
    expect(result.alreadyApplied).toBe(false);
    expect(result.applied).toBeGreaterThan(0);
    expect((await db.getSession("s1"))?.ratingsAppliedAt).not.toBeNull();
  });

  it("backfills the ordering column so old rating history still reads newest-first", async () => {
    // The migrated rows predate `seq`; new ones must still sort above them.
    await db.setPlayerRating("p1", 3.75, "will", "after the upgrade");
    const history = await db.listRatingHistory("p1");
    expect(history[0]?.reason).toBe("after the upgrade");
  });

  /**
   * The per-head price replaced a per-court-per-30-min rate. The two are not
   * convertible, so an old session comes through unpriced and the organiser
   * retypes it — but the old column is still there, still NOT NULL, and every
   * insert has to keep working over the top of it.
   */
  describe("the move from a court rate to a price per head", () => {
    it("gains the new column, unpriced rather than wrongly priced", async () => {
      expect((await db.getSession("s1"))?.costPerPlayer).toBe(0);
    });

    it("keeps the old court rate rather than destroying it", async () => {
      const client = await db.getDb();
      const { rows } = await client.query<{ cost_per_court_slot: number }>(
        "SELECT cost_per_court_slot FROM sessions WHERE id = 's1'",
      );
      expect(rows[0]?.cost_per_court_slot).toBe(600);
    });

    it("takes a price for the migrated session", async () => {
      await db.updateSession("s1", { costPerPlayer: 1250 });
      expect((await db.getSession("s1"))?.costPerPlayer).toBe(1250);
    });

    it("can still create a session, though nothing supplies the old column", async () => {
      // It is NOT NULL on an upgraded database and the insert no longer names
      // it, so this only works because of its default. Exactly the kind of
      // thing that passes on a fresh database and fails on a real one.
      const created = await db.createSession(
        {
          name: "After the upgrade",
          date: "2025-09-05",
          startMinutes: 1080,
          slotCount: 2,
          courts: [{ courtNumber: 1, startMinutes: 1080, slotCount: 2 }],
          costPerPlayer: 1000,
          currency: "EUR",
        },
        "will",
      );
      expect((await db.getSession(created.id))?.costPerPlayer).toBe(1000);
    });
  });

  it("gains the player fields, unset rather than guessed", async () => {
    const legacy = (await db.listPlayers(true)).find((p) => p.name === "Legacy Ana");
    expect(legacy?.gender).toBeNull();
    expect(legacy?.similarLevelOnly).toBe(false);

    // And they are writable on a migrated row.
    await db.updatePlayer(legacy!.id, { gender: "FEMALE", similarLevelOnly: true });
    expect(await db.getPlayer(legacy!.id)).toMatchObject({
      gender: "FEMALE",
      similarLevelOnly: true,
    });
  });

  it("is safe to apply again — the migration does not repeat destructively", async () => {
    const before = await db.listMatches("s1");
    // Re-running the same additive statements must be a no-op.
    const client = await db.getDb();
    await client.exec("ALTER TABLE matches ADD COLUMN IF NOT EXISTS score_a INTEGER");
    expect(await db.listMatches("s1")).toEqual(before);
  });

  it("can unwind the ratings it applied, and skips the one changed by hand since", async () => {
    // By this point the suite has applied this mixin's results to all four
    // players and then edited p1 by hand. Deleting the mixin must put the three
    // untouched players back and leave p1's later judgement standing.
    const before = new Map(
      (await db.listPlayers(true)).map((player) => [player.id, player.rating]),
    );

    const outcome = await db.deleteSession("s1", { revertRatings: true });

    expect(outcome.revertedRatings.map((r) => r.playerId).sort()).toEqual(["p2", "p3", "p4"]);
    expect(outcome.keptRatings.map((r) => r.playerId)).toEqual(["p1"]);
    expect((await db.getPlayer("p1"))!.rating).toBe(before.get("p1"));
    for (const id of ["p2", "p3", "p4"]) {
      expect((await db.getPlayer(id))!.rating).not.toBe(before.get(id));
    }
  });
});
