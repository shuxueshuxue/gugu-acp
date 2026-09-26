#!/usr/bin/env node
// Build one bridge: clone upstream at the pinned tag, apply our patches with a three-way `git am`,
// build, run the upstream test suite (which also carries our patch tests), run the Gugu contract
// tests in bridges/<bridge>/contracts/ against the built dist/, then stamp and pack it as the
// @gugu-acp package.
//
//   node scripts/build.mjs <bridge> [--tag <upstream tag>] [--version <x.y.z>] [--skip-tests]
//
// Prints the packed tarball path as the last stdout line. Exit codes: 0 ok, 3 a patch does not
// apply, 4 build failed, 5 tests failed, 6 a Gugu contract failed, 2 bad input. Every failure names
// the step.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO_URL = 'https://github.com/shuxueshuxue/gugu-acp'

function parseArgs(argv) {
  const [bridge, ...rest] = argv
  const opts = { bridge, tag: null, version: null, skipTests: false }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--tag') opts.tag = rest[++i]
    else if (rest[i] === '--version') opts.version = rest[++i]
    else if (rest[i] === '--skip-tests') opts.skipTests = true
    else fail(2, 'args', `unknown argument ${rest[i]}`)
  }
  if (!bridge) fail(2, 'args', 'usage: build.mjs <bridge> [--tag <t>] [--version <v>] [--skip-tests]')
  return opts
}

function fail(code, step, detail) {
  console.error(`FAIL step=${step}: ${detail}`)
  process.exit(code)
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts })
}

// Upstream tests read provider settings from the environment (e.g. ANTHROPIC_BASE_URL); a build must
// not depend on whatever the calling shell or CI job happens to export.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|ABC_)/.test(k)))

function sh(line, cwd) {
  execFileSync(line, { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell: true, env: cleanEnv })
}

const opts = parseArgs(process.argv.slice(2))
const bridgeDir = join(ROOT, 'bridges', opts.bridge)
if (!existsSync(join(bridgeDir, 'bridge.json'))) fail(2, 'args', `no bridges/${opts.bridge}/bridge.json`)
const bridge = JSON.parse(readFileSync(join(bridgeDir, 'bridge.json'), 'utf8'))
const tag = opts.tag ?? bridge.upstream.tag
const version = opts.version ?? bridge.version

const work = join(ROOT, '.work', opts.bridge)
const src = join(work, 'src')
const out = join(work, 'out')
rmSync(work, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

console.log(`== clone ${bridge.upstream.repo} @ ${tag}`)
run('git', ['-c', 'core.autocrlf=false', 'clone', '-q', '--depth', '1', '--branch', tag, bridge.upstream.repo, src])
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim()
if (!opts.tag && commit !== bridge.upstream.commit) {
  fail(2, 'clone', `tag ${tag} is ${commit}, bridge.json pins ${bridge.upstream.commit} (tag moved upstream?)`)
}

const patchDir = join(bridgeDir, 'patches')
const patches = existsSync(patchDir) ? readdirSync(patchDir).filter((f) => f.endsWith('.patch')).sort() : []
console.log(`== apply ${patches.length} patch(es)`)
for (const p of patches) {
  try {
    run('git', ['-c', 'user.name=gugu-acp', '-c', 'user.email=gugu-acp@users.noreply.github.com',
      'am', '-q', '-3', '--keep-cr', join(patchDir, p)], { cwd: src })
  } catch {
    try { run('git', ['am', '--abort'], { cwd: src }) } catch { /* nothing to abort */ }
    fail(3, 'apply', `${p} does not apply on ${tag} (${commit})`)
  }
}

console.log('== build')
try { for (const line of bridge.build) sh(line, src) } catch { fail(4, 'build', bridge.build.join(' && ')) }

if (opts.skipTests) {
  console.log('== tests skipped (--skip-tests)')
} else {
  console.log('== test')
  try { for (const line of bridge.test) sh(line, src) } catch { fail(5, 'test', bridge.test.join(' && ')) }

  // What Gugu itself reads from the bridge (e.g. the AskUserQuestion form, gugu#6565). Upstream's tests
  // cannot know about it, and a release that changes it would reach users through compat.json.
  const contractDir = join(bridgeDir, 'contracts')
  const contracts = existsSync(contractDir) ? readdirSync(contractDir).filter((f) => f.endsWith('.test.mjs')).sort() : []
  if (contracts.length > 0) {
    console.log(`== gugu contracts (${contracts.join(', ')})`)
    try {
      execFileSync(process.execPath, ['--test', ...contracts.map((f) => join(contractDir, f))], {
        cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...cleanEnv, GUGU_ACP_BUILT: src },
      })
    } catch { fail(6, 'contracts', `bridges/${opts.bridge}/contracts: ${contracts.join(', ')}`) }
  }
}

console.log(`== stamp ${bridge.package}@${version}`)
const pkgPath = join(src, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const upstreamName = pkg.name
const upstreamVersion = pkg.version
pkg.name = bridge.package
pkg.version = version
pkg.description = `Gugu build of ${upstreamName} ${upstreamVersion}: upstream source plus the patches in ${REPO_URL}/tree/main/bridges/${opts.bridge}`
pkg.repository = { type: 'git', url: `git+${REPO_URL}.git`, directory: `bridges/${opts.bridge}` }
pkg.gugu = {
  bridge: opts.bridge,
  upstream: { repo: bridge.upstream.repo, package: upstreamName, version: upstreamVersion, tag, commit },
  patches,
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
const readme = join(src, 'README.md')
const note = `> **Gugu build.** \`${bridge.package}@${version}\` = [${upstreamName}](${bridge.upstream.repo}) ${tag} `
  + `plus ${patches.length} patch(es) kept in [gugu-acp](${REPO_URL}/tree/main/bridges/${opts.bridge}/patches); `
  + 'each patch says why it is needed, which upstream PR it corresponds to, and when it can be dropped. '
  + 'Apache-2.0 like upstream.\n\n'
writeFileSync(readme, note + (existsSync(readme) ? readFileSync(readme, 'utf8') : ''))

console.log('== pack')
const packed = execFileSync(`npm pack --json --ignore-scripts --pack-destination "${out}"`, {
  cwd: src, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'inherit'],
})
const filename = JSON.parse(packed)[0].filename
console.log(join(out, filename))
