#!/usr/bin/env node
// Publish compat.json as @gugu-acp/compat so Gugu can read it at runtime from any npm registry
// (registry.npmjs.org or a mirror such as npmmirror): the whole table is also inlined in the published
// package.json under `gugu.compat`, so one packument GET is enough — no tarball needed.
//
//   NPM_TOKEN=... node scripts/publish-compat.mjs [--dry-run]
//
// Version = 1.0.<number of commits that touched compat.json>, so every change gets a new version and
// re-running on the same commit is a no-op (publish.mjs skips an existing name@version).
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DRY = process.argv.includes('--dry-run')
const compat = JSON.parse(readFileSync(join(ROOT, 'compat.json'), 'utf8'))
const n = execFileSync('git', ['rev-list', '--count', 'HEAD', '--', 'compat.json'], { cwd: ROOT, encoding: 'utf8' }).trim()
if (!/^\d+$/.test(n) || n === '0') { console.error('FAIL step=version: compat.json has no commits'); process.exit(2) }
const version = `1.0.${n}`

const dir = mkdtempSync(join(tmpdir(), 'gugu-acp-compat-'))
writeFileSync(join(dir, 'compat.json'), `${JSON.stringify(compat, null, 2)}\n`)
writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
  name: '@gugu-acp/compat',
  version,
  description: 'Which @gugu-acp bridge release serves which CLI version (compat.json of shuxueshuxue/gugu-acp)',
  license: 'Apache-2.0',
  repository: { type: 'git', url: 'git+https://github.com/shuxueshuxue/gugu-acp.git' },
  files: ['compat.json'],
  main: 'compat.json',
  gugu: { compat },
}, null, 2)}\n`)
const packed = JSON.parse(execFileSync(`npm pack --json --pack-destination "${dir}"`, { cwd: dir, shell: true, encoding: 'utf8' }))
const tarball = join(dir, packed[0].filename)
console.log(`@gugu-acp/compat@${version}: ${tarball}`)
if (DRY) process.exit(0)
const p = spawnSync(process.execPath, [join(ROOT, 'scripts', 'publish.mjs'), tarball], { stdio: 'inherit' })
process.exit(p.status ?? 1)
