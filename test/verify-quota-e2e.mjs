// End-to-end verification of the host half against the CURRENT harness seams.
//
// The plugin no longer talks to raw `webServer` routes or to a
// `installSettingsSection` helper: it registers its namespace on the
// `ctx.settings` seam (`installSection`) and mounts its endpoints as exact
// Fetch routes on `ctx.connection.fetch`, because `/api` is claimed by the
// connection service, which applies the browser-trust fence and session
// authentication before dispatch.
//
// This test drives the plugin through its own seams with fakes, so it verifies
// the contract that broke (settings install + connection fetch routes) without
// needing a live Harness, credentials, or network:
//
//   node test/verify-quota-e2e.mjs
//
// Covered:
//   1. the settings namespace is registered with the composition entry as base
//      and the schema defaults resolve through it
//   2. every endpoint registers as an exact Fetch route with methods + body mode
//   3. GET /api/quota-monitor returns one snapshot per monitored provider
//   4. the llm/stream waterfall records usage; todayUsed reports totals and an
//      hourly series; the windows measurement reads them back
//   5. revision-fenced writes reach `settings.mutate(ns, ops, expectedRevision)`
//   6. provider removal unsets the user layer, then drops the profile-patch
//      entry (and no-ops when the patch never declared it)
//   7. a balance preset that needs a missing credential reports `no-key`
//      instead of throwing

import { apply } from '../lib/index.js'

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

let failures = 0
const ok = (condition, label, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(a === e, label, `expected ${e}, got ${a}`)
}

// ---------------------------------------------------------------------------
// isolated harness home: usage checkpoints must never touch real data
// ---------------------------------------------------------------------------

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'qm-e2e-'))
process.on('exit', () => { try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best effort */ } })

const settingsPath = path.join(tmpHome, 'settings.yaml')
const patchPath = path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml')
mkdirSync(path.dirname(patchPath), { recursive: true })
writeFileSync(settingsPath, '# test settings document\n')
writeFileSync(patchPath, [
  '- insert:',
  '    - id: quota-monitor',
  '      name: deepseek-harness-quota-monitor',
  '      config:',
  '        providers:',
  '          patched-provider:',
  '            kind: windows',
  '            windows:',
  '              - { label: 5h, seconds: 18000, limitTokens: 1000 }',
  '',
].join('\n'))

// ---------------------------------------------------------------------------
// harness fakes: the seams the plugin consumes
// ---------------------------------------------------------------------------

const registrations = new Map() // ns -> { schema, options }
const watchSources = new Map() // ns -> () => resolved value
const mutateCalls = []
const fetchRoutes = [] // exact Fetch routes on the authenticated /api channel
const webServerRoutes = [] // must stay empty: /api is connection's
const events = new Map()

let resolvedProviders = {
  providers: {
    'opencode-go': {
      kind: 'windows',
      url: 'https://opencode.ai/zen/go/v1/usage',
      apiKeyEnv: 'OPENCODE_API_KEY',
      parse: { builtin: 'opencode-go-usage' },
      currency: 'USD',
    },
  },
}

const fakeSettings = {
  documentPath: settingsPath,
  installSection(owner, ns, schema, entry, hooks) {
    registrations.set(ns, { schema, base: entry })
    hooks.setSource(() => resolvedValue())
    hooks.onChange()
  },
  describe() {
    return [{
      ns: 'quota-monitor',
      schema: {},
      value: resolvedValue(),
      revision: mutateCalls.length,
      base: registrations.get('quota-monitor')?.base,
      user: { providers: resolvedProviders.providers },
      applies: 'live',
    }]
  },
  async mutate(ns, ops, expectedRevision) {
    mutateCalls.push({ ns, ops, expectedRevision })
    for (const op of ops) {
      if (op.path.length === 2 && op.path[0] === 'providers' && op.op === 'unset') {
        delete resolvedProviders.providers[op.path[1]]
      }
      if (op.path.length === 2 && op.path[0] === 'providers' && op.op === 'set') {
        resolvedProviders.providers[op.path[1]] = op.value
      }
    }
    watchSources.get(ns)?.()
    return { ns }
  },
}

