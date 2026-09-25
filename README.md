# gugu-acp

Gugu's builds of third-party ACP bridges — the adapters that sit between Gugu's chat panel (an ACP client) and a CLI the user installed themselves (Claude Code, pi, …).

**Why this exists.** The user's CLI updates itself; a bridge frozen inside Gugu's installer does not. When the two drift apart, things break in ways no unit test sees (gugu#6394: Claude 2.1.270 changed when it reports "idle", the bundled bridge 0.75.1 kept the old count, and any turn that got a mid-turn group message never ended). So bridges here are meant to *flow*: follow upstream automatically, get checked against the CLI versions users actually run, and be picked by Gugu at runtime to match the user's CLI.

## Layout

```
bridges/<name>/
  bridge.json     our package name + version, the upstream repo/tag/commit we build from, the CLI it drives
                  ("pairing": false = no CLI-version pairing yet: no ABC, no compat.json entry)
  patches/*.patch our changes, as `git format-patch` files applied with `git am -3` on the upstream tag
compat.json       which of our releases serves which CLI version (see below)
scripts/          build · abc · publish · upstream · compat · follow
.github/workflows ci (patches apply + build + tests) · follow (unattended upstream/CLI tracking)
```

One repo for all bridges, Electron-style: Electron does not fork Chromium, it keeps `patches/` and applies them to a pinned Chromium ([electron/docs/development/patches.md](https://github.com/electron/electron/blob/main/docs/development/patches.md)).

Bridges: `claude-agent-acp` (paired with the user's Claude Code version), `pi-acp` (not paired yet).

## Rules for patches

Each patch's commit message states three things: **Why** it is needed, the **Upstream** PR it corresponds to (or that none exists yet), and when to **Drop** it. Before writing a patch, look for a way that needs none, in this order: a standard ACP mechanism → an extension point the bridge already exposes → a general capability proposed upstream → only then a patch here. Never patch a bridge's published build output (`dist/`).

## Versions are ours

`@gugu-acp/<name>` has its own semver. A new upstream release is a minor bump; the upstream tag and commit a build came from are recorded in `bridge.json` and in the published `package.json` under `gugu.upstream`.

`compat.json` is our declaration, not upstream's. Upstream's `claudeCodeVersion` (the CLI version an SDK was cut with) is only a starting point. A CLI version enters a release's `verified` list only after our **ABC** check passed:

- **A** a plain turn ends;
- **B** a turn that launches a background subagent ends;
- **C** a turn that receives a mid-turn `_session/steering` message with `delivery: "next"` (how Gugu injects group messages) ends.

`scripts/abc.mjs` drives the bridge with a bare ACP client against a real CLI. Per bridge, releases are ordered by `cliFrom`; a release serves `[cliFrom, next release's cliFrom)` and the newest one is open-ended.

## Automation (`follow` workflow, every 6 hours)

1. Upstream published a newer `vX.Y.Z` → apply patches, build, run upstream's tests, run ABC with the CLI's latest version → publish `@gugu-acp/<name>@<next minor>` → add a release to `compat.json` → commit.
2. Otherwise, the CLI published a version not yet verified for our newest release → run ABC with it → record it as verified → commit.

A patch that no longer applies, a failing test or a failing ABC opens an issue and stops; nothing is published or recorded before every check passed.

**How Gugu reads it.** `compat.json` is published as `@gugu-acp/compat` (version `1.0.<commits touching compat.json>`), with the whole table also inlined under `gugu.compat` in its `package.json` — so one packument GET from npm or a mirror (e.g. npmmirror) is enough. The `follow` workflow republishes it after each of its commits; the `compat` workflow does the same for hand edits.

Secrets: `NPM_TOKEN` (publish to `@gugu-acp`), `ABC_ANTHROPIC_BASE_URL` / `ABC_ANTHROPIC_AUTH_TOKEN` and the variable `ABC_ANTHROPIC_MODEL` (the model the CLI talks to during ABC).

## Local use

```bash
node scripts/build.mjs claude-agent-acp               # prints the packed tarball
node scripts/abc.mjs --adapter <src>/dist/index.js --cli "$(which claude)"
node scripts/follow.mjs claude-agent-acp --dry-run    # what CI would do, without publishing or committing
```
