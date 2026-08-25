import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
