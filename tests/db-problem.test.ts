import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A host that cannot give the app a writable disk used to produce a bare crash
 * page. These check the failure becomes something an admin can act on.
 */
let db: typeof import("@/db");
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "soto-padel-problem-"));
  // Deliberately broken first: a working connection is cached for the life of
  // the process, so it would mask everything after it.
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "");
  process.env.DATABASE_PATH = join(blocker, "data", "soto.db");
  db = await import("@/db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a database that cannot be opened", () => {
  it("is reported rather than thrown", () => {
    const problem = db.databaseProblem();
    expect(problem).not.toBeNull();
    expect(problem?.code).toBe("ENOTDIR");
    expect(problem?.path).toContain("blocker");
    expect(problem?.remedy).toMatch(/DATABASE_PATH|volume/i);
  });

  it("keeps reporting until it is fixed, then starts working", () => {
    expect(db.databaseProblem()).not.toBeNull();
    // A failed open caches nothing, so pointing it somewhere usable recovers.
    process.env.DATABASE_PATH = join(dir, "good", "soto.db");
    expect(db.databaseProblem()).toBeNull();
    expect(db.listSessions()).toEqual([]);
  });
});

describe("explaining each way it can fail", () => {
  const describe_ = (code: string) =>
    db.describeDatabaseError(
      Object.assign(new Error(`${code}: something went wrong`), { code }),
      "/data/soto-padel.db",
    );

  it("names the read-only filesystem case, which is what serverless hosts give you", () => {
    const problem = describe_("EROFS");
    expect(problem.summary).toMatch(/read-only/i);
    expect(problem.remedy).toMatch(/serverless/i);
    expect(problem.remedy).toMatch(/writable disk/i);
    // Nothing should suggest a setting can fix it, because none can.
    expect(problem.remedy).toMatch(/No environment variable will fix it/i);
  });

  it("tells a permissions problem apart from a missing path", () => {
    expect(describe_("EACCES").summary).toMatch(/not allowed to write/i);
    expect(describe_("EPERM").summary).toMatch(/not allowed to write/i);
    expect(describe_("ENOENT").summary).toMatch(/cannot be created/i);
    expect(describe_("ENOTDIR").summary).toMatch(/cannot be created/i);
  });

  it("says plainly when the disk is full", () => {
    expect(describe_("ENOSPC").summary).toMatch(/disk is full/i);
  });

  it("still gives something useful for an unrecognised error", () => {
    const problem = describe_("EWEIRD");
    expect(problem.code).toBe("EWEIRD");
    expect(problem.summary).toBeTruthy();
    expect(problem.remedy).toMatch(/DATABASE_PATH/);
  });

  it("always passes the underlying error through for an admin to read", () => {
    for (const code of ["EROFS", "EACCES", "ENOSPC", "EWEIRD"]) {
      expect(describe_(code).detail).toContain(code);
      expect(describe_(code).path).toBe("/data/soto-padel.db");
    }
  });
});
