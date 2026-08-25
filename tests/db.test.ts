import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ratingChangesFromResults } from "@/domain/rating-updates";
import { parseTime } from "@/domain/time";

/**
 * These run against a real SQLite file in a temp directory. The module is
 * imported lazily so DATABASE_PATH is set before the connection opens.
 */
let db: typeof import("@/db");
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "soto-padel-test-"));
  process.env.DATABASE_PATH = join(dir, "test.db");
  db = await import("@/db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("players", () => {
  it("creates a player and records the starting rating", () => {
    const player = db.createPlayer({ name: "Ana Lopez", rating: 3.5, phone: "+34600" }, "will");
    expect(player.name).toBe("Ana Lopez");
    expect(player.rating).toBe(3.5);
    expect(player.active).toBe(true);

    const history = db.listRatingHistory(player.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ previousRating: null, newRating: 3.5, changedBy: "will" });
  });

  it("snaps an off-scale rating on the way in", () => {
    const player = db.createPlayer({ name: "Off Scale", rating: 4.31 }, "will");
    expect(player.rating).toBe(4.25);
  });

  it("records every rating change with who and why", () => {
    const player = db.createPlayer({ name: "Improver", rating: 3 }, "will");
    db.setPlayerRating(player.id, 3.25, "will", "Won the Americano");
    db.setPlayerRating(player.id, 3.5, "maria", "Levelled up");

    expect(db.getPlayer(player.id)?.rating).toBe(3.5);
    const history = db.listRatingHistory(player.id);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({
      previousRating: 3.25,
      newRating: 3.5,
      changedBy: "maria",
      reason: "Levelled up",
    });
  });

  it("does not log a change that changes nothing", () => {
    const player = db.createPlayer({ name: "Steady", rating: 4 }, "will");
    db.setPlayerRating(player.id, 4, "will", "no change");
    expect(db.listRatingHistory(player.id)).toHaveLength(1);
  });

  it("hides deactivated players unless asked for them", () => {
    const player = db.createPlayer({ name: "Moved Away", rating: 4 }, "will");
    db.updatePlayer(player.id, { active: false });

    expect(db.listPlayers().map((p) => p.id)).not.toContain(player.id);
    expect(db.listPlayers(true).map((p) => p.id)).toContain(player.id);
  });
});

