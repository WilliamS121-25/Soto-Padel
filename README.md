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
steps**. Change a rating whenever a player's level moves; every change is kept
with the date, the reason and who made it, so you can see how someone got where
they are.

If your club uses a different scale, `RATING_SCALE_PRESETS` in
`src/domain/types.ts` has Playtomic-style 0.0–7.0 and a 1–10 ladder.

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

The app needs a Node host with a **persistent disk**, because the database is a
SQLite file. A small VPS, Fly.io with a volume, or Railway all work. Serverless
platforms that give you a fresh filesystem per request — Vercel included — will
lose the database between requests unless you move it to hosted Postgres first.

Back up by copying the SQLite file.

## What it deliberately does not do

- **It does not talk to WhatsApp.** It generates text you copy and paste. That
  needs no Business API, no approved templates, and no phone number.
- **It does not take payments.** It works out who owes what; the money moves
  through reception, Revolut or Playtomic as it does today.
- **It does not record scores.** History tracks who played with and against whom,
  which is what the draw needs. Ratings are changed by hand.
