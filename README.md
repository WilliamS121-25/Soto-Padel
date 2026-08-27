# Soto Padel — mixin admin

A small web app for running the club's social padel mixin: take signups from the
WhatsApp group, keep a reserve list, draw level-matched line-ups that mix up
partners and opponents, and produce a payment schedule to paste back into the
group.

Built to be shared between a handful of organisers. One shared passcode, no
accounts to provision.

## Getting started

```bash
npm install
npm run dev                # http://localhost:3000
```

That is the whole setup. With no `DATABASE_URL` configured the app runs Postgres
**in-process** — PGlite, compiled to WebAssembly — against `./data/postgres`, so
there is no database server to install and nothing to configure.

**There is no sign-in.** Anyone who can reach the app can use it, and can read
and change everything in it — including player phone numbers, ratings and
payment schedules. Keep it on a private network, behind your host's access
control, or on a URL you only give to the organisers.

The name in the top right is recorded against changes so the rating history
reads sensibly. It is not a password and anyone can set it to anything.

## Running a mixin

1. **Create the mixin.** Date, start time, and how many half-hours it runs. Tick
   the courts you have booked. Each court has its own start time and length,
   because they are usually booked in staggered blocks — the mixin opens at 18:00
   on two courts and a third joins at 19:00.
2. **Open signups.** Copy the *Open for signups* message into the group. It
   states the courts, their real windows, and how many places there are.
3. **Take the replies.** Paste them into *Paste from WhatsApp*. It reads lines
   like `Ana — 3 — 18:30` and raw WhatsApp exports, in English or Spanish.
   Anything it cannot read is reported back rather than guessed. Players it has
   not seen before are created at the rating you pick on the form, and named in
   the summary so you can correct them.
4. **Post the update.** *Who is in, and places left* lists the confirmed
   players, the reserves in order, and the space remaining.
5. **Draw the line-ups.** Needs at least four confirmed players. *Re-draw
   differently* gives another valid draw if you do not like the first.
6. **Handle drop-outs.** Mark someone *can't attend* and the reserves move up
   automatically. If line-ups were already drawn, the app says they are out of
   date — redraw before sending anything out.
7. **Collect the money.** Set each person's payment method in the signups table,
   then copy the payment schedule. It groups people under Reception, Revolut and
   Playtomic, and chases anyone who has not chosen.
8. **Record the scores.** Type the games each team won next to each block. When
   you are done, *Apply these rating changes* moves everyone's rating based on
   how they actually played. You see exactly what will change before anything
   moves.

## How places are counted

Capacity is measured in **player-blocks**, not people. Every court seats four
players for every half-hour it is booked, so five courts for two hours is
5 × 4 × 4 = 80 player-blocks. Someone asking for four 30-minute games uses four
of them.

That is what makes a mixin work: twenty people playing four games each and forty
people playing two both fit the same courts. Places are given out in the order
people replied. When the next person in the queue does not fit, they go on the
reserve list; if someone further down needs less time and does fit, they can take
the space, and the person skipped keeps their place for the next opening.

## How the draw works

For each half-hour the app works out who is present and still owes games,
prioritises whoever is most at risk of not getting their full quota, groups them
by rating, then picks teams. It weighs four things against each other:

- how lopsided the two teams would be — weighted heaviest, because a one-sided
  game is the worst outcome for everyone on court
- how wide a spread of levels ends up in one four
- whether these two have partnered before
- whether these two have played against each other before

Repeat partners and opponents are counted across **every mixin recorded in the
app**, not just tonight, so the variety builds up over a season. The defaults were
chosen by measuring real draws across mixins of 12–28 players on 3–5 courts; on a
normal night they produce no repeat partnerships at all. They are in
`DEFAULT_WEIGHTS` in `src/domain/scheduler.ts` if you want to trade the balance
differently.

## Ratings

Ratings drive the matching. The default scale is the classic **1.0–7.0 in 0.25
steps**. Every change is kept with the date, the reason and who made it, so you
can always see how someone got where they are.

Ratings move two ways.

**By hand**, on the player's page, whenever you judge that someone's level has
moved. These land on clean quarter points.

**From results.** Enter the games each team won for each block, then apply the
changes at the end of the night. Three things shape how far a rating moves:

- **The margin, not just the win.** A 6-5 says far less than a 6-0.
- **Who you were playing.** Beating a stronger pair moves you more; beating a
  much weaker pair barely moves you at all. A result landing exactly where the
  ratings predicted moves nobody.
- **How much you played.** Every scored block counts, so a whole evening of
  over-performing adds up.

