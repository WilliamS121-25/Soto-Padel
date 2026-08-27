/**
 * The whole schema, applied on every boot. Every statement is idempotent, so
 * starting the app is the only migration step there is — appropriate for a
 * single-club app with a handful of admins.
 *
 * Money is stored in integer minor units (cents) and times as minutes from
 * midnight, matching the domain layer. Ratings are `double precision` because
 * the classic padel scale uses quarter points and ratings derived from results
 * legitimately sit between them.
 *
 * Unlike SQLite, Postgres has `ADD COLUMN IF NOT EXISTS`, so columns added
 * after the first release go straight in the table definitions below and in
 * `ADDED_COLUMNS`; there is no need to inspect the catalogue first.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  name        TEXT             NOT NULL,
  phone       TEXT,
  rating      DOUBLE PRECISION NOT NULL,
  active      BOOLEAN          NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TEXT             NOT NULL
);

CREATE TABLE IF NOT EXISTS rating_changes (
  id              TEXT PRIMARY KEY,
  player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  previous_rating DOUBLE PRECISION,
  new_rating      DOUBLE PRECISION NOT NULL,
  changed_at      TEXT NOT NULL,
  changed_by      TEXT NOT NULL,
  reason          TEXT,
  -- Monotonic within a player, so two changes in the same millisecond still
  -- have a definite order. SQLite leaned on rowid for this; Postgres has no
  -- implicit one, so it is explicit.
  seq             BIGSERIAL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  name                 TEXT    NOT NULL,
  date                 TEXT    NOT NULL,
  start_minutes        INTEGER NOT NULL,
  slot_count           INTEGER NOT NULL,
  cost_per_player      INTEGER NOT NULL DEFAULT 0,
  currency             TEXT    NOT NULL DEFAULT 'EUR',
  status               TEXT    NOT NULL DEFAULT 'OPEN',
  created_at           TEXT    NOT NULL,
  created_by           TEXT    NOT NULL,
  ratings_applied_at   TEXT
);

CREATE TABLE IF NOT EXISTS session_courts (
  session_id    TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  court_number  INTEGER NOT NULL,
  start_minutes INTEGER NOT NULL,
  slot_count    INTEGER NOT NULL,
  PRIMARY KEY (session_id, court_number)
);

CREATE TABLE IF NOT EXISTS signups (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id              TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  requested_slots        INTEGER NOT NULL,
  earliest_start_minutes INTEGER NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'CONFIRMED',
  queue_position         INTEGER NOT NULL,
  payment_method         TEXT,
  note                   TEXT,
  UNIQUE (session_id, player_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id           TEXT    PRIMARY KEY,
  session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  slot_index   INTEGER NOT NULL,
  court_number INTEGER NOT NULL,
  team_a1      TEXT    NOT NULL REFERENCES players(id),
  team_a2      TEXT    NOT NULL REFERENCES players(id),
  team_b1      TEXT    NOT NULL REFERENCES players(id),
  team_b2      TEXT    NOT NULL REFERENCES players(id),
  score_a      INTEGER,
  score_b      INTEGER
);
`;

/**
 * Columns added after a table first shipped. `CREATE TABLE IF NOT EXISTS`
 * leaves an existing table alone, so a database created by an earlier version
 * would never gain them.
 *
 * Additive only. Anything that rewrites existing rows needs a real migration
 * tool rather than this list.
 */
/**
 * Indexes, applied *after* the missing-column migration.
 *
 * The order matters and is not cosmetic: `CREATE TABLE IF NOT EXISTS` leaves an
 * existing table untouched, so on an upgrade the new columns do not exist yet
 * when this file's tables are declared. An index over one of them — the rating
 * history's `seq`, for instance — would fail with "column does not exist" and
 * take the whole boot down with it.
 */
export const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date DESC);
CREATE INDEX IF NOT EXISTS idx_rating_changes_player
  ON rating_changes(player_id, changed_at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_signups_session ON signups(session_id, queue_position);
CREATE INDEX IF NOT EXISTS idx_matches_session ON matches(session_id, slot_index, court_number);
`;

export const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: "matches", column: "score_a", type: "INTEGER" },
  { table: "matches", column: "score_b", type: "INTEGER" },
  { table: "sessions", column: "ratings_applied_at", type: "TEXT" },
  { table: "rating_changes", column: "seq", type: "BIGSERIAL" },
  // Replaced cost_per_court_slot, which a database created before the price
  // became per-head still carries. It is left in place rather than dropped:
  // the two are not convertible (a court rate divided by a head count nobody
  // recorded), so dropping it would destroy the only record of what the old
  // sessions were priced at.
  { table: "sessions", column: "cost_per_player", type: "INTEGER NOT NULL DEFAULT 0" },
];
