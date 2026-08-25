/**
 * The whole schema, applied on every boot. Every statement is idempotent so
 * starting the app is the only migration step there is — appropriate for a
 * single-club app with a handful of admins and one SQLite file.
 *
 * Money is stored in integer minor units (cents) and times as minutes from
 * midnight, matching the domain layer. Ratings are REAL because the classic
 * padel scale uses quarter points.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL,
  phone       TEXT,
  rating      REAL    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);

CREATE TABLE IF NOT EXISTS rating_changes (
  id              TEXT PRIMARY KEY,
  player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  previous_rating REAL,
  new_rating      REAL NOT NULL,
  changed_at      TEXT NOT NULL,
  changed_by      TEXT NOT NULL,
  reason          TEXT
);
CREATE INDEX IF NOT EXISTS idx_rating_changes_player ON rating_changes(player_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  name                 TEXT    NOT NULL,
  date                 TEXT    NOT NULL,
  start_minutes        INTEGER NOT NULL,
  slot_count           INTEGER NOT NULL,
  cost_per_court_slot  INTEGER NOT NULL DEFAULT 0,
  currency             TEXT    NOT NULL DEFAULT 'EUR',
  status               TEXT    NOT NULL DEFAULT 'OPEN',
  created_at           TEXT    NOT NULL,
  created_by           TEXT    NOT NULL,
  ratings_applied_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date DESC);

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
CREATE INDEX IF NOT EXISTS idx_signups_session ON signups(session_id, queue_position);

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
CREATE INDEX IF NOT EXISTS idx_matches_session ON matches(session_id, slot_index, court_number);
`;

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` leaves an
 * existing table alone, so a database created before these existed would never
 * gain them. SQLite has no `ADD COLUMN IF NOT EXISTS`, so each one is checked
 * against `PRAGMA table_info` and added only when missing.
 *
 * Additive only. Anything that rewrites existing rows needs a real migration
 * tool rather than this list.
 */
export const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: "matches", column: "score_a", type: "INTEGER" },
  { table: "matches", column: "score_b", type: "INTEGER" },
  { table: "sessions", column: "ratings_applied_at", type: "TEXT" },
];
