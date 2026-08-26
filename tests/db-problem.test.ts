import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * An unreachable database used to produce a bare crash page. These check the
 * failure becomes something an admin can act on, and that nothing in the
 * message leaks the database password.
 */
let db: typeof import("@/db");
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "soto-padel-problem-"));
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  process.env.DATABASE_PATH = join(dir, "pg");
  (globalThis as { sotoPadelDb?: unknown }).sotoPadelDb = undefined;
  db = await import("@/db");
  // PGlite compiles and initialises WebAssembly on the first query, which takes
  // seconds on a cold cache. Doing it here rather than letting it land inside
  // the first test keeps that cost out of the per-test timeout.
  await db.listPlayers();
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DATABASE_URL;
});

describe("a healthy database", () => {
  it("reports no problem", async () => {
    expect(await db.databaseProblem()).toBeNull();
  });

  it("says where it is without a server involved", () => {
    expect(db.databaseLocation()).toContain("local PGlite");
    expect(db.databaseLocation()).toContain("no DATABASE_URL");
  });
});

describe("describing where the database lives", () => {
  it("never includes the password", () => {
    process.env.DATABASE_URL = "postgres://admin:hunter2@db.example.com:5432/soto";
    const shown = db.databaseLocation();
    expect(shown).not.toContain("hunter2");
    expect(shown).not.toContain("admin");
    expect(shown).toContain("db.example.com");
    expect(shown).toContain("/soto");
    delete process.env.DATABASE_URL;
  });

  it("copes with a connection string it cannot parse", () => {
    process.env.DATABASE_URL = "not a url at all";
    expect(db.databaseLocation()).toBe("the configured DATABASE_URL");
    delete process.env.DATABASE_URL;
  });
});

describe("explaining each way the connection can fail", () => {
  const explain = (code: string, message = `${code}: something went wrong`) =>
    db.describeDatabaseError(
      Object.assign(new Error(message), { code }),
      "postgres://db.example.com/soto",
    );

  it("tells a missing host apart from a refused connection", () => {
    expect(explain("ENOTFOUND").summary).toMatch(/could not be found/i);
    expect(explain("ECONNREFUSED").summary).toMatch(/refused|did not answer/i);
    expect(explain("ETIMEDOUT").summary).toMatch(/refused|did not answer/i);
  });

  it("recognises bad credentials from the message, not a code", () => {
    const problem = explain("", 'password authentication failed for user "admin"');
    expect(problem.summary).toMatch(/rejected the username or password/i);
    expect(problem.remedy).toMatch(/DATABASE_URL/);
  });

  it("recognises a missing database", () => {
    expect(explain("", 'database "soto" does not exist').summary).toMatch(/does not exist/i);
  });

  it("recognises a TLS rejection and names the usual fix", () => {
    const problem = explain("", "self-signed certificate in certificate chain");
    expect(problem.summary).toMatch(/certificate/i);
    expect(problem.remedy).toMatch(/sslmode=require/);
  });

  it("recognises connection exhaustion, which is the serverless failure mode", () => {
    const problem = explain("", "sorry, too many clients already");
    expect(problem.summary).toMatch(/out of connections/i);
    expect(problem.remedy).toMatch(/pooled/i);
    expect(problem.remedy).toMatch(/DATABASE_POOL_MAX/);
  });

  it("points at DATABASE_URL when nothing is configured at all", () => {
    delete process.env.DATABASE_URL;
    const problem = explain("EACCES");
    expect(problem.summary).toMatch(/No DATABASE_URL is set/i);
    expect(problem.remedy).toMatch(/Vercel|dashboard/i);
  });

  it("still gives something useful for an unrecognised error", () => {
    const problem = explain("EWEIRD");
    expect(problem.code).toBe("EWEIRD");
    expect(problem.summary).toBeTruthy();
    expect(problem.remedy).toMatch(/DATABASE_URL/);
  });

  it("always passes the underlying error through for an admin to read", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "EWEIRD"]) {
      expect(explain(code).detail).toContain(code);
      expect(explain(code).path).toBe("postgres://db.example.com/soto");
    }
  });
});

describe("a connection string for the wrong kind of database", () => {
  const explainScheme = (scheme: string) =>
    db.describeDatabaseError(
      Object.assign(
        new Error(`Connection string uses the "${scheme}" scheme; this app needs Postgres.`),
        { code: "WRONG_DATABASE_SCHEME", scheme },
      ),
      "the configured DATABASE_URL",
    );

  it("names MongoDB rather than failing obscurely", () => {
    for (const scheme of ["mongodb", "mongodb+srv"]) {
      const problem = explainScheme(scheme);
      expect(problem.summary).toContain("MongoDB");
      expect(problem.summary).toMatch(/this app stores its data in Postgres/i);
    }
  });

  it("names MySQL too", () => {
    expect(explainScheme("mysql").summary).toContain("MySQL");
  });

  it("says where to find a Postgres, since it is rarely listed as 'Postgres'", () => {
    const problem = explainScheme("mongodb+srv");
    expect(problem.remedy).toMatch(/Neon/);
    expect(problem.remedy).toMatch(/Supabase/);
  });

  it("still reports an unfamiliar scheme usefully", () => {
    expect(explainScheme("redis").summary).toContain('"redis"');
  });
});

describe("recognising a usable connection string", () => {
  it("accepts the Postgres schemes and rejects the rest", async () => {
    const { wrongSchemeIn } = await import("@/db/client");
    expect(wrongSchemeIn("postgres://u:p@host/db")).toBeNull();
    expect(wrongSchemeIn("postgresql://u:p@host/db")).toBeNull();
    expect(wrongSchemeIn("POSTGRES://u:p@host/db")).toBeNull();
    expect(wrongSchemeIn("mongodb+srv://u:p@cluster.mongodb.net/db")).toBe("mongodb+srv");
    expect(wrongSchemeIn("mysql://u:p@host/db")).toBe("mysql");
    expect(wrongSchemeIn("garbage")).toBe("garbage");
  });
});
