# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repository.

> **⚠️ STATUS: GREENFIELD — NO CODE EXISTS YET.**
>
> As of **2026-08-25**, `WilliamS121-25/Soto-Padel` is an **empty repository**: zero
> commits, zero branches, zero files. This document is therefore a *scaffold*, not a
> description of a real codebase. Sections below are explicitly tagged:
>
> - **[VERIFIED]** — checked against the repo/session and true today.
> - **[ASSUMED]** — an inference that has **not** been confirmed by the project owner.
> - **[TODO]** — must be filled in once real code lands. Do not treat as fact.
>
> **If you are an AI assistant reading this: do not present [ASSUMED] or [TODO] content
> as established fact.** Verify before relying on it, and replace it with reality as
> soon as reality exists.

---

## 1. Project context

**[ASSUMED]** The name "Soto Padel" suggests a project relating to **padel** (the racquet
sport) — most plausibly a club/venue website or a court-booking and match-management
application. Nothing in the repository confirms this.

**[TODO]** Replace this section with the actual purpose. Answer, in one paragraph each:

- What problem does Soto Padel solve, and for whom? (Club owners? Players? Both?)
- Is it a public marketing site, a booking system, an internal admin tool, or several?
- Who are the users, and are there distinct roles (player, coach, admin, front desk)?
- Is there an existing product, spreadsheet, or manual process this replaces?

---

## 2. Current repository state

**[VERIFIED]** How this was determined, and how to re-verify:

```bash
git ls-remote origin        # returns nothing → remote has no refs
git log --all --oneline     # returns nothing → no commits
find .git/objects -type f   # returns nothing → no objects
```

The GitHub API confirms it independently, returning
`409 Git Repository is empty` for the repository root.

Consequences an assistant should expect:

- There is **no default branch** yet. `main` does not exist.
- `git status` / `git log` will error with *"does not have any commits yet"* until the
  first commit exists. This is normal here, not a broken checkout.
- Any request to "analyze the codebase", "run the tests", "fix the build", or "follow
  existing conventions" **cannot be satisfied from this repository**. Say so plainly
  rather than inventing an answer. If the code exists elsewhere, ask where.

---

## 3. Git and branch workflow

**[VERIFIED]** — this reflects how sessions in this repo are configured.

- **Remote:** `https://github.com/WilliamS121-25/Soto-Padel`
- **Work happens on a designated feature branch**, never directly on the default branch.
  Sessions are given an explicit branch name (for example
  `claude/claude-md-docs-osr188`); create it locally if it does not exist.
- **Never push to a branch other than the designated one** without explicit permission.
- Push with upstream tracking:

  ```bash
  git push -u origin <branch-name>
  ```

- On **network** failures only, retry the push up to 4 times with exponential backoff
  (2s, 4s, 8s, 16s). Do not retry on rejected/auth failures — diagnose those instead.
