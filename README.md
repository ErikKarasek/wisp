# Wisp

A Mac app that keeps every automation I run in front of me, as a little
character: the launchd jobs in `~/Library/LaunchAgents`, the agents and routines
on the local Paperclip server, Cloudflare Workers and GitHub Actions. Each one
has a face, and the face shows what it is doing: bouncing while it works, asleep
until its next run, red when it failed, curious when it is waiting for me.

It lives in the notch, so the crew is visible without a window in the way, and
the same state travels to an iPhone app through a Cloudflare relay. A Claude
permission prompt can be answered from the notch, from the lock screen or from
Telegram, whichever is nearer.

Nothing here is a product. It is the dashboard I wanted for my own machine, and
it is public because the parts that were interesting to build — the relay, the
permission round trip, the usage rings across three AI subscriptions — are worth
reading even if nobody else ever runs it.

## What it shows

- **launchd** (labels starting `com.erikkarasek.` or `ing.paperclip.`): state,
  schedule, last and next run, the log tail. Run now, restart an always-on job,
  pause (disable + bootout, stays off after a login), resume.
- **Paperclip agents** (`http://127.0.0.1:3100`): agents with their open issues,
  routines with their next run. Waking an agent spends a subscription, so those
  buttons ask first.
- **AI engines side by side**: Claude (the `claude` CLI), ChatGPT (the Codex
  CLI, chosen over the sandboxed ACP engine so agents get network access and can
  write outside their workspace) and Gemini (through `agy`). Each agent carries
  its engine, and the notch shows one usage ring per subscription with the reset
  window; the ring turns amber when the pace would run the limit out early.
- **Cloudflare Workers**: scripts, cron schedules in local time, runs and errors
  over 24 h, and today's Workers AI neurons against the free daily allowance.
  Needs a read-only API token (Workers Scripts: Read, Account Analytics: Read).
- **GitHub Actions** through the `gh` login: workflows of the chosen repos, the
  last run, and pull requests waiting to be merged or closed.

## The notch

The overlay draws over the camera housing: tabs for the crew, the steps of the
agent that is working, chat, a new task, music, a calendar strip. Steps stream
in live from Claude Code hooks, slide up and shimmer while they run. A file
dropped on the bot becomes a question about that file. When something fails the
card offers a retry; when nothing is running the crew steps aside.

## iPhone

`ios/` is a SwiftUI app, sideloaded with SideStore: tasks, replies, permission
prompts, agent cards, history, filters and the same usage limits with their
reset times. Four widget variants (bot, agents with wake buttons, limits as bars
and as lock-screen gauges) open the matching tab through `dispecink://` deep
links, and a Live Activity puts the working agent in the Dynamic Island.

## The relay

`relay/` is a Cloudflare Worker with a D1 database: the Mac pushes its state and
picks up commands, the phone reads the state and leaves commands. One bearer
token (the `RELAY_TOKEN` secret) guards every route, compared in constant time.
Hook endpoints on the Mac want a per-install secret of their own and refuse
requests from a browser or a rebound host, because they can start work.

## Secrets

None are in this repository and none reach the web view. The Cloudflare and
GitHub tokens, the Telegram bot token and the relay token live in the macOS
Keychain; the key file the hooks use is `0600`. The Worker's token is a Wrangler
secret.

## Build and install

```sh
corepack pnpm install
corepack pnpm tauri:build
ditto "src-tauri/target/release/bundle/macos/Wisp.app" "/Applications/Wisp.app"
```

Use `tauri:build` for the bundle; don't copy a fresh binary into an existing
`.app`. `corepack pnpm tauri:dev` runs it with hot reload. The icon comes from
`scripts/make-icon.mjs` (`corepack pnpm icon`), which draws the mascot on a
squircle and needs `rsvg-convert`. The app is signed with an Apple Development
certificate so the Keychain items survive a rebuild.

Internal identifiers (the bundle id `cz.erikkarasek.dispecink`, the config path,
the `dispecink://` scheme and the relay routes) still say dispecink, the name
this started under. Renaming them would log every install out of its own
Keychain items for nothing.

## The mascot

`src/mascot/` is a copy of `packages/mascot/src` from Nexus Grind (commit
42ac5e1). It is written to be copied as-is; keep changes there and copy them
over.

## Licence

No licence yet: all rights reserved. Read it, learn from it, ask before reusing it.
