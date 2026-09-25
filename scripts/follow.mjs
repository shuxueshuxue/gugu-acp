#!/usr/bin/env node
// One unattended pass for one bridge — what CI runs on a schedule.
//
//   node scripts/follow.mjs <bridge> [--dry-run]
//
// 1. Upstream has a newer vX.Y.Z tag?
//      bump bridge.json (our minor version) -> build.mjs (patches + upstream tests)
//      -> ABC against the CLI's latest version -> publish -> compat add-release -> commit + push.
// 2. Otherwise: is the CLI's latest version already verified for our newest release?
//      no -> ABC with that CLI against the published newest release
//      -> pass: compat record-verified -> commit + push.
// After a commit, compat.json is republished as @gugu-acp/compat (what Gugu reads at runtime).
// Anything that fails stops the pass and is reported (an issue in CI, stderr locally); nothing is
// published or recorded unless every check before it passed. --dry-run skips publish/commit/push.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const [bridgeName, ...flags] = process.argv.slice(2)
const DRY = flags.includes('--dry-run')
const CI = process.env.GITHUB_ACTIONS === 'true'
if (!bridgeName) { console.error('usage: follow.mjs <bridge> [--dry-run]'); process.exit(2) }

const node = (script, args, opts = {}) => spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts,
})
const lastLine = (s) => s.trim().split('\n').at(-1)
const sh = (line, opts = {}) => execFileSync(line, { cwd: ROOT, shell: true, encoding: 'utf8', ...opts })
const bridgeFile = () => JSON.parse(readFileSync(join(ROOT, 'bridges', bridgeName, 'bridge.json'), 'utf8'))

function report(title, body) {
  console.error(`FAIL: ${title}\n${body}`)
  if (CI) {
    const open = sh(`gh issue list --state open --search "${title.replace(/"/g, '')} in:title" --json number --jq ".[0].number"`).trim()
    const text = `${body}\n\nRun: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    if (open) sh(`gh issue comment ${open} --body-file -`, { input: text })
    else sh(`gh issue create --title "${title.replace(/"/g, '')}" --body-file -`, { input: text })
  }
  process.exit(1)
}

function installCli(version) {
  const { cli } = bridgeFile()
  const dir = mkdtempSync(join(tmpdir(), `gugu-acp-cli-`))
  sh(`npm install --prefix "${dir}" --no-audit --no-fund "${cli.npm}@${version}"`, { stdio: 'inherit' })
  const bin = join(dir, 'node_modules', '.bin', process.platform === 'win32' ? `${cli.name}.cmd` : cli.name)
  if (!existsSync(bin)) report(`${bridgeName}: CLI ${version} did not install`, `no ${bin}`)
  return bin
}

function installBridge(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-acp-bridge-'))
  sh(`npm install --prefix "${dir}" --omit=dev --no-audit --no-fund "${spec}"`, { stdio: 'inherit' })
  const { package: pkg } = bridgeFile()
  return join(dir, 'node_modules', ...pkg.split('/'), 'dist', 'index.js')
}

function abc(adapter, cliBin) {
  const r = node('abc.mjs', ['--adapter', adapter, '--cli', cliBin, '--work', mkdtempSync(join(tmpdir(), 'gugu-acp-abc-'))])
  process.stdout.write(r.stdout)
  return { ok: r.status === 0, verdict: lastLine(r.stdout || '{}') }
}

function commitAndPush(message) {
  if (DRY) { console.log(`dry-run: would commit "${message}"`); return }
  sh('git add bridges compat.json')
  sh(`git -c user.name="gugu-acp bot" -c user.email="gugu-acp@users.noreply.github.com" commit -q -m "${message}"`)
  for (let i = 0; i < 3; i++) {
    try { sh('git pull -q --rebase && git push -q'); return } catch { /* retry */ }
  }
  report(`${bridgeName}: push failed`, message)
}

function publishCompat() {
  if (DRY) { console.log('dry-run: would publish @gugu-acp/compat'); return }
  const p = spawnSync(process.execPath, [join(ROOT, 'scripts', 'publish-compat.mjs')], { cwd: ROOT, stdio: 'inherit' })
  if (p.status !== 0) report(`${bridgeName}: publishing @gugu-acp/compat failed`, 'compat.json is committed but not published')
}

// ── 1. upstream ────────────────────────────────────────────────────────────
const up = JSON.parse(lastLine(node('upstream.mjs', [bridgeName, '--bump']).stdout))
console.log(`upstream: ${JSON.stringify(up)}`)
const latestCli = lastLine(node('compat.mjs', ['latest-cli', bridgeName]).stdout)
console.log(`latest CLI: ${latestCli}`)

if (up.newer) {
  const b = node('build.mjs', [bridgeName], { stdio: ['ignore', 'pipe', 'pipe'] })
  if (b.status !== 0) {
    const why = { 3: 'a patch no longer applies', 4: 'build failed', 5: 'upstream + patch tests failed' }[b.status] ?? `exit ${b.status}`
    report(`${bridgeName}: upstream ${up.latest} needs attention (${why})`, `\`\`\`\n${(b.stderr || '').slice(-4000)}\n\`\`\``)
  }
  const tarball = lastLine(b.stdout)
  const cliBin = installCli(latestCli)
  const r = abc(installBridge(tarball), cliBin)
  if (!r.ok) report(`${bridgeName}: upstream ${up.latest} fails ABC with ${bridgeFile().cli.name} ${latestCli}`, `\`\`\`\n${r.verdict}\n\`\`\``)
  if (!DRY) {
    const p = spawnSync(process.execPath, [join(ROOT, 'scripts', 'publish.mjs'), tarball], { stdio: 'inherit' })
    if (p.status !== 0) report(`${bridgeName}: publish ${up.version} failed`, tarball)
  }
  node('compat.mjs', ['add-release', bridgeName, up.version, up.latest, latestCli, `abc (CI, upstream ${up.latest})`])
  commitAndPush(`${bridgeName}: ${up.version} = upstream ${up.latest} + patches; verified with ${bridgeFile().cli.name} ${latestCli}`)
  publishCompat()
  process.exit(0)
}

// ── 2. new CLI version against our newest release ──────────────────────────
const newest = JSON.parse(lastLine(node('compat.mjs', ['newest', bridgeName]).stdout))
if (newest.verified.some((v) => v.cli === latestCli)) {
  console.log(`up to date: ${bridgeName}@${newest.version} already verified with ${latestCli}`)
  process.exit(0)
}
const cliBin = installCli(latestCli)
const r = abc(installBridge(`${bridgeFile().package}@${newest.version}`), cliBin)
if (!r.ok) report(`${bridgeName}@${newest.version} fails ABC with ${bridgeFile().cli.name} ${latestCli}`, `\`\`\`\n${r.verdict}\n\`\`\``)
node('compat.mjs', ['record-verified', bridgeName, newest.version, latestCli, 'abc (CI)'])
commitAndPush(`${bridgeName}@${newest.version}: verified with ${bridgeFile().cli.name} ${latestCli}`)
publishCompat()
