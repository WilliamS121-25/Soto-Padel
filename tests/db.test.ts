import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ratingChangesFromResults } from "@/domain/rating-updates";
import { parseTime } from "@/domain/time";

/**
 * These run against real Postgres — PGlite, compiled to WebAssembly and running
 * in-process against a temp directory, so no database server is needed. The
 * module is imported lazily so the environment is set before it connects.
 */
let db: typeof import("@/db");
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "soto-padel-test-"));
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  process.env.DATABASE_PATH = join(dir, "pg");
  db = await import("@/db");
  // PGlite compiles and initialises WebAssembly on the first query, which takes
  // seconds on a cold cache. Doing it here rather than letting it land inside
  // the first test keeps that cost out of the per-test timeout.
  await db.listPlayers();
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("players", () => {
  it("creates a player and records the starting rating", async () => {
    const player = await db.createPlayer({ name: "Ana Lopez", rating: 3.5, phone: "+34600" }, "will");
    expect(player.name).toBe("Ana Lopez");
    expect(player.rating).toBe(3.5);
    expect(player.active).toBe(true);

    const history = await db.listRatingHistory(player.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ previousRating: null, newRating: 3.5, changedBy: "will" });
  });

  it("snaps an off-scale rating on the way in", async () => {
    const player = await db.createPlayer({ name: "Off Scale", rating: 4.31 }, "will");
    expect(player.rating).toBe(4.25);
  });

  it("records every rating change with who and why", async () => {
    const player = await db.createPlayer({ name: "Improver", rating: 3 }, "will");
    await db.setPlayerRating(player.id, 3.25, "will", "Won the Americano");
    await db.setPlayerRating(player.id, 3.5, "maria", "Levelled up");

    expect((await db.getPlayer(player.id))?.rating).toBe(3.5);
    const history = await db.listRatingHistory(player.id);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({
      previousRating: 3.25,
      newRating: 3.5,
      changedBy: "maria",
      reason: "Levelled up",
    });
  });

  it("orders same-millisecond changes definitely, not arbitrarily", async () => {
    const player = await db.createPlayer({ name: "Rapid", rating: 3 }, "will");
    // Fast enough to share a timestamp; the sequence column is what separates them.
    await db.setPlayerRating(player.id, 3.25, "will", "first");
    await db.setPlayerRating(player.id, 3.5, "will", "second");
    await db.setPlayerRating(player.id, 3.75, "will", "third");

    const history = await db.listRatingHistory(player.id);
    expect(history.map((h) => h.reason)).toEqual(["third", "second", "first", "Initial rating"]);
    expect(history[0]?.newRating).toBe((await db.getPlayer(player.id))?.rating);
  });

  it("does not log a change that changes nothing", async () => {
    const player = await db.createPlayer({ name: "Steady", rating: 4 }, "will");
    await db.setPlayerRating(player.id, 4, "will", "no change");
    expect(await db.listRatingHistory(player.id)).toHaveLength(1);
  });

  it("hides deactivated players unless asked for them", async () => {
    const player = await db.createPlayer({ name: "Moved Away", rating: 4 }, "will");
    await db.updatePlayer(player.id, { active: false });

    expect((await db.listPlayers()).map((p) => p.id)).not.toContain(player.id);
    expect((await db.listPlayers(true)).map((p) => p.id)).toContain(player.id);
  });
});

describe("sessions and their courts", () => {
  it("round-trips staggered court bookings", async () => {
    const session = await db.createSession(
      {
        name: "Friday Mixin",
        date: "2025-08-29",
        startMinutes: parseTime("18:00"),
        slotCount: 4,
        costPerCourtSlot: 600,
        courts: [
          { courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: 4 },
          { courtNumber: 3, startMinutes: parseTime("19:00"), slotCount: 3 },
        ],
      },
      "will",
    );

    const loaded = await db.getSession(session.id);
    expect(loaded?.courts).toEqual([
      { courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: 4 },
      { courtNumber: 3, startMinutes: parseTime("19:00"), slotCount: 3 },
    ]);
    expect(loaded?.status).toBe("OPEN");
    expect(loaded?.currency).toBe("EUR");
  });

  it("replaces the court selection when it is edited", async () => {
    const session = await db.createSession(
      {
        name: "Edit Me",
        date: "2025-09-05",
        startMinutes: parseTime("18:00"),
        slotCount: 2,
        costPerCourtSlot: 600,
        courts: [{ courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: 2 }],
      },
      "will",
    );

    await db.updateSession(session.id, {
      courts: [
        { courtNumber: 2, startMinutes: parseTime("18:30"), slotCount: 2 },
        { courtNumber: 5, startMinutes: parseTime("18:30"), slotCount: 2 },
      ],
      status: "CLOSED",
    });

    const loaded = await db.getSession(session.id);
    expect(loaded?.courts.map((c) => c.courtNumber)).toEqual([2, 5]);
    expect(loaded?.status).toBe("CLOSED");
  });

  it("takes its signups and matches with it when deleted", async () => {
    const session = await db.createSession(
      {
        name: "Doomed",
        date: "2025-09-06",
        startMinutes: parseTime("18:00"),
        slotCount: 1,
        costPerCourtSlot: 600,
        courts: [{ courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: 1 }],
      },
      "will",
    );
    const player = await db.createPlayer({ name: "Doomed Player", rating: 4 }, "will");
    await db.addSignup({
      sessionId: session.id,
      playerId: player.id,
      requestedSlots: 1,
      earliestStartMinutes: parseTime("18:00"),
    });

    await db.deleteSession(session.id);
    expect(await db.getSession(session.id)).toBeNull();
    expect(await db.listSignups(session.id)).toEqual([]);
    // The player survives; only the session's own rows go.
    expect(await db.getPlayer(player.id)).not.toBeNull();
  });
});