In practice, winning every block 6-3 against evenly matched pairs moves a player
about **0.17** over a four-game evening, so two or three such nights cross a
quarter-point step. A single session can never move a rating by more than
**0.5**, which stops one freak result rewriting someone's level. Ratings derived
this way are allowed to sit between steps: 4.09 is a real rating.

Two things worth knowing. Applying is a **one-way step per mixin** — the same
games cannot be counted twice, and a mistyped score is corrected afterwards by
editing that player's rating by hand. And regenerating a draw **clears any
scores on it**, because a new draw means those players never played that block.

If your club uses a different scale, `RATING_SCALE_PRESETS` in
`src/domain/types.ts` has Playtomic-style 0.0–7.0 and a 1–10 ladder. How fast
ratings move is `DEFAULT_RATING_UPDATE_OPTIONS` in
`src/domain/rating-updates.ts`.

## Payment

Set **the cost per person** in the mixin setup, and everyone who ends up on
court owes exactly that — someone who played two games pays the same as someone
who played six. Each line still shows the games played, because that is the
first thing anyone checks when a figure looks wrong.

Somebody confirmed who ended up in no match at all is not charged. Amounts are
held as whole cents, never as a float.

## Development

```bash
npm run check       # typecheck + tests
npm test            # tests only
npm run build       # production build
npm start           # serve the production build
```

Everything in `src/domain/` is plain TypeScript with no framework or database
dependency, and is where the real logic lives. It is covered by the tests in
`tests/`.

## Deployment

The app stores everything in Postgres. Give it a `DATABASE_URL` and it will run
anywhere, serverless included.

### Vercel

The app needs one environment variable, `DATABASE_URL`. Any Postgres will do.

Vercel offers databases through a marketplace of providers rather than its own
Postgres product, and that dashboard changes; if **Storage → Create Database**
offers a Postgres (Neon, Supabase and others appear there), take it, and Vercel
sets the connection string for you.

If it does not, set the variable yourself — this works whatever the dashboard
looks like:

1. Create a free Postgres at [neon.tech](https://neon.tech) or
   [supabase.com](https://supabase.com).
2. Copy the **pooled** connection string. On Neon that is the one with
   `-pooler` in the hostname; it matters on serverless, where every instance
   otherwise opens its own connection and exhausts the limit.
3. In Vercel: **Project → Settings → Environment Variables**, add
   `DATABASE_URL` with that value, for all environments.
4. **Redeploy.** This step is not optional: an environment variable added after
   a deployment was built does not reach it, and the running app carries on as
   though the variable were absent.

The schema is created on first boot. Nothing else is required — no other
secrets, no volume, no build configuration.

If the app cannot reach the database it says so on screen, naming the error and
what to change, with the credentials stripped out of the URL. Two things it
will tell you that are easy to miss otherwise: a variable set for Production
only is absent from a preview URL, and a variable stored with an empty value
counts as unset.

### Anywhere else, with a managed Postgres

Set `DATABASE_URL` (Neon, Supabase, Railway, RDS, or your own server) and run
the included `Dockerfile`:

```bash
docker build -t soto-padel .
docker run -d --restart unless-stopped -p 80:3000 \
  -e DATABASE_URL='postgres://...?sslmode=require' \
  soto-padel
```

### Anywhere else, with no database server

Leave `DATABASE_URL` unset and give the container a volume at `/data`; the app
runs Postgres in-process against it. This needs a real writable disk, so it is
for a host that has one — on a serverless platform the app refuses it and asks
for a `DATABASE_URL` instead, rather than failing part-way through a request. `fly.toml` is set up this way:

```bash
fly launch --no-deploy
fly volumes create soto_data --size 1 --region lhr
fly deploy
```

### Whichever you choose

- **On a serverless host, use your provider's pooled connection string** and
  leave `DATABASE_POOL_MAX` at 1. Every instance holds its own pool, and that is
  how a Postgres connection limit gets exhausted.
- **Do not run more than one instance against the in-process database.** It
  lives on one volume and has a single writer. Scaling out means `DATABASE_URL`.
- **Back up** with your provider's snapshots, or `pg_dump` against
  `DATABASE_URL`.
- **There is no sign-in**, so whoever can reach the URL can change everything.
  Put it behind your host's access control if that matters.

## What it deliberately does not do

- **It does not talk to WhatsApp.** It generates text you copy and paste. That
  needs no Business API, no approved templates, and no phone number.
- **It does not take payments.** It works out who owes what; the money moves
  through reception, Revolut or Playtomic as it does today.
- **It does not model full padel scoring.** A 30-minute block is recorded as
  the games each team won, not points, sets or tiebreaks. That is the only
  number an organiser realistically writes down, and it is all the rating
  maths needs.
- **It does not rank or run leagues.** There are no standings, no titles and no
  win-loss records - only ratings, which exist to make the next draw better.
