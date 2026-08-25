# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repository.

## What this is

A web app for running the social padel mixin at Soto Padel: a club organiser
takes signups from a WhatsApp group, keeps a reserve list, draws level-matched
line-ups that mix up partners and opponents, and produces a payment schedule to
paste back into the group. It is shared between a handful of admins behind one
passcode.

`README.md` explains the product and how a mixin is run. This file covers how the
code is arranged and the conventions to follow.

## Stack

| | |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack), React 19 |
| Language | TypeScript, `strict` **and `noUncheckedIndexedAccess`** |
| Database | SQLite via `better-sqlite3`, one file, schema applied on boot |
| Tests | Vitest |
| Styling | One hand-written stylesheet, `src/app/globals.css`. No CSS framework. |
| Auth | Shared passcode + HMAC-signed cookie, `src/lib/auth.ts` |

There is no ESLint setup; `npm run check` (typecheck + tests) is the gate.

## Commands

| Task | Command |
| --- | --- |
| Install | `npm install` |
| Dev server | `npm run dev` |
| Typecheck | `npm run typecheck` |
| Tests | `npm test` (watch: `npm run test:watch`) |
| **Typecheck + tests** | `npm run check` — run this before committing |
| Production build | `npm run build` |
| Serve production build | `npm start` |

`ADMIN_PASSCODE` and `SESSION_SECRET` must be set or nobody can sign in — see
`.env.example`. The **build** does not need them: every route is server-rendered
on demand, so they are only read at request time. Do not add dummy values to CI.

CI (`.github/workflows/ci.yml`) runs `npm run check` then `npm run build` on
Node 22 for every pull request. It calls the `check` script rather than
inlining typecheck and test, so the CI gate cannot drift from the local one —
if you add a step to `check`, CI picks it up.

## Layout

```
src/
├── domain/     Pure logic. No framework, no database, no I/O.
├── db/         SQLite schema and repository functions.
├── lib/        auth.ts — passcode check and signed cookie.
└── app/        Next.js App Router: pages, server actions, client components.
tests/          Vitest suites, one per domain module, plus db.test.ts.
```

### `src/domain/` — where the real work happens

This is the important part of the codebase. It is plain TypeScript that can be
tested without a browser or a database, and **new logic belongs here rather than
in a page or an action**.

| Module | Responsibility |
| --- | --- |
| `types.ts` | Domain types, the five physical courts, payment methods, rating scales |
| `time.ts` | Minutes-from-midnight helpers, slot ranges, date formatting |
| `timeline.ts` | The 30-minute grid, per-court windows, capacity |
| `rating.ts` | Scale validation, snapping, bands |
| `signups.ts` | Place allocation, reserve queue, promotion on withdrawal |
| `scheduler.ts` | Draw generation, round reconstruction, stale-draw detection |
| `history.ts` | Partner and opponent counts across sessions |
| `rating-updates.ts` | Turning recorded scores into rating changes |
| `payments.ts` | Cost split, money formatting and parsing |
| `whatsapp.ts` | The four copy-paste message builders |
| `parse-signups.ts` | Reading pasted WhatsApp text |

## Ideas the code is built on

Get these four and the rest follows.

**1. Capacity is player-blocks, not people.** Every court seats four players for
every half-hour it is booked. Five courts for two hours is 5 × 4 × 4 = 80
player-blocks, and someone asking for four games consumes four of them. Nothing
in the app has a "maximum number of players" — see `computeCapacity`.

**2. Every court has its own window.** A court is `{ courtNumber, startMinutes,
slotCount }`, independent of the session's own start time, because courts get
booked in staggered blocks. `buildTimeline` spans the union of the advertised
window and every court's window, so a court booked outside the advertised hours
is still scheduled. Never assume court start equals session start.

**3. Confirmed vs reserve is derived, never stored.** `signups.status` only
distinguishes withdrawn from active. Who is *in* is recomputed by
`allocateSignups` on every render from queue order and current capacity. This is
deliberate: add a court and the reserves are promoted with no extra code, and the
lists can never drift out of step with capacity. Do not add a code path that
writes `CONFIRMED`/`RESERVE` as though it were the source of truth.

**4. A saved draw goes stale.** Signups keep moving after the line-ups are drawn.
`detectScheduleDrift` compares a saved draw against the current confirmed list,
and the session page refuses to let that pass silently — the payment split is
derived from the draw, so a stale draw means the wrong people are being charged.

**5. Ratings derived from results are applied once, deliberately.** Scores are
recorded per match as games won; `ratingChangesFromResults` turns them into
per-player deltas, and `applyRatingChanges` writes them exactly once per session
(guarded by `sessions.ratings_applied_at`). Two consequences to respect:

- Every block is judged against the ratings players held *before* the session,
  never against ratings the same evening already moved. Otherwise the order
  scores were typed in would change the answer.
- There is no un-apply. Re-running would measure results against ratings those
  results already moved, double-counting every game. Doing it safely needs a
  stored pre-session baseline; until then, a wrong score is corrected by editing
  the player's rating by hand, which is audited like any other change.

## Conventions

- **Money is integer minor units (cents).** Never a float. Parse with
  `parseMoney`, render with `formatMoney`. Any split must add up to the total
  exactly; `buildPaymentSchedule` hands the rounding remainder to the largest
  shares.
- **Times are minutes from midnight**, integers. Dates are `YYYY-MM-DD` strings
  in the club's local calendar and are never timezone-converted. `formatDateLong`
  uses a fixed name table on purpose, so output does not shift with the host
  timezone or ICU data.