describe("signups", () => {
  async function emptySession(name: string, slots = 4) {
    return db.createSession(
      {
        name,
        date: "2025-09-12",
        startMinutes: parseTime("18:00"),
        slotCount: slots,
        costPerCourtSlot: 600,
        courts: [{ courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: slots }],
      },
      "will",
    );
  }

  it("adds each player to the back of the queue", async () => {
    const session = await emptySession("Queue Test");
    const first = await db.createPlayer({ name: "First", rating: 4 }, "will");
    const second = await db.createPlayer({ name: "Second", rating: 4 }, "will");

    await db.addSignup({
      sessionId: session.id,
      playerId: first.id,
      requestedSlots: 4,
      earliestStartMinutes: parseTime("18:00"),
    });
    await db.addSignup({
      sessionId: session.id,
      playerId: second.id,
      requestedSlots: 2,
      earliestStartMinutes: parseTime("19:00"),
    });

    const signups = await db.listSignups(session.id);
    expect(signups.map((s) => s.queuePosition)).toEqual([1, 2]);
    expect(signups[1]).toMatchObject({
      playerId: second.id,
      requestedSlots: 2,
      earliestStartMinutes: parseTime("19:00"),
      status: "CONFIRMED",
      paymentMethod: null,
    });
  });

  it("stores the chosen payment method and withdrawals", async () => {
    const session = await emptySession("Payment Test", 2);
    const player = await db.createPlayer({ name: "Payer", rating: 4 }, "will");
    const signup = await db.addSignup({
      sessionId: session.id,
      playerId: player.id,
      requestedSlots: 2,
      earliestStartMinutes: parseTime("18:00"),
    });

    await db.updateSignup(signup.id, { paymentMethod: "REVOLUT" });
    expect((await db.listSignups(session.id))[0]?.paymentMethod).toBe("REVOLUT");

    await db.updateSignup(signup.id, { status: "WITHDRAWN" });
    expect((await db.listSignups(session.id))[0]?.status).toBe("WITHDRAWN");
  });

  it("refuses to sign the same player up twice", async () => {
    const session = await emptySession("Dupe Test", 2);
    const player = await db.createPlayer({ name: "Twice", rating: 4 }, "will");
    const args = {
      sessionId: session.id,
      playerId: player.id,
      requestedSlots: 2,
      earliestStartMinutes: parseTime("18:00"),
    };
    await db.addSignup(args);
    await expect(db.addSignup(args)).rejects.toThrow();
  });
});

describe("matches and history", () => {
  it("saves a schedule, replaces it on regeneration, and builds history", async () => {
    const players = await Promise.all(
      ["A", "B", "C", "D"].map((n) => db.createPlayer({ name: `Hist ${n}`, rating: 4 }, "will")),
    );
    const ids = players.map((p) => p.id) as [string, string, string, string];
    const session = await db.createSession(
      {
        name: "History Test",
        date: "2025-10-03",
        startMinutes: parseTime("18:00"),
        slotCount: 1,
        costPerCourtSlot: 600,
        courts: [{ courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: 1 }],
      },
      "will",
    );

    await db.replaceMatches(session.id, [
      { slotIndex: 0, courtNumber: 1, teamA: [ids[0], ids[1]], teamB: [ids[2], ids[3]] },
    ]);
    expect(await db.listMatches(session.id)).toHaveLength(1);

    // Regenerating must not stack a second draw on top of the first.
    await db.replaceMatches(session.id, [
      { slotIndex: 0, courtNumber: 1, teamA: [ids[0], ids[2]], teamB: [ids[1], ids[3]] },
    ]);
    const matches = await db.listMatches(session.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.teamA).toEqual([ids[0], ids[2]]);

    const history = await db.buildHistoryIndex();
    expect(history.partnerCount(ids[0], ids[2])).toBe(1);
    expect(history.partnerCount(ids[0], ids[1])).toBe(0);

    // Excluding the session being rescheduled leaves its own draw out.
    expect((await db.buildHistoryIndex(session.id)).partnerCount(ids[0], ids[2])).toBe(0);
  });
});

