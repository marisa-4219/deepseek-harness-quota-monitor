// End-to-end verification of the host half against the CURRENT harness seams.
//
// The plugin no longer installs a settings section through a helper, and it no
// longer mounts raw `webServer` routes:
//
//   * Settings (DSH >= 0.1.7) are DECLARED, not installed: the plugin exports a
//     `Config` schema marked `.volatile()` at the root, and the settings service
//     projects it into a form. `apply` therefore receives a `Volatile` wrapper
//     and reads `config.get()`.
//   * Endpoints mount as exact Fetch routes on `ctx.connection.fetch`, because
//     `/api` is claimed by the connection service, which applies the
//     browser-trust fence and session authentication before dispatch.
//
// This test drives the plugin through its own seams with fakes, so it verifies
// the contracts that actually broke without needing a live Harness, credentials,
// or network:
//
//   node test/verify-quota-e2e.mjs
//
// Covered:
//   1. the exported Config is a root-volatile schema whose nested provider paths
//      stay live-editable, and `apply` refuses a non-volatile config
//   2. every endpoint registers as an exact Fetch route with methods + body mode
//   3. GET /api/quota-monitor returns one snapshot per monitored provider
//   4. the llm/stream waterfall records usage; todayUsed reports totals and an
//      hourly series; the windows measurement reads them back
//   5. GET /api/quota-monitor/settings lists only preset-backed auto providers
//   6. provider removal drops the profile-patch entry (and no-ops when absent)
//   7. a balance preset that needs a missing credential reports `no-key`
//   8. the Command Code provider reports windows AND a credit balance from one
//      endpoint, including the derived monthly bar

import { apply, Config } from '../lib/index.js'

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
//
// Storage is redirected through the seams the plugin itself prefers — the
// settings document's directory for the usage checkpoint, and `profileContext`
// for the profile patch — rather than by overriding `$DSH_HOME`. That matters
// twice over: `$DSH_HOME` is also the anchor this module resolves schemastery
// from, and it must stay pointed at the real installation. A test that instead
// leaves these unset appends synthetic usage rows to the operator's real
// `$DSH_HOME/storages/quota-monitor-usage.jsonl`.

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'qm-e2e-'))
process.on('exit', () => { try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best effort */ } })

const settingsPath = path.join(tmpHome, 'settings.yaml')
writeFileSync(settingsPath, '# isolated test settings document\n')
const patchPath = path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml')
mkdirSync(path.dirname(patchPath), { recursive: true })
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

const fetchRoutes = [] // exact Fetch routes on the authenticated /api channel
const webServerRoutes = [] // must stay empty: /api is connection's
const events = new Map()

/** The resolved configuration section, as `config.get()` would return it. */
let resolvedConfig = {
  cacheTtlMs: 0,
  showTodayUsed: true,
  providers: {
    'opencode-go': {
      kind: 'windows',
      url: 'https://opencode.ai/zen/go/v1/usage',
      apiKeyEnv: 'OPENCODE_API_KEY',
      parse: { builtin: 'opencode-go-usage' },
      currency: 'USD',
    },
    commandcode: {
      kind: 'windows',
      url: 'https://api.commandcode.ai/alpha/billing/credits',
      apiKeyEnv: 'COMMANDCODE_API_KEY',
      parse: { builtin: 'commandcode-credits' },
      currency: 'USD',
      headers: { 'user-agent': 'deepseek-harness-quota-monitor' },
    },
  },
}

const ctx = {
  get(name) {
    // Redirects the usage checkpoint into the temp home: `storageDir` derives
    // from the settings document's directory, so this keeps the operator's real
    // usage file untouched.
    if (name === 'settings') return { documentPath: settingsPath, get: () => undefined }
    // Redirects profile-patch edits into the temp home.
    if (name === 'profileContext') return { patchPath, home: tmpHome, dir: path.dirname(patchPath), name: 'web' }
    if (name === 'connection') return { fetch: { register: (route) => { fetchRoutes.push(route); return async () => {} } } }
    // Only the working-metering providers have resolvable credentials; the
    // DeepSeek balance preset's reference is deliberately unconfigured.
    if (name === 'credentials') {
      return {
        resolve: async (ref) => (
          ref === 'OPENCODE_API_KEY' ? { value: 'oc-test', source: 'file' }
            : ref === 'COMMANDCODE_API_KEY' ? { value: 'cc-test', source: 'file' }
              : undefined
        ),
      }
    }
    if (name === 'llm') {
      return {
        listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'pi-ai', name: 'pi-ai' }],
        listConfigurableProviders: () => [{ provider: 'pi-ai', displayName: 'pi-ai' }],
      }
    }
    return undefined
  },
  on(event, listener) { events.set(event, listener); return () => {} },
  effect(callback) { callback(); return () => {} },
  webServer: { register: (route) => { webServerRoutes.push(route) } },
}

