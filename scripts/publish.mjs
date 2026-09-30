#!/usr/bin/env node
// Publish a packed bridge tarball to npm unless that exact name@version is already there.
//
//   NPM_TOKEN=... node scripts/publish.mjs <tarball>
//
// The token is only ever referenced through ${NPM_TOKEN} in a throwaway userconfig; it is never
// printed. Exit 0 = published (or already present) and the tarball downloads, 1 = publish failed or
// the tarball never became available, 2 = bad input.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const tarball = process.argv[2] && resolve(process.argv[2])
if (!tarball) { console.error('usage: publish.mjs <tarball>'); process.exit(2) }
if (!process.env.NPM_TOKEN) { console.error('FAIL step=auth: NPM_TOKEN is not set'); process.exit(2) }

/** Minimal ustar reader: the named entry's contents (npm tarballs are plain ustar). */
function readTarEntry(buf, name) {
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512)
    const entry = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    if (!entry) break
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8)
    if (entry === name) return buf.subarray(off + 512, off + 512 + size).toString('utf8')
    off += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error(`${name} not found in tarball`)
}

const npm = (line, opts = {}) => execFileSync(line, { shell: true, encoding: 'utf8', ...opts })
const meta = JSON.parse(readTarEntry(gunzipSync(readFileSync(tarball)), 'package/package.json'))
const spec = `${meta.name}@${meta.version}`

let exists = false
try { exists = npm(`npm view "${spec}" version`, { stdio: ['ignore', 'pipe', 'ignore'] }).trim() === meta.version } catch { exists = false }
if (exists) {
  console.log(`skip: ${spec} is already on npm`)
} else {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-acp-npmrc-'))
  const rc = join(dir, 'npmrc')
  writeFileSync(rc, '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')
  try {
    npm(`npm publish "${tarball}" --userconfig "${rc}" --access public --tag latest`, { stdio: 'inherit' })
    console.log(`published: ${spec}`)
  } catch {
    console.error(`FAIL step=publish: ${spec}`)
    process.exit(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// npm "processes" a new version before serving it (PUT 202; on 2026-09-30 the version document took
// ~30 min and the tarball ~10 min more). follow publishes compat.json right after this script, and a
// table naming a version that cannot be installed yet sends every paired client into a failed download.
// So this script returns only once the tarball itself downloads.
const tarballUrl = `https://registry.npmjs.org/${meta.name}/-/${meta.name.split('/').pop()}-${meta.version}.tgz`
const deadline = Date.now() + 90 * 60_000
for (let attempt = 0; ; attempt++) {
  const status = await fetch(tarballUrl, { method: 'HEAD' }).then((r) => r.status, () => 0)
  if (status === 200) { console.log(`available: ${spec}`); break }
  if (Date.now() > deadline) {
    console.error(`FAIL step=available: ${tarballUrl} still ${status} after 90 min`)
    process.exit(1)
  }
  if (attempt % 10 === 0) console.log(`waiting for npm to serve ${spec} (tarball ${status})`)
  await new Promise((resolve) => setTimeout(resolve, 30_000))
}
