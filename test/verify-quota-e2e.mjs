// End-to-end verification: boot the plugin host half with a mocked ctx and a
// real OpenCode GO provider config, drive the registered route handler, and
// inspect the snapshot JSON. Run from this directory: `node verify-quota-e2e.mjs`.
// Requires real credentials at $DSH_HOME/.credentials.yaml (DSH_HOME defaults
// to ~/.dsh).
import { apply } from '../lib/index.js'

import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const creds = Object.fromEntries(
  readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8')
    .split('\n').filter((l) => l.includes(':'))
    .map((l) => l.split(':', 2).map((x) => x.trim())))

// isolated storage: usage checkpoints go to a temp dir, never the real
// $DSH_HOME/storages (the waterfall below records simulated calls)
const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'qm-e2e-'))
const fakeSettingsPath = path.join(tmpHome, 'settings.yaml')
process.on('exit', () => { try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best effort */ } })

let routeHandlers = new Map()
const calls = []
const mutateCalls = []

const settingsMock = {
  documentPath: fakeSettingsPath,
  get: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
  mutate: async (ns, ops) => { mutateCalls.push({ ns, ops }); return {} },
}

const ctx = {
  get: (n) => {
    if (n === 'settings') return settingsMock
    if (n === 'credentials') {
      return {
        resolve: async (ref) => creds[ref] ? { value: creds[ref], source: 'file' } : undefined,
      }
    }
    if (n === 'llm') {
      // simulate the harness LLM registry: deepseek-official + a pi-ai route
      return { listProviders: () => [{ provider: 'deepseek-official' }, { provider: 'pi-ai' }] }
    }
    return undefined
  },
  on: (event, fn) => { calls.push(['on', event, fn]); return () => {} },
  inject: (deps, cb) => {
    cb({
      settings: {
        register: (ns, schema, opts) => {
          console.log('settings.register:', ns)
          return { get: () => opts.base ?? {}, watch: () => {} }
        },
      },
      effect: () => {},
    })
    return () => {}
  },
  effect: () => {},
  webServer: {
    register: (route) => { routeHandlers.set(route.path, route.handler); console.log('route:', route.kind, route.path) },
  },
}

apply(ctx, {
  cacheTtlMs: 0,
  showTodayUsed: true,
  providers: {
    'opencode-go': {
      kind: 'windows',
      url: 'https://opencode.ai/zen/go/v1/usage',
      apiKeyEnv: 'OPENCODE_API_KEY',
      parse: { builtin: 'opencode-go-usage' },
    },
  },
})

// presets endpoint
const presetsRes = {
  writeHead: () => {},
  end: (body) => {
    const p = JSON.parse(body)
    console.log('presets:', Object.keys(p).join(', '))
  },
}
await routeHandlers.get('/api/quota-monitor/presets')({ method: 'GET', url: '/api/quota-monitor/presets' }, presetsRes)

// settings GET -> resolved value
const settingsGetRes = {
  writeHead: () => {},
  end: (body) => {
    const v = JSON.parse(body)
    console.log('settings GET providers:', Object.keys(v.value.providers || {}).join(', '))
    console.log('settings GET disabledProviders:', JSON.stringify(v.value.disabledProviders || {}))
    console.log('settings GET autoProviders:', (v.autoProviders || []).map((a) => `${a.provider}${a.disabled ? '(off)' : ''}`).join(', '))
  },
}
await routeHandlers.get('/api/quota-monitor/settings')({ method: 'GET', url: '/api/quota-monitor/settings' }, settingsGetRes)

// settings POST -> host-side mutate
const settingsPostRes = {
  writeHead: () => {},
  end: (body) => {
    const out = JSON.parse(body)
    console.log('settings POST:', out.ok === true ? 'ok' : JSON.stringify(out))
  },
}
await routeHandlers.get('/api/quota-monitor/settings')({
  method: 'POST',
  url: '/api/quota-monitor/settings',
  [Symbol.asyncIterator]: async function* () {
    yield JSON.stringify({ ops: [
      { op: 'set', path: ['lowBalanceThreshold'], value: 15 },
      { op: 'set', path: ['disabledProviders', 'pi-ai'], value: true },
    ] })
  },
}, settingsPostRes)
console.log('mutate calls:', mutateCalls.map((m) => m.ns + ':' + m.ops.length).join(', '))

const res = {
  writeHead: (code, headers) => { console.log('status:', code) },
  end: (body) => {
    const data = JSON.parse(body)
    if (!Array.isArray(data)) {
      console.log('ERROR BODY:', body)
      return
    }
    console.log('snapshots:', data.map((s) => s.provider).join(', '))
    const go = data.find((s) => s.provider === 'opencode-go')
    console.log('opencode-go kind:', go.kind)
    for (const w of go.windows) {
      console.log(`  ${w.label}: percent=${w.percent} resetsAt=${w.resetsAt} usedTokens=${w.usedTokens}`)
    }
    const ds = data.find((s) => s.provider === 'deepseek-official')
    console.log('deepseek:', ds.error ?? `${ds.kind} balance=${JSON.stringify(ds.balance)}`)
    const dsToday = ds && ds.todayUsed
    console.log('deepseek todayUsed:', dsToday ? JSON.stringify(dsToday) : 'none')
    const pi = data.find((s) => s.provider === 'pi-ai')
    console.log('pi-ai (no preset, must NOT auto-discover):', pi === undefined ? 'absent (ok)' : 'PRESENT (unexpected)')
  },
}

await routeHandlers.get('/api/quota-monitor')({ method: 'GET', url: '/api/quota-monitor' }, res)

// simulate two model calls through the captured llm/stream waterfall: usage
// chunks with cache shares and a provider-reported cost on one of them
const streamListener = calls.find((c) => c[0] === 'on' && c[1] === 'llm/stream')[2]
const fakeStream = (async function* () {
  yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 300 } }
  yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 50, cost: 0.005 } }
  yield { type: 'finish', kind: 'ok' }
})()
const wrapped = streamListener({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }, () => fakeStream)
for await (const _c of wrapped) { /* drain */ }

// snapshot again: todayUsed should carry breakdown + cache ratio + usage cost
const res2 = { ...res }
await routeHandlers.get('/api/quota-monitor')({ method: 'GET', url: '/api/quota-monitor' }, res2)
console.log('events:', calls.map((c) => c[1]).join(', '))
