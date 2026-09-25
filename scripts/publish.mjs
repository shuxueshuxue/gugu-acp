#!/usr/bin/env node
// Publish a packed bridge tarball to npm unless that exact name@version is already there.
//
//   NPM_TOKEN=... node scripts/publish.mjs <tarball>
//
// The token is only ever referenced through ${NPM_TOKEN} in a throwaway userconfig; it is never
// printed. Exit 0 = published or already present, 1 = publish failed, 2 = bad input.
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
if (exists) { console.log(`skip: ${spec} is already on npm`); process.exit(0) }

const dir = mkdtempSync(join(tmpdir(), 'gugu-acp-npmrc-'))
const rc = join(dir, 'npmrc')
writeFileSync(rc, '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')
try {
  npm(`npm publish "${tarball}" --userconfig "${rc}" --access public --tag latest`, { stdio: 'inherit' })
  console.log(`published: ${spec}`)
} catch {
  console.error(`FAIL step=publish: ${spec}`)
  process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