describe("sessions and their courts", () => {
  it("round-trips staggered court bookings", () => {
    const session = db.createSession(
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

    const loaded = db.getSession(session.id);
    expect(loaded?.courts).toEqual([
      { courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: 4 },
      { courtNumber: 3, startMinutes: parseTime("19:00"), slotCount: 3 },
    ]);
    expect(loaded?.status).toBe("OPEN");
    expect(loaded?.currency).toBe("EUR");
  });

  it("replaces the court selection when it is edited", () => {
    const session = db.createSession(
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

    db.updateSession(session.id, {
      courts: [
        { courtNumber: 2, startMinutes: parseTime("18:30"), slotCount: 2 },
        { courtNumber: 5, startMinutes: parseTime("18:30"), slotCount: 2 },
      ],
      status: "CLOSED",
    });

    const loaded = db.getSession(session.id);
    expect(loaded?.courts.map((c) => c.courtNumber)).toEqual([2, 5]);
    expect(loaded?.status).toBe("CLOSED");
  });
});

describe("signups", () => {
  it("adds each player to the back of the queue", () => {
    const session = db.createSession(
      {
        name: "Queue Test",
        date: "2025-09-12",
        startMinutes: parseTime("18:00"),
        slotCount: 4,
        costPerCourtSlot: 600,
        courts: [{ courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: 4 }],
      },
      "will",
    );
    const first = db.createPlayer({ name: "First", rating: 4 }, "will");
    const second = db.createPlayer({ name: "Second", rating: 4 }, "will");

    db.addSignup({
      sessionId: session.id,
      playerId: first.id,
      requestedSlots: 4,
      earliestStartMinutes: parseTime("18:00"),
    });
    db.addSignup({
      sessionId: session.id,
      playerId: second.id,
      requestedSlots: 2,
      earliestStartMinutes: parseTime("19:00"),
    });

    const signups = db.listSignups(session.id);
    expect(signups.map((s) => s.queuePosition)).toEqual([1, 2]);
    expect(signups[1]).toMatchObject({
      playerId: second.id,
      requestedSlots: 2,
      earliestStartMinutes: parseTime("19:00"),
      status: "CONFIRMED",
      paymentMethod: null,
    });
  });

  it("stores the chosen payment method and withdrawals", () => {
    const session = db.createSession(
      {
        name: "Payment Test",
        date: "2025-09-19",
        startMinutes: parseTime("18:00"),
        slotCount: 2,
        costPerCourtSlot: 600,
        courts: [{ courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: 2 }],
      },
      "will",
    );
    const player = db.createPlayer({ name: "Payer", rating: 4 }, "will");
    const signup = db.addSignup({
      sessionId: session.id,
      playerId: player.id,
      requestedSlots: 2,
      earliestStartMinutes: parseTime("18:00"),
    });

    db.updateSignup(signup.id, { paymentMethod: "REVOLUT" });
    expect(db.listSignups(session.id)[0]?.paymentMethod).toBe("REVOLUT");

    db.updateSignup(signup.id, { status: "WITHDRAWN" });
    expect(db.listSignups(session.id)[0]?.status).toBe("WITHDRAWN");
  });

  it("refuses to sign the same player up twice", () => {
    const session = db.createSession(
      {
        name: "Dupe Test",
        date: "2025-09-26",
        startMinutes: parseTime("18:00"),
        slotCount: 2,
        costPerCourtSlot: 600,
        courts: [{ courtNumber: 1, startMinutes: parseTime("18:00"), slotCount: 2 }],
      },
      "will",
    );
    const player = db.createPlayer({ name: "Twice", rating: 4 }, "will");
    const args = {
      sessionId: session.id,
      playerId: player.id,
      requestedSlots: 2,
      earliestStartMinutes: parseTime("18:00"),
    };
    db.addSignup(args);
    expect(() => db.addSignup(args)).toThrow();
  });
});

describe("matches and history", () => {
  it("saves a schedule, replaces it on regeneration, and builds history", () => {
    const players = ["A", "B", "C", "D"].map((n) =>
      db.createPlayer({ name: `Hist ${n}`, rating: 4 }, "will"),
    );
    const ids = players.map((p) => p.id) as [string, string, string, string];
    const session = db.createSession(
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

    db.replaceMatches(session.id, [
      { slotIndex: 0, courtNumber: 1, teamA: [ids[0], ids[1]], teamB: [ids[2], ids[3]] },
    ]);
    expect(db.listMatches(session.id)).toHaveLength(1);

    // Regenerating must not stack a second draw on top of the first.
    db.replaceMatches(session.id, [
      { slotIndex: 0, courtNumber: 1, teamA: [ids[0], ids[2]], teamB: [ids[1], ids[3]] },
    ]);
    const matches = db.listMatches(session.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.teamA).toEqual([ids[0], ids[2]]);

    const history = db.buildHistoryIndex();
    expect(history.partnerCount(ids[0], ids[2])).toBe(1);
    expect(history.partnerCount(ids[0], ids[1])).toBe(0);

    // Excluding the session being rescheduled leaves its own draw out.
    expect(db.buildHistoryIndex(session.id).partnerCount(ids[0], ids[2])).toBe(0);
  });
});

describe("scores and automatic rating changes", () => {
  function makeScoredSession(name: string, ratingValue = 4) {
    const players = ["A", "B", "C", "D"].map((n) =>
      db.createPlayer({ name: `${name} ${n}`, rating: ratingValue }, "will"),
    );
    const ids = players.map((p) => p.id) as [string, string, string, string];
    const session = db.createSession(
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
    db.replaceMatches(session.id, [
      { slotIndex: 0, courtNumber: 1, teamA: [ids[0], ids[1]], teamB: [ids[2], ids[3]] },
    ]);
    return { session, ids };
  }

  it("stores and clears a score", () => {
    const { session } = makeScoredSession("Score Store");
    expect(db.listMatches(session.id)[0]?.scoreA).toBeNull();

    db.setMatchScore(session.id, 0, 1, 6, 3);
    expect(db.listMatches(session.id)[0]).toMatchObject({ scoreA: 6, scoreB: 3 });

    db.setMatchScore(session.id, 0, 1, null, null);
    expect(db.listMatches(session.id)[0]?.scoreA).toBeNull();
  });

  it("rejects a mistyped score rather than letting it wreck a rating", () => {
    const { session } = makeScoredSession("Typo Guard");
    db.setMatchScore(session.id, 0, 1, 64, -3);
    expect(db.listMatches(session.id)[0]).toMatchObject({ scoreA: 20, scoreB: 0 });
  });

  it("wipes scores when the draw is regenerated", () => {
    const { session, ids } = makeScoredSession("Regen Wipe");
    db.setMatchScore(session.id, 0, 1, 6, 3);

    db.replaceMatches(session.id, [
      { slotIndex: 0, courtNumber: 1, teamA: [ids[0], ids[2]], teamB: [ids[1], ids[3]] },
    ]);
    expect(db.listMatches(session.id)[0]?.scoreA).toBeNull();
  });

  it("applies rating changes once and records why in the history", () => {
    const { session, ids } = makeScoredSession("Apply Once");
    db.setMatchScore(session.id, 0, 1, 6, 1);

    const matches = db.listMatches(session.id);
    const changes = ratingChangesFromResults(
      matches.map((m) => ({
        teamA: m.teamA,
        teamB: m.teamB,
        gamesA: m.scoreA ?? 0,
        gamesB: m.scoreB ?? 0,
      })),
      new Map(db.listPlayers(true).map((p) => [p.id, p.rating])),
    );

    const result = db.applyRatingChanges(session.id, changes, "will", "Apply Once (2026-01-09)");
    expect(result).toMatchObject({ alreadyApplied: false });
    expect(result.applied).toBeGreaterThan(0);

    // Winners went up, losers came down.
    expect(db.getPlayer(ids[0])!.rating).toBeGreaterThan(4);
    expect(db.getPlayer(ids[2])!.rating).toBeLessThan(4);

    const history = db.listRatingHistory(ids[0]);
    expect(history[0]?.reason).toContain("Apply Once");
    expect(history[0]?.reason).toMatch(/from 1 game/);
    expect(history[0]?.changedBy).toBe("will");

    // The session now knows it has been applied.
    expect(db.getSession(session.id)?.ratingsAppliedAt).not.toBeNull();
  });

  it("refuses to apply the same results twice", () => {
    const { session, ids } = makeScoredSession("Apply Twice");
    db.setMatchScore(session.id, 0, 1, 6, 0);

    const build = () =>
      ratingChangesFromResults(
        db.listMatches(session.id).map((m) => ({
          teamA: m.teamA,
          teamB: m.teamB,
          gamesA: m.scoreA ?? 0,
          gamesB: m.scoreB ?? 0,
        })),
        new Map(db.listPlayers(true).map((p) => [p.id, p.rating])),
      );

    db.applyRatingChanges(session.id, build(), "will", "Apply Twice");
    const afterFirst = db.getPlayer(ids[0])!.rating;
    const historyLength = db.listRatingHistory(ids[0]).length;

    const second = db.applyRatingChanges(session.id, build(), "will", "Apply Twice");
    expect(second).toEqual({ applied: 0, alreadyApplied: true });
    expect(db.getPlayer(ids[0])!.rating).toBe(afterFirst);
    expect(db.listRatingHistory(ids[0])).toHaveLength(historyLength);
  });

  it("stores an automatic rating off the quarter-point grid", () => {
    const { session, ids } = makeScoredSession("Off Grid", 4);
    db.setMatchScore(session.id, 0, 1, 6, 4);
    const changes = ratingChangesFromResults(
      db.listMatches(session.id).map((m) => ({
        teamA: m.teamA,
        teamB: m.teamB,
        gamesA: m.scoreA ?? 0,
        gamesB: m.scoreB ?? 0,
      })),
      new Map(db.listPlayers(true).map((p) => [p.id, p.rating])),
    );
    db.applyRatingChanges(session.id, changes, "will", "Off Grid");

    // A manual change would snap to 4.25; a derived one keeps its real value.
    const rating = db.getPlayer(ids[0])!.rating;
    expect(rating).toBeGreaterThan(4);
    expect(rating).toBeLessThan(4.25);
  });
});
