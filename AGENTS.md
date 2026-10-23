# Wisp

Instructions for coding agents working in this repo. `CLAUDE.md` points here, so this file is the single source of truth.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `ErikKarasek/wisp` (public, so issue bodies are public), managed with the `gh` CLI. The conventions live in the `gh-issue-conventions` skill: **load it before any issue operation.** Repo-specific notes are in `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. All five already exist on the repo. See the `gh-issue-conventions` skill, and `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, neither created yet. Load the `agent-domain-docs` skill; see `docs/agents/domain.md`.

## The notch's card

One element (`.steps` in `src/mini.ts`) holds every card, and several of them are written straight
from an event listener, outside `draw()`: a dropped file, a quick question, a snip, a dropped
window's error. A permission prompt and Claude's own question paint over whatever is there.

So never remember "this card is already drawn" in a variable of its own. Three bugs in a row came
from exactly that: the card got painted over, the remembered id said there was nothing to redraw,
and what stayed on screen was a card whose buttons answered nobody, with the notch stuck open.
Read `steps.dataset.mode` instead, and when state behind a card outlives the card itself, drop it.

Check any change to those cards with `pnpm test:notch`, which drives the real page through
`notch-harness.html`. Add a case for whatever broke; a new test has to fail before the fix.

## The task a pull request finishes

Wisp's watchdog closes a Paperclip task once the pull request that finishes it is merged, and it
works out which task from the pull request itself (`gh search prs` cannot return the branch).
`ownTaskId` in `src/ownTask.ts` takes an ID from the title, or one standing **on the same line,
directly after** `Closes` / `Fixes` / `Resolves` / `Paperclip`, with nothing but spaces between.

So name the task in English, on a line of its own:

```
Closes NEX-68
```

Czech wording around the keyword is not parsed. `Paperclip úkol: NEX-61` and `Úkol v Paperclipu:
NEX-68` both come out as "no own task", and the task then sits in `in_review` until somebody closes
it by hand. That is what happened to NEX-68 (#14), whose title carried no ID either.

A passing mention stays a mention: `follow-up to NEX-38`, `part of NEX-40` and `does not fix
NEX-12` are deliberately not own tasks, and two own IDs in one pull request close nothing. One pull
request finishes one task. Any change to these rules gets a case in `src/ownTask.test.ts`, which
`pnpm test` runs.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: tests and the
typecheck plus build on Ubuntu, the notch harness on Ubuntu, and `cargo check` on macOS. The repo
is public, so the runners are free.

Run the same four things before you push, because a red CI on a merged PR is nobody's job to catch:

```
pnpm test        # node --test src/ownTask.test.ts
pnpm build       # tsc --noEmit && vite build
pnpm test:notch  # the real notch page through notch-harness.html
cargo check --manifest-path src-tauri/Cargo.toml
```

The Mac app itself is **not** built in CI. `tauri build` needs a signing identity that only Erik's
Mac has. The header of `ci.yml` lists what else is deliberately left out (`cargo fmt`, clippy as a
gate, and `relay/`, which no tsconfig covers) and what would have to change first.

## Committing

Commit messages and PR descriptions carry **no** `Co-Authored-By: Claude` and no "Generated with Claude Code" line. The repo shows Erik as the only author. A squash merge copies co-author trailers out of the branch commits, so they have to be gone before the PR is merged.
