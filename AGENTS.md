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

## Committing

Commit messages and PR descriptions carry **no** `Co-Authored-By: Claude` and no "Generated with Claude Code" line. The repo shows Erik as the only author. A squash merge copies co-author trailers out of the branch commits, so they have to be gone before the PR is merged.