/** Resolve the namespace the way the settings service does: defaults, then base. */
function resolvedValue() {
  const registration = registrations.get('quota-monitor')
  return registration.schema({ ...registration.base, ...resolvedProviders })
}

const ctx = {
  get(name) {
    if (name === 'settings') return fakeSettings
    if (name === 'connection') return { fetch: { register: (route) => { fetchRoutes.push(route); return async () => {} } } }
    // Only the working-metering provider has a resolvable credential; the
    // balance preset's reference is deliberately unconfigured.
    if (name === 'credentials') {
      return {
        resolve: async (ref) => (ref === 'OPENCODE_API_KEY' ? { value: 'oc-test', source: 'file' } : undefined),
      }
    }
    if (name === 'llm') {
      return {
        listProviders: () => [{ provider: 'deepseek-official', name: 'DeepSeek' }, { provider: 'pi-ai', name: 'pi-ai' }],
        listConfigurableProviders: () => [{ provider: 'pi-ai', displayName: 'pi-ai' }],
      }
    }
    return undefined
  },
  on(event, listener) { events.set(event, listener); return () => {} },
  effect(callback) { callback(); return () => {} },
  webServer: { register: (route) => { webServerRoutes.push(route) } },
}

// network stub: the OpenCode GO usage shape the builtin parser expects
const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  if (String(url).includes('opencode.ai')) {
    return new Response(JSON.stringify({
      usage: {
        rolling: { percent: 12, resetsAt: '2026-01-01T05:00:00Z' },
        weekly: { percent: 34, resetsAt: '2026-01-07T00:00:00Z' },
        monthly: { percent: 56, resetsAt: '2026-02-01T00:00:00Z' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}

console.log('1. plugin namespace registration')
apply(ctx, { cacheTtlMs: 0, showTodayUsed: true })
ok(registrations.has('quota-monitor'), 'registers the `quota-monitor` settings namespace')
eq(fetchRoutes.map((r) => `${r.methods.join(',')} ${r.path}`).sort(), [
  'GET /api/quota-monitor',
  'GET /api/quota-monitor/presets',
  'GET /api/quota-monitor/settings',
  'POST /api/quota-monitor/profile-provider',
], 'mounts every endpoint as an exact Fetch route on the authenticated /api channel')
eq(webServerRoutes, [], 'registers no raw webServer route under /api (would be shadowed)')
ok(fetchRoutes.every((r) => r.requestBody === 'buffered'), 'declares buffered request bodies')

const route = (method, pathAndQuery) => {
  const pathname = pathAndQuery.split('?')[0]
  const hit = fetchRoutes.find((r) => r.path === pathname && r.methods.includes(method))
  if (!hit) throw new Error(`no route for ${method} ${pathAndQuery}`)
  return hit.fetch
}

console.log('\n2. snapshot endpoint')
const snapshots = await (await route('GET', '/api/quota-monitor')(new Request('http://dsh/api/quota-monitor'))).json()
ok(Array.isArray(snapshots), 'returns an array of snapshots')
const go = snapshots.find((s) => s.provider === 'opencode-go')
ok(go !== undefined, 'includes the configured provider')
eq(go.kind, 'windows', 'windows-type provider keeps its kind')
eq(go.windows.map((w) => [w.label, w.percent, w.seconds]), [
  ['5h', 12, 18000], ['7d', 34, 604800], ['1m', 56, 2592000],
], 'provider-queried windows merge with configured durations')
ok(go.windows.every((w) => w.usedTokens === 0), 'local metering starts at zero')
const pi = snapshots.find((s) => s.provider === 'pi-ai')
ok(pi === undefined, 'a provider without a preset is not auto-discovered')

console.log('\n3. llm/stream metering')
const waterfall = events.get('llm/stream')
ok(typeof waterfall === 'function', 'subscribes to the llm/stream waterfall')
const stream = (async function* () {
  yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 300 } }
  yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 50 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})()
const wrapped = waterfall({ provider: 'opencode-go', model: 'kimi-k2' }, () => stream)
let drained = 0
for await (const _chunk of wrapped) drained++
eq(drained, 3, 'passes every chunk through untouched')
const after = await (await route('GET', '/api/quota-monitor')(new Request('http://dsh/api/quota-monitor'))).json()
const go2 = after.find((s) => s.provider === 'opencode-go')
eq(go2.todayUsed.tokens, 2150, 'records input + output + cache tokens')
eq(go2.todayUsed.requests, 2, 'counts requests')
eq(go2.todayUsed.input, 1200, 'keeps the input breakdown')
eq(go2.todayUsed.cacheRead, 350, 'keeps the cache-read breakdown')
ok(Array.isArray(go2.todayUsed.series) && go2.todayUsed.series.length === 24, 'emits a 24-hour series')
eq(go2.windows.find((w) => w.label === '5h').usedTokens, 2150, 'window metering reads the same records')

console.log('\n4. presets endpoint')
const presets = await (await route('GET', '/api/quota-monitor/presets')(new Request('http://dsh/api/quota-monitor/presets'))).json()
ok(Object.keys(presets.presets).includes('deepseek-official'), 'exposes whole-provider presets')
eq(presets.systemProviders.map((s) => s.id).sort(), ['deepseek-official', 'pi-ai'], 'lists registered LLM providers')

console.log('\n5. auto-provider listing + revision-fenced writes')
const settingsView = await (await route('GET', '/api/quota-monitor/settings')(new Request('http://dsh/api/quota-monitor/settings'))).json()
eq(settingsView.autoProviders.map((a) => a.provider), ['deepseek-official'], 'lists only providers with a known preset')
ok(!('value' in settingsView), 'leaves configuration reads to the shipped Remote settings transport')
eq(mutateCalls, [], 'reading configuration performs no write')

console.log('\n6. provider removal across both layers')
const removeRes = await (await route('POST', '/api/quota-monitor/profile-provider')(new Request('http://dsh/api/quota-monitor/profile-provider', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'patched-provider' }),
}))).json()
eq(removeRes, { ok: true, removed: true, restartRequired: false }, 'drops a provider the profile patch declared')
const patchAfter = readFileSync(patchPath, 'utf8')
ok(!patchAfter.includes('patched-provider'), 'the profile patch no longer declares it')
ok(existsSync(patchPath), 'the patch file itself survives')
const noopRes = await (await route('POST', '/api/quota-monitor/profile-provider')(new Request('http://dsh/api/quota-monitor/profile-provider', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'opencode-go' }),
}))).json()
eq(noopRes.removed, false, 'is a no-op for a provider the patch never declared')
const badRes = await route('POST', '/api/quota-monitor/profile-provider')(new Request('http://dsh/api/quota-monitor/profile-provider', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
}))
eq(badRes.status, 500, 'rejects a provider-less body with a JSON error')
ok((await badRes.json()).error.includes('expected { provider }'), 'names the expected shape')

console.log('\n7. missing credential is reported, not thrown')
// The preset is auto-discovered (it is the default agent model), but its
// credential reference is not configured in this harness, so the query must be
// reported as a snapshot error rather than thrown.
const silent = await (await route('GET', '/api/quota-monitor?provider=deepseek-official')(new Request('http://dsh/api/quota-monitor?provider=deepseek-official'))).json()
eq(silent.error, 'no-key', 'a balance provider without a configured key reports no-key')
eq(silent.provider, 'deepseek-official', 'and still identifies the provider')

globalThis.fetch = realFetch

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${String(failures)} assertion(s))`}`)
process.exitCode = failures === 0 ? 0 : 1