- **Manual ratings snap; derived ratings do not.** `normaliseRating` snaps to the
  scale's step for the manual dropdown. `clampRating` only bounds, and is what
  `setPlayerRating(..., { snap: false })` uses for changes derived from results —
  a night's play might move someone 0.13, and snapping that would either
  overstate it or throw it away. A rating of 4.09 is legitimate.
- **The scheduler is deterministic.** No seed means the same input always gives
  the same draw. A seed changes the draw ("re-draw differently") through a small
  PRNG, never `Math.random()`.
- **Nothing is sent anywhere.** Messages are text for the admin to copy. Do not
  add an outbound integration without being asked.
- **Do not guess on the user's behalf.** `parse-signups.ts` returns `null` plus a
  note in `problems` when it cannot read a field. The import summary names every
  player it created so ratings can be checked. Keep that posture: a wrong rating
  silently invented corrupts every future draw.
- **`noUncheckedIndexedAccess` is on.** Array and `Map` access is
  `T | undefined`. Handle it; do not reach for `!` to shut it up.
- Server actions live in `src/app/actions.ts`, all guarded by `requireAdmin()`.
  They validate, then redirect back with `?notice=` or `?error=`, which the pages
  render. Client components are only used where interactivity is genuinely
  needed: `court-picker.tsx` and `copy-button.tsx`.

## Testing

Around 130 tests. Domain modules are tested directly; `tests/db.test.ts` runs
against a real SQLite file in a temp directory, importing `@/db` lazily so
`DATABASE_PATH` is set before the connection opens. `tests/fixtures.ts` has
builders — `makeSession`, `makeSignup`, `ladder` (n players spread over a rating
range), `court`.

When changing the scheduler, do not assert on an exact draw. Assert the
properties that matter: everyone gets the games they asked for, no repeat
partnerships when there is room to avoid them, each four stays close in level,
teams within a four stay balanced, late arrivals do not appear in early rounds.

When changing the rating maths, assert properties rather than exact numbers
where you can: a draw moves nobody, a single match is zero-sum, both players in a
pair move identically, entry order cannot change the outcome, the session cap and
the ends of the scale both hold. One number worth pinning is the magnitude for a
typical evening — it is what stops a well-meaning tweak making the whole feature
inert, which is exactly what an early `k` of 0.08 did.

**The scheduler's weights were tuned by measurement, not taste.** They were swept
across five mixin shapes (12–28 players, 3–5 courts) comparing repeat
partnerships, worst level spread and worst team gap. If you change
`DEFAULT_WEIGHTS`, re-measure across several shapes rather than one — a single
scenario sits inside the hill-climb's run-to-run noise, and tuning on it fits
noise rather than quality.

## Things worth knowing before changing something

- The database schema in `src/db/schema.ts` is one idempotent script applied on
  every boot. There is no migration tool. Additive changes are safe; anything
  that rewrites existing data needs a real migration story first.
- `CREATE TABLE IF NOT EXISTS` will not add a column to a table that already
  exists, so columns added after the first release go in the `ADDED_COLUMNS` list
  and are applied by `addMissingColumns` on boot after checking
  `PRAGMA table_info`. Add to that list when adding a column, or existing
  databases will not gain it. `tests/db-migration.test.ts` opens a database built
  on the pre-scores schema and checks it upgrades with its rows intact.
- Regenerating a draw clears its scores (`replaceMatches` writes no score
  columns). That is intended: a new draw puts different people on court, so an
  old result is void.
- `session_courts` is keyed on `(session_id, court_number)`, so a court can hold
  one window per mixin. Two separate windows for the same court on the same night
  would need that key relaxed. `buildTimeline` already copes.
- The database path is read from `DATABASE_PATH` at connection time and carries a
  `/* turbopackIgnore: true */` comment. Removing it makes the bundler trace the
  whole project into the server output.
- `better-sqlite3` is native and listed in `serverExternalPackages` in
  `next.config.ts`. It must not be bundled.
- Deployment needs a persistent disk. Serverless platforms with an ephemeral
  filesystem will lose the database; moving to Postgres means replacing
  `src/db/index.ts`, and the domain layer would not need to change.
- `signups.note` is stored and accepted by `addSignup`, but no form supplies it
  yet. It is a spare field, not dead code to delete on sight.

## Assumptions that were never confirmed

Flagged so they are not mistaken for requirements:

- The rating scale defaults to classic 1.0–7.0 in 0.25 steps. "Classic padel
  rating system" was the request; the scale is configurable via
  `RATING_SCALE_PRESETS` in case the club means something else.
- Cost is modelled as a price per court per 30 minutes, split by games played.
  Per-player pricing or peak/off-peak rates would need a change.
- Auth is one shared passcode. Anyone with it can act as any name. Fine for a
  few organisers, not fine if this ever holds anything sensitive.
- Nothing tracks whether a payment was actually collected — only the schedule.
- A 30-minute block is scored as games won per team, capped at
  `MAX_GAMES_PER_BLOCK`. Points, sets and tiebreaks are not modelled.
- How fast ratings move (`DEFAULT_RATING_UPDATE_OPTIONS`) was calibrated against
  measured cases, not against real club data. Watch it over a few real nights
  before trusting the pace, and change `k` or `maxSessionChange` rather than
  reaching for a different algorithm.

## Maintaining this file

Update it in the same commit as the change that invalidates it: a new command, a
new top-level directory, a new domain module, or a change to one of the four
ideas above. Keep it about what is not obvious from reading the code.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
