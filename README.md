# Dispečink

A Mac app that shows every automation I run as a little character: the
launchd jobs in `~/Library/LaunchAgents` and the agents and routines on the
local Paperclip server. Each one has its own face, and the face shows what it is
doing: bouncing while it works, asleep until its next run, red and angry when it
failed, curious when it waits for me.

It only reads and runs what is already there. Nothing moves anywhere and no AI
runs inside it.

## What it can do

- **launchd** (labels starting `com.erikkarasek.` or `ing.paperclip.`): state,
  schedule, last and next run, the log tail. Run now, restart an always-on job,
  pause (disable + bootout, stays off after a login), resume.
- **Paperclip** (`http://127.0.0.1:3100`): agents with their open issues,
  routines with their next run. Wake an agent, pause or resume it, run a
  routine, open it in Paperclip. Waking an agent or running a routine spends
  the Claude subscription, so those buttons ask first.
- **Cloudflare Workers**: scripts, cron schedules (UTC, shown in local time),
  runs and errors over 24 h, the last cron events, and today's Workers AI
  neurons against the 10 000 daily allowance. Needs a read-only API token
  (Workers Scripts: Read, Account Analytics: Read), kept in the Keychain.
- **GitHub Actions** through the `gh` login: workflows of the chosen repos with
  their last run. Run now, enable, disable, open on GitHub.
- **Characters**: pick one for any item, tweak it (shape, colours, build, lean,
  eyes), make new ones, rename items. Stored in
  `~/Library/Application Support/cz.erikkarasek.dispecink/config.json`.
- **Menu bar**: a mascot whose face is the worst state of all, and a menu of
  whatever needs attention. Closing the window keeps it running there.
- **Notifications** when something turns failed or waiting, and an optional
  launch at login.

## Build and install

```sh
corepack pnpm install
corepack pnpm tauri:build
ditto "src-tauri/target/release/bundle/macos/Dispečink.app" "/Applications/Dispečink.app"
```

Use `tauri:build` for the bundle; don't copy a fresh binary into an existing
`.app`. `corepack pnpm tauri:dev` runs it with hot reload.

The icon comes from `scripts/make-icon.mjs` (`corepack pnpm icon`), which draws
the mascot on a squircle and needs `rsvg-convert`.

## The mascot

`src/mascot/` is a copy of `packages/mascot/src` from Nexus Grind (commit
42ac5e1). It is written to be copied as-is; keep changes there and copy them
over.
