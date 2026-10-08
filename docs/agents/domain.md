# Domain docs

**Load the `agent-domain-docs` skill** for how to read domain documentation. It is
the canonical source, so this file deliberately holds no copy of it.

This repo is single-context: one `GLOSSARY.md` and one `docs/adr/` at the root. Wisp is one product across three runtimes (`src/` + `src-tauri/` notch app, `relay/` Worker, `ios/` phone app) that share one vocabulary.

Neither `GLOSSARY.md` nor `docs/adr/` exists yet; `/domain-modeling` creates them
when a term or a decision is actually resolved. `docs/` holds nothing but `agents/`
right now.
