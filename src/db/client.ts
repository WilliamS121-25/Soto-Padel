import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The little bit of Postgres the app needs.
 *
 * Two implementations sit behind it. In production, node-postgres against
 * whatever `DATABASE_URL` points at — Neon, Supabase, Vercel Postgres or a
 * Postgres you run yourself. Locally and in tests, PGlite: real Postgres
 * compiled to WebAssembly, running in-process against a directory, so nobody
 * needs a database server installed to run or test the app.
 *
 * Both speak the same SQL. The point of the interface is that the repository
 * layer is written once and never knows which one it has.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /**
   * Run a script that may contain several statements, such as the schema.
   *
   * Separate from `query` because a parameterised query goes over the extended
   * protocol, which accepts exactly one statement — sending the schema through
   * it fails with "cannot insert multiple commands into a prepared statement".
   */
  exec(sql: string): Promise<void>;
  /**
   * Run several statements as one unit. The callback gets a client bound to the
   * transaction; anything thrown rolls the whole thing back.
   */
  transaction<T>(run: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/**
 * An environment variable, with blank treated as unset.
 *
 * A hosting dashboard will happily store an empty value, and a connection
 * string pasted out of a web page often arrives with a newline on the end.
 * `??` alone treats both as configuration: an empty DATABASE_PATH resolves to
 * the working directory, and an empty DATABASE_URL sends the app down the
 * node-postgres path with nothing to connect to.
 */
function env(name: string): string | undefined {
  const raw = process.env[name];
  const value = raw?.trim();
  return value ? value : undefined;
}

/** Where PGlite keeps its data when no DATABASE_URL is configured. */
export function localDataDirectory(): string {
  return resolve(/* turbopackIgnore: true */ env("DATABASE_PATH") ?? "./data/postgres");
}

/**
 * The serverless platform this is running on, if it is one.
 *
 * Worth knowing because those platforms give the app no writable disk, so the
 * local PGlite fallback cannot work there at all: without a DATABASE_URL the
 * app has nowhere to keep anything, and saying so is far more use than whatever
 * the failed fallback throws.
 */
export function serverlessHost(): string | null {
  if (env("VERCEL")) return "Vercel";
  if (env("AWS_LAMBDA_FUNCTION_NAME")) return "AWS Lambda";
  if (env("NETLIFY")) return "Netlify";
  if (env("K_SERVICE")) return "Cloud Run";
  return null;
}

/**
 * The scheme of a connection string, when it is not one this app can use.
 *
 * Worth checking explicitly rather than letting the driver fail: a MongoDB or
 * MySQL URL produces a confusing low-level error, and "you have connected the
 * wrong kind of database" is the single most likely thing to have gone wrong
 * when a connection string does not work at all.
 */
export function wrongSchemeIn(url: string): string | null {
  const scheme = (url.split(":")[0] ?? "").toLowerCase();
  if (scheme === "postgres" || scheme === "postgresql") return null;
  return scheme || "unknown";
}

export function connectionString(): string | undefined {
  // Vercel's Postgres integrations set POSTGRES_URL; most other hosts and the
  // Neon integration set DATABASE_URL. Accept either rather than making someone
  // rename a variable the platform wrote for them.
  return env("DATABASE_URL") ?? env("POSTGRES_URL");
}

/* ------------------------------------------------------------ node-postgres */

type PgPool = import("pg").Pool;
type PgPoolClient = import("pg").PoolClient;

function wrapPgClient(client: PgPoolClient): SqlClient {
  return {
    async query(text, params) {
      const result = await client.query(text, params as never[]);
      return { rows: result.rows };
    },
    async exec(sql) {
      // No parameters means the simple query protocol, which allows several
      // statements in one round trip.
      await client.query(sql);
    },
    // Already inside a transaction; nesting would need savepoints, which the
    // repository never asks for.
    async transaction(run) {
      return run(wrapPgClient(client));
    },
  };
}

function fromPool(pool: PgPool): SqlClient {
  return {
    async query(text, params) {
      const result = await pool.query(text, params as never[]);
      return { rows: result.rows };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await run(wrapPgClient(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          // The original error is the one worth reporting.
        });
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/* ------------------------------------------------------------------ PGlite  */

type PGliteInstance = import("@electric-sql/pglite").PGlite;

function fromPGlite(db: PGliteInstance): SqlClient {
  const client: SqlClient = {
    async query(text, params) {
      const result = await db.query(text, params as unknown[]);
      return { rows: result.rows as never[] };
    },
    async exec(sql) {
      await db.exec(sql);
    },
    // PGlite is a single connection, so the statements are already serialised
    // and BEGIN/COMMIT on it is the whole story.
    async transaction(run) {
      await db.query("BEGIN");
      try {
        const result = await run(client);
        await db.query("COMMIT");
        return result;
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {});
        throw error;
      }
    },
  };
  return client;
}

/* ------------------------------------------------------------------ opening */

export async function openClient(): Promise<SqlClient> {
  const url = connectionString();

  if (url) {
    const wrong = wrongSchemeIn(url);
    if (wrong) {
      throw Object.assign(
        new Error(`Connection string uses the "${wrong}" scheme; this app needs Postgres.`),
        { code: "WRONG_DATABASE_SCHEME", scheme: wrong },
      );
    }

    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: url,
      // Serverless runs many short-lived instances, so each one holds the
      // smallest pool it can and leans on the provider's own pooler. Raising
      // this on a serverless host is how you exhaust a Postgres connection
      // limit.
      max: Number(process.env.DATABASE_POOL_MAX ?? 1),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      // Hosted Postgres is TLS-only and uses certificates Node does not ship a
      // root for; the connection is still encrypted.
      ssl: url.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
    });
    return fromPool(pool);
  }

  const host = serverlessHost();
  if (host) {
    throw Object.assign(
      new Error(
        `DATABASE_URL is not set, and ${host} gives the app no writable disk to fall back on.`,
      ),
      { code: "NO_DATABASE_URL", host },
    );
  }

  const directory = localDataDirectory();
  mkdirSync(dirname(directory), { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  return fromPGlite(await PGlite.create(directory));
}
