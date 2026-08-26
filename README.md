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
cp .env.example .env       # then edit it — see below
npm run dev                # http://localhost:3000
```

`.env` needs two values before anyone can sign in:

| Variable | What it is |
| --- | --- |
| `ADMIN_PASSCODE` | The passcode you give the organisers. Until it is set, nobody can sign in. |
| `SESSION_SECRET` | Any long random string; signs the login cookie. Changing it signs everyone out. |
| `DATABASE_PATH` | Where the SQLite file lives. Defaults to `./data/soto-padel.db`. |

Generate a secret with `openssl rand -base64 32`.

Everyone signs in with the same passcode and types their own name. The name is
not a password — it just records who changed what, so rating history reads
sensibly.

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

The club charges for the courts it booked whether or not every seat was filled,
so the total is fixed and split in proportion to the games each person actually
played. Amounts are held as whole cents and the rounding remainder goes to the
largest shares, so the lines always add up to the total exactly.

Set the court cost per court per 30 minutes in the mixin setup.

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

The database is a SQLite file, so the one hard requirement is a host that gives
the app a **persistent disk**. Serverless platforms that hand each request a
fresh, read-only filesystem — **Vercel included** — cannot run it: the app comes
up, sign-in works because the login page touches no data, and then every page
behind it fails trying to open the database.

A `Dockerfile` is included and works on any of these.

### Fly.io

```bash
fly launch --no-deploy                          # create the app, keep fly.toml
fly volumes create soto_data --size 1 --region lhr
fly secrets set ADMIN_PASSCODE=... SESSION_SECRET=...
fly deploy
```

`fly.toml` already mounts the volume at `/data` and points `DATABASE_PATH` at it.

### Railway or Render

Point the service at this repo; both detect the `Dockerfile`. Then:

- attach a **volume / disk mounted at `/data`**
- set `ADMIN_PASSCODE` and `SESSION_SECRET`
- leave `DATABASE_PATH` as `/data/soto-padel.db` (the Dockerfile's default)

### A plain VPS

```bash
docker build -t soto-padel .
docker run -d --restart unless-stopped -p 80:3000 \
  -v /srv/soto-padel:/data \
  -e ADMIN_PASSCODE=... -e SESSION_SECRET=... \
  soto-padel
```

### Whichever you choose

- **Do not run more than one instance.** SQLite has a single writer and one
  volume; scaling out needs Postgres first (replace `src/db/index.ts`; the whole
  of `src/domain/` stays as it is).
- **Back up by copying the database file**, e.g.
  `fly ssh console -C "cp /data/soto-padel.db /data/backup.db"` then download it.
- Without `ADMIN_PASSCODE` and `SESSION_SECRET` set, nobody can sign in — the
  login page says which one is missing.

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
