# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one `GLOSSARY.md` and one `docs/adr/` at the root. Wisp is one product split across three runtimes (the Tauri notch app in `src/`, the Cloudflare Worker in `relay/`, the SwiftUI phone app in `ios/`), and all three speak the same vocabulary, so they share one glossary rather than each keeping their own.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
├── src/            ← the notch app (Tauri front end)
├── src-tauri/      ← the Rust side, incl. awake.rs
├── relay/          ← Cloudflare Worker + schema.sql
└── ios/            ← SwiftUI phone app
```

If the three runtimes ever drift into genuinely separate vocabularies, this becomes a multi-context repo: add a root `GLOSSARY-MAP.md` pointing at one `GLOSSARY.md` per runtime, keep `docs/adr/` at the root for system-wide decisions, and add `<runtime>/docs/adr/` for decisions scoped to one of them. Don't do this pre-emptively.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