- Prefer fetching a specific branch: `git fetch origin <branch-name>`.
- **Do not open a pull request unless explicitly asked.**
- **Never rewrite history on a branch you did not create** (no rebase, amend, or
  force-push over someone else's work). A merge commit keeps their checkout valid.
- If the PR for a designated branch has **already been merged**, treat follow-up work as
  a fresh change: restart the branch from the latest default branch rather than stacking
  commits on merged history.

  ```bash
  git fetch origin <default-branch>
  git checkout -B <branch-name> origin/<default-branch>
  ```

  Exception: if the branch carries unmerged commits, rebase them onto the new base
  instead of discarding them.

### First-push caveat

**[VERIFIED]** Because the repository is empty, whichever branch is pushed first may
become GitHub's default branch. Once real work begins, create and push `main` (or the
project's chosen trunk) and set it as the default in repository settings, so feature
branches are not left acting as trunk.

---

## 4. Commit conventions

**[TODO]** Confirm with the project owner. Until decided, use these defaults:

- **Conventional Commits** — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`,
  `ci:`, `build:`. Optional scope: `feat(booking): ...`.
- Imperative mood, lower case after the colon, no trailing period.
- Subject ≤ 72 characters; body explains *why*, not *what* (the diff shows what).
- One logical change per commit. Don't mix a refactor with a behavior change.
- **Never** include an AI/model identifier in commit messages, PR titles or bodies, code
  comments, or any other committed artifact.

---

## 5. Technology stack

**[TODO] — NOT YET DECIDED. Do not assume a stack; ask.**

No `package.json`, `pyproject.toml`, `go.mod`, `Gemfile`, `pom.xml`, or any other
manifest exists. An assistant asked to add code here must get the stack decided first
rather than picking one silently — the choice is the owner's, and it is expensive to
reverse once dependencies and deploy config are committed.

Decisions to capture here once made:

| Decision | Value |
| --- | --- |
| Language(s) and version | [TODO] |
| Runtime / package manager (with lockfile committed) | [TODO] |
| Frontend framework | [TODO] |
| Backend / API style (REST, GraphQL, RPC) | [TODO] |
| Database + migration tool | [TODO] |
| Authentication approach | [TODO] |
| Test framework(s) | [TODO] |
| Lint / format tooling | [TODO] |
| CI provider and required checks | [TODO] |
| Hosting / deploy target | [TODO] |
| Payment provider, if bookings are paid | [TODO] |

---

## 6. Repository structure

**[TODO]** Document the real layout once it exists. Keep this as a map of *where things
go and why*, not an exhaustive `tree` dump — an assistant needs to know which directory
a new file belongs in.

For each top-level directory, record: what lives there, what must **not** live there, and
the module's owner/entry point.

---

## 7. Development commands

**[TODO]** Fill in the exact, copy-pasteable commands. These are the highest-value lines
in this file for an assistant — they remove guesswork about how to validate a change.

| Task | Command |
| --- | --- |
| Install dependencies | [TODO] |
| Run app locally | [TODO] |
| Run full test suite | [TODO] |
| Run a single test file | [TODO] |
| Lint | [TODO] |
| Auto-format | [TODO] |
| Type-check | [TODO] |
| Build for production | [TODO] |
| Run database migrations | [TODO] |
| Seed local data | [TODO] |

**Pre-push checklist** — once the commands above exist, run the fast ones (lint, format,
type-check, affected unit tests) **before** pushing. One validated push beats three
speculative ones that redden CI.

---

## 8. Conventions to establish

**[TODO]** Each of these is a real decision that shapes how assistants write code here.
Record the answer, not just the question.

- **Naming** — file, directory, component, database table, and API route casing.
- **Error handling** — exceptions vs. result types; what gets logged vs. surfaced.
- **Validation** — where untrusted input is validated, and with what library.
- **Testing** — expected coverage, unit vs. integration split, what must have a test
  before merge. **Never skip, disable, or quarantine a test to make CI green.**
- **Secrets** — how configuration and credentials are supplied (`.env` is
  `.gitignore`d; never commit real secrets, keys, or tokens). Document a
  `.env.example` instead.
- **Time zones and dates** — critical for a booking system: store UTC, render local, and
  name the club's local zone here explicitly.
- **Money** — store minor units as integers; never floats for currency.
- **Accessibility and i18n** — if the audience is bilingual (e.g. Spanish/English),
  decide up front; retrofitting i18n is expensive.

---

## 9. Domain notes

**[ASSUMED]** Padel background that may be useful *if* the sport assumption holds.
Confirm with the owner before encoding any of it in a schema.

- A padel **court** is enclosed by walls/glass; play is doubles-dominant, so a booking is
  typically for **4 players** on one court for a fixed slot (commonly 60 or 90 minutes).
- Common social formats — **Americano** and **Mexicano** — rotate partners between short
  rounds and aggregate points per *player*, not per fixed pair. If the app schedules
  these, player-level scoring is a core modelling requirement, not a nicety.
- Typical booking concerns: peak/off-peak pricing, cancellation windows, no-show policy,
  recurring bookings, waitlists, court lighting, and indoor/outdoor courts.
- **Court availability is the contended resource** — double-booking is the defining
  correctness risk. Any booking implementation needs a real concurrency story
  (unique constraint on court + time range, or transactional locking), not
  application-level "check then insert".

---

## 10. Guidance for AI assistants

1. **Do not fabricate.** If asked to describe structure, workflows, or conventions that
   this file marks [TODO], say they are not yet defined. A confident wrong answer about
   an empty repo is worse than "there's nothing here yet".
2. **Check the repo state first.** Run the commands in §2 before concluding anything
   about what exists.
3. **Ask before choosing the stack.** See §5.
4. **Deliver the scope asked for** — don't quietly widen a task into a rewrite, or narrow
   it to the easy part. If part of it is blocked, finish the rest and say what you left out.
5. **Prefer the repo's own tooling** for generated files and lockfiles — regenerate,
   never hand-edit.
6. **Keep this file honest.** It is a living document; see §11.

---

## 11. Maintaining this file

Update CLAUDE.md in the same commit as the change that invalidates it. Specifically:

- Adding a dependency, script, or command → update §5 / §7.
- Adding a top-level directory → update §6.
- Making a convention decision → update §8 and delete the [TODO].

**This scaffold has done its job when every [TODO] and [ASSUMED] tag is gone and the
status banner at the top is deleted.** At that point rewrite it as a description of what
the codebase actually is — ideally by re-running an analysis against the real code rather
than editing these placeholders in place.