// network stub: the two usage shapes the builtin parsers expect
const realFetch = globalThis.fetch
const seenRequests = []
globalThis.fetch = async (url, init) => {
  seenRequests.push({ url: String(url), headers: init?.headers ?? {} })
  if (String(url).includes('opencode.ai')) {
    return new Response(JSON.stringify({
      usage: {
        rolling: { percent: 12, resetsAt: '2026-01-01T05:00:00Z' },
        weekly: { percent: 34, resetsAt: '2026-01-07T00:00:00Z' },
        monthly: { percent: 56, resetsAt: '2026-02-01T00:00:00Z' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (String(url).includes('commandcode.ai')) {
    return new Response(JSON.stringify({
      credits: {
        monthlyCredits: 42.5,
        purchasedCredits: 10,
        freeCredits: 0,
        belowThreshold: false,
        creditThreshold: 5,
        planId: 'individual-goat',
      },
      windowLimits: {
        limited: true,
        exceeded: '',
        fiveHour: { used: 4.5, cap: 14, exceeded: false, resetAt: 1790083955000 },
        weekly: { used: 12.0, cap: 35, exceeded: false, resetAt: 1790600000000 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}

console.log('1. declared volatile Config + apply')
ok(Config !== undefined && typeof Config.toJSON === 'function', 'exports the Config schema the settings service projects')
ok(Config.meta?.volatile === true, 'marks the root volatile, so nested provider paths stay live-editable')
{
  // The projection predicate the settings service uses to decide what a form
  // may edit: a volatile root makes every declared path editable, including the
  // dynamic provider map and its nested window array.
  const isVolatilePath = (schema, p) => {
    if (schema.meta?.volatile) return true
    const [key, ...rest] = p
    const child = key === undefined ? undefined : schema.dict?.[key]
    return child !== undefined && isVolatilePath(child, rest)
  }
  ok(isVolatilePath(Config, ['providers', 'commandcode', 'url']), 'providers.<name>.url is live-editable')
  ok(isVolatilePath(Config, ['providers', 'commandcode', 'windows', '0', 'seconds']), 'nested window fields are live-editable')
  ok(isVolatilePath(Config, ['autoDiscover']), 'a scalar field is live-editable')
}
{
  // apply() must refuse a config that is not the volatile wrapper, because that
  // is the only shape whose edits are observable.
  let threw = false
  try { apply(ctx, { providers: {} }) } catch { threw = true }
  ok(threw, 'apply() refuses a non-volatile config instead of silently freezing settings')
}
apply(ctx, { get: () => resolvedConfig })

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
ok(Object.keys(presets.presets).includes('commandcode'), 'exposes the Command Code preset')
eq(presets.systemProviders.map((s) => s.id).sort(), ['deepseek-official', 'pi-ai'], 'lists registered LLM providers by id')

console.log('\n5. auto-provider listing')
const settingsView = await (await route('GET', '/api/quota-monitor/settings')(new Request('http://dsh/api/quota-monitor/settings'))).json()
eq(settingsView.autoProviders.map((a) => a.provider), ['deepseek-official'], 'lists only providers with a known preset')
ok(!('value' in settingsView), 'leaves configuration reads to the shipped Remote settings transport')

console.log('\n6. provider removal from the profile patch')
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
const silent = await (await route('GET', '/api/quota-monitor?provider=deepseek-official')(new Request('http://dsh/api/quota-monitor?provider=deepseek-official'))).json()
eq(silent.error, 'no-key', 'a balance provider without a configured key reports no-key')
eq(silent.provider, 'deepseek-official', 'and still identifies the provider')

console.log('\n8. Command Code: windows + credit balance from one endpoint')
const cmd = await (await route('GET', '/api/quota-monitor?provider=commandcode')(new Request('http://dsh/api/quota-monitor?provider=commandcode'))).json()
eq(cmd.kind, 'windows', 'reports window kind')
const cmdW = Object.fromEntries(cmd.windows.map((w) => [w.label, w]))
eq(cmdW['5h'].percent, 32.1, 'fiveHour percent is derived from used/cap')
eq(cmdW['7d'].percent, 34.3, 'weekly percent is derived from used/cap')
eq(cmdW['5h'].usedMoney, 4.5, 'window keeps its used amount')
eq(cmdW['5h'].limitMoney, 14, 'window keeps its cap')
eq(cmdW['5h'].resetsAt, new Date(1790083955000).toISOString(), 'resetAt epoch-ms is normalised to ISO')
eq(cmdW['1m'].limitMoney, 70, 'monthly bar is derived from the planId allowance')
eq(cmdW['1m'].usedMoney, 17.5, 'monthly used is derived from remaining credits')
eq(cmd.balance.remaining, '52.5', 'credit balance rides along with the windows')
eq(cmd.balance.total, '70', 'plan allowance is reported as the balance total')
eq(cmd.balance.available, true, 'an empty-string `exceeded` means not blocked')
ok(
  seenRequests.some((r) => r.url.includes('commandcode.ai') && JSON.stringify(r.headers).includes('deepseek-harness-quota-monitor')),
  'sends the User-Agent the endpoint requires (Cloudflare 403s without one)',
)

globalThis.fetch = realFetch

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${String(failures)} assertion(s))`}`)
process.exitCode = failures === 0 ? 0 : 1
