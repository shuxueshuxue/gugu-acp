#!/usr/bin/env node
// Is there a newer upstream release than the one a bridge is pinned to?
//
//   node scripts/upstream.mjs <bridge>          # prints JSON {bridge, current, latest, commit, newer}
//   node scripts/upstream.mjs <bridge> --bump   # also rewrites bridge.json: tag/commit -> latest, minor version bump
//
// "Latest" = highest vX.Y.Z tag (no pre-releases) by semver. Our package version is ours: a new upstream
// release is a minor bump of our version, regardless of how upstream numbered it.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const [bridgeName, flag] = process.argv.slice(2)
if (!bridgeName) { console.error('usage: upstream.mjs <bridge> [--bump]'); process.exit(2) }
const file = join(ROOT, 'bridges', bridgeName, 'bridge.json')
const bridge = JSON.parse(readFileSync(file, 'utf8'))

const parse = (tag) => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag); return m ? m.slice(1).map(Number) : null }
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

const refs = execFileSync('git', ['ls-remote', '--tags', '--refs', bridge.upstream.repo], { encoding: 'utf8' })
const tags = refs.split('\n').filter(Boolean).map((line) => {
  const [commit, ref] = line.split('\t')
  return { commit, tag: ref.replace('refs/tags/', '') }
}).filter((t) => parse(t.tag))
if (tags.length === 0) { console.error(`FAIL step=ls-remote: no vX.Y.Z tags at ${bridge.upstream.repo}`); process.exit(1) }
tags.sort((a, b) => cmp(parse(a.tag), parse(b.tag)))
const latest = tags.at(-1)
const current = bridge.upstream.tag
const newer = cmp(parse(latest.tag), parse(current)) > 0

if (newer && flag === '--bump') {
  const [maj, min] = bridge.version.split('.').map(Number)
  bridge.version = `${maj}.${min + 1}.0`
  bridge.upstream.tag = latest.tag
  bridge.upstream.commit = latest.commit
  writeFileSync(file, `${JSON.stringify(bridge, null, 2)}\n`)
}
console.log(JSON.stringify({ bridge: bridgeName, current, latest: latest.tag, commit: latest.commit, newer, version: bridge.version }))
