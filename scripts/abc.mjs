#!/usr/bin/env node
// The ABC check: drive one bridge process with a bare ACP client against a REAL CLI, the way Gugu
// uses it, and require every turn to end.
//
//   node scripts/abc.mjs --adapter <bridge>/dist/index.js [--cli <claude binary>] [--work <dir>]
//
//   A  plain prompt                                  -> must end
//   B  launch one background subagent               -> must end (with the 0.75.1 bridge this left one unpaid idle)
//   C  prompt + mid-turn _session/steering, delivery "next" (how Gugu injects group messages)
//                                                    -> must end; the #6394 bug shows as a timeout here
//
// The model comes from the environment the CLI reads (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN /
// ANTHROPIC_MODEL for claude). Last stdout line is one JSON verdict. Exit: 0 PASS, 1 FAIL (a turn did
// not end or errored), 2 RIG-FAIL (could not start the bridge / session).
// Origin: acp-repro.mjs from the gugu#6394 handoff.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import readline from 'node:readline'
import { resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
if (!args.adapter) { console.error('usage: abc.mjs --adapter <dist/index.js> [--cli <bin>] [--work <dir>]'); process.exit(2) }
const CLI = args.cli || execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude']).toString().split(/\r?\n/)[0].trim()
const WORK = resolve(args.work || './abc-work'); mkdirSync(WORK, { recursive: true })
const cliVersion = (() => { try { return execFileSync(CLI, ['--version']).toString().trim() } catch { return null } })()

const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1)
const log = (...a) => console.log(`[${ts()}s]`, ...a)
const results = {}
let done = false
let child
const verdict = (v, extra = {}) => { done = true; try { child?.kill() } catch {} console.log(JSON.stringify({ verdict: v, cli: CLI, cliVersion, adapter: args.adapter, results, ...extra })); process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 2) }

child = spawn(process.execPath, [args.adapter], {
  cwd: WORK, env: { ...process.env, CLAUDE_CODE_EXECUTABLE: CLI, DISABLE_AUTOUPDATER: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
})
let stderrTail = []
readline.createInterface({ input: child.stderr }).on('line', (l) => { stderrTail = [...stderrTail.slice(-19), l] })
child.on('exit', (code, signal) => { if (!done) verdict('RIG-FAIL', { step: 'bridge-exited', code, signal, stderrTail }) })

let id = 0; const pending = new Map()
const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
const call = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); send({ jsonrpc: '2.0', id: i, method, params }) })
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(m.error) : p.res(m.result); return
  }
  if (m.method === 'session/request_permission') {
    const opt = m.params.options.find((o) => o.kind?.startsWith('allow')) ?? m.params.options[0]
    send({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: opt.optionId } } }); return
  }
  if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } })
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TIMEOUT = Symbol('timeout')
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => TIMEOUT)])
const prompt = (sid, text) => call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] })
const ended = (r) => r !== TIMEOUT && r?.stopReason === 'end_turn'

let sid
try {
  await call('initialize', { protocolVersion: 1, clientCapabilities: {} })
  sid = (await call('session/new', { cwd: WORK, mcpServers: [] })).sessionId
  try { await call('session/set_mode', { sessionId: sid, modeId: 'bypassPermissions' }) } catch {}
} catch (e) { verdict('RIG-FAIL', { step: 'session', error: e, stderrTail }) }
log('session', sid, cliVersion)

try {
  const a = await withTimeout(prompt(sid, 'Reply with just: hi'), 120_000)
  results.A = a === TIMEOUT ? 'timeout' : a.stopReason; log('A', results.A)
  if (!ended(a)) verdict('FAIL', { step: 'A' })
  await sleep(4000)

  const b = await withTimeout(prompt(sid, 'Launch exactly ONE background subagent with the Agent tool (subagent_type general-purpose, run_in_background true). Its task: run the Bash command `sleep 15` and then reply with the single word done. After launching it, reply with just the word launched and end your turn without waiting.'), 180_000)
  results.B = b === TIMEOUT ? 'timeout' : b.stopReason; log('B', results.B)
  if (!ended(b)) verdict('FAIL', { step: 'B' })
  await sleep(45_000) // the subagent finishes and its follow-up cycle runs

  const c0 = prompt(sid, 'Run the Bash command `sleep 20`, then reply with just: ok')
  await sleep(6000)
  const steer = await call('_session/steering', {
    sessionId: sid, prompt: [{ type: 'text', text: 'Side note from a teammate: when you finish, also say the word steered.' }],
    _meta: { steering: { idleBehavior: 'promptRequired', delivery: 'next' } },
  }).catch((e) => ({ error: e }))
  results.steer = steer; log('steer', JSON.stringify(steer))
  const c = await withTimeout(c0, 150_000)
  results.C = c === TIMEOUT ? 'timeout' : c.stopReason; log('C', results.C)
  if (steer?.outcome !== 'injected') verdict('RIG-FAIL', { step: 'C/steer-not-injected' })
  done = true
  verdict(ended(c) ? 'PASS' : 'FAIL', { step: 'C' })
} catch (e) {
  done = true
  verdict('FAIL', { step: 'error', error: e, stderrTail })
} finally {
  child.kill()
}
