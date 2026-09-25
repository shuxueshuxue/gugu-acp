#!/usr/bin/env node
// Read and write compat.json — our own declaration of which bridge release serves which CLI version.
//
//   node scripts/compat.mjs newest <bridge>
//       -> JSON {version, cliFrom, verified:[...]} of the newest release
//   node scripts/compat.mjs latest-cli <bridge>
//       -> the CLI's latest version on npm (from bridge.json cli.npm)
//   node scripts/compat.mjs record-verified <bridge> <version> <cliVersion> <how>
//       -> append a verified entry to that release (no-op if already there)
//   node scripts/compat.mjs add-release <bridge> <version> <upstreamTag> <cliVersion> <how>
//       -> new release that serves from <cliVersion> on (the previous newest now ends there)
//
// Ranges are never inferred from upstream: a CLI version only enters `verified` after our ABC check.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FILE = join(ROOT, 'compat.json')
const [cmd, bridgeName, ...rest] = process.argv.slice(2)
const compat = JSON.parse(readFileSync(FILE, 'utf8'))
const entry = compat.bridges[bridgeName]
if (!entry) { console.error(`FAIL: no bridge ${bridgeName} in compat.json`); process.exit(2) }
const today = new Date().toISOString().slice(0, 10)
const save = () => writeFileSync(FILE, `${JSON.stringify(compat, null, 2)}\n`)

if (cmd === 'newest') {
  console.log(JSON.stringify(entry.releases.at(-1)))
} else if (cmd === 'latest-cli') {
  const bridge = JSON.parse(readFileSync(join(ROOT, 'bridges', bridgeName, 'bridge.json'), 'utf8'))
  console.log(execFileSync(`npm view "${bridge.cli.npm}" version`, { shell: true, encoding: 'utf8' }).trim())
} else if (cmd === 'record-verified') {
  const [version, cli, how] = rest
  const release = entry.releases.find((r) => r.version === version)
  if (!release) { console.error(`FAIL: no release ${version} for ${bridgeName}`); process.exit(2) }
  if (!release.verified.some((v) => v.cli === cli)) {
    release.verified.push({ cli, at: today, how })
    save()
  }
  console.log(JSON.stringify(release))
} else if (cmd === 'add-release') {
  const [version, upstreamTag, cli, how] = rest
  if (entry.releases.some((r) => r.version === version)) { console.error(`FAIL: release ${version} exists`); process.exit(2) }
  entry.releases.push({ version, upstreamTag, cliFrom: cli, verified: [{ cli, at: today, how }] })
  save()
  console.log(JSON.stringify(entry.releases.at(-1)))
} else {
  console.error('usage: compat.mjs newest|latest-cli|record-verified|add-release <bridge> ...')
  process.exit(2)
}