describe("scores and automatic rating changes", () => {
  async function makeScoredSession(name: string, ratingValue = 4) {
    const players = await Promise.all(
      ["A", "B", "C", "D"].map((n) =>
        db.createPlayer({ name: `${name} ${n}`, rating: ratingValue }, "will"),
      ),
    );
    const ids = players.map((p) => p.id) as [string, string, string, string];
    const session = await db.createSession(
      {
        name,
        date: "2026-01-09",
        startMinutes: parseTime("18:00"),
        slotCount: 1,
        costPerCourtSlot: 600,
        courts: [{ courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: 1 }],
      },
      "will",
    );
    await db.replaceMatches(session.id, [
      { slotIndex: 0, courtNumber: 1, teamA: [ids[0], ids[1]], teamB: [ids[2], ids[3]] },
    ]);
    return { session, ids };
  }

  async function changesFor(sessionId: string) {
    const matches = await db.listMatches(sessionId);
    const players = await db.listPlayers(true);
    return ratingChangesFromResults(
      matches.map((m) => ({
        teamA: m.teamA,
        teamB: m.teamB,
        gamesA: m.scoreA ?? 0,
        gamesB: m.scoreB ?? 0,
      })),
      new Map(players.map((p) => [p.id, p.rating])),
    );
  }

  it("stores and clears a score", async () => {
    const { session } = await makeScoredSession("Score Store");
    expect((await db.listMatches(session.id))[0]?.scoreA).toBeNull();

    await db.setMatchScore(session.id, 0, 1, 6, 3);
    expect((await db.listMatches(session.id))[0]).toMatchObject({ scoreA: 6, scoreB: 3 });

    await db.setMatchScore(session.id, 0, 1, null, null);
    expect((await db.listMatches(session.id))[0]?.scoreA).toBeNull();
  });

  it("rejects a mistyped score rather than letting it wreck a rating", async () => {
    const { session } = await makeScoredSession("Typo Guard");
    await db.setMatchScore(session.id, 0, 1, 64, -3);
    expect((await db.listMatches(session.id))[0]).toMatchObject({ scoreA: 20, scoreB: 0 });
  });

  it("wipes scores when the draw is regenerated", async () => {
    const { session, ids } = await makeScoredSession("Regen Wipe");
    await db.setMatchScore(session.id, 0, 1, 6, 3);

    await db.replaceMatches(session.id, [
      { slotIndex: 0, courtNumber: 1, teamA: [ids[0], ids[2]], teamB: [ids[1], ids[3]] },
    ]);
    expect((await db.listMatches(session.id))[0]?.scoreA).toBeNull();
  });

  it("applies rating changes once and records why in the history", async () => {
    const { session, ids } = await makeScoredSession("Apply Once");
    await db.setMatchScore(session.id, 0, 1, 6, 1);

    const result = await db.applyRatingChanges(
      session.id,
      await changesFor(session.id),
      "will",
      "Apply Once (2026-01-09)",
    );
    expect(result).toMatchObject({ alreadyApplied: false });
    expect(result.applied).toBeGreaterThan(0);

    expect((await db.getPlayer(ids[0]))!.rating).toBeGreaterThan(4);
    expect((await db.getPlayer(ids[2]))!.rating).toBeLessThan(4);

    const history = await db.listRatingHistory(ids[0]);
    expect(history[0]?.reason).toContain("Apply Once");
    expect(history[0]?.reason).toMatch(/from 1 game/);
    expect(history[0]?.changedBy).toBe("will");
    expect((await db.getSession(session.id))?.ratingsAppliedAt).not.toBeNull();
  });

  it("refuses to apply the same results twice", async () => {
    const { session, ids } = await makeScoredSession("Apply Twice");
    await db.setMatchScore(session.id, 0, 1, 6, 0);

    await db.applyRatingChanges(session.id, await changesFor(session.id), "will", "Apply Twice");
    const afterFirst = (await db.getPlayer(ids[0]))!.rating;
    const historyLength = (await db.listRatingHistory(ids[0])).length;

    const second = await db.applyRatingChanges(
      session.id,
      await changesFor(session.id),
      "will",
      "Apply Twice",
    );
    expect(second).toEqual({ applied: 0, alreadyApplied: true });
    expect((await db.getPlayer(ids[0]))!.rating).toBe(afterFirst);
    expect(await db.listRatingHistory(ids[0])).toHaveLength(historyLength);
  });

  it("stores an automatic rating off the quarter-point grid", async () => {
    const { session, ids } = await makeScoredSession("Off Grid", 4);
    await db.setMatchScore(session.id, 0, 1, 6, 4);
    await db.applyRatingChanges(session.id, await changesFor(session.id), "will", "Off Grid");

    // A manual change would snap to 4.25; a derived one keeps its real value.
    const rating = (await db.getPlayer(ids[0]))!.rating;
    expect(rating).toBeGreaterThan(4);
    expect(rating).toBeLessThan(4.25);
  });
});
