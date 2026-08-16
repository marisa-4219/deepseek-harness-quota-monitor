/**
 * deepseek-harness-quota-monitor — host half.
 *
 * Multi-provider quota monitoring for DeepSeek Harness:
 *
 *   - balance type:   actively query a provider usage/balance API (url +
 *                     credential reference + JS parser), e.g. DeepSeek
 *                     GET /user/balance via the built-in `deepseek-balance`
 *                     parser.
 *   - windows type:   local sliding-window metering over the `llm/stream`
 *                     waterfall (tokens/requests per window, persisted as a
 *                     JSONL checkpoint in $DSH_HOME/storages). No provider
 *                     API needed.
 *
 * Every provider is just configuration (Settings -> 额度监控): url, apiKeyEnv
 * reference, and a JS parser in one of three forms — `builtin` (registry),
 * `source` (inline function body), or `file` (path to a .js module). Adding a
 * provider never requires code changes.
 *
 * Client-side UI (lib/client.js): sidebar widget on `sidebar.footer.action`
 * and the settings section on `settings.section`.
 *
 * Dependency note: this bundle is pnpm-linked into the profile's node_modules
 * as a symlink, so Node's upward node_modules lookup from this file's real
 * location would fail. Harness packages (schemastery, dsh-settings) are
 * therefore resolved explicitly with createRequire anchored at the profile
 * directory; only node:* builtins are imported statically.
 */
import { createRequire } from 'node:module'
import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

export const name = 'quota-monitor'
export const inject = ['webServer']

const QUERY_TIMEOUT_MS = 30000
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const DEEPSEEK_PROVIDER = 'deepseek-official'
const DAY_MS = 86400000
const USAGE_RETENTION_DAYS = 90

// ---------------------------------------------------------------------------
// Harness dependency resolution (see dependency note above)
// ---------------------------------------------------------------------------

let schemaModule = null
let settingsModule = null

/** Storage home: prefers the settings document location (accurate under any
* DSH_HOME); falls back to DSH_HOME or ~/.dsh. */
function harnessHome(ctx) {
  try {
    const doc = ctx.get('settings')?.documentPath
    if (doc) return path.dirname(doc)
  } catch { /* fall through */ }
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** Dependency resolution anchor: the real harness installation, independent of
* the settings document path (which test harnesses may point at temp dirs). */
function harnessRequire() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return createRequire(path.join(home, 'profiles', 'web', '__quota_monitor_noop__.cjs'))
}

function ensureHarnessDeps() {
  if (schemaModule && settingsModule) return
  const req = harnessRequire()
  const schemaPkg = req('@deepseek-ai/schemastery')
  schemaModule = schemaPkg && schemaPkg.object ? schemaPkg : (schemaPkg.default ?? schemaPkg)
  const settingsPkg = req('@deepseek-ai/dsh-settings')
  // require(esm) returns the module namespace (named exports + default);
  // prefer the namespace so installSettingsSection/settingsNamespace resolve.
  settingsModule = settingsPkg && typeof settingsPkg.installSettingsSection === 'function'
    ? settingsPkg
    : (settingsPkg.default ?? settingsPkg)
}

// ---------------------------------------------------------------------------
// Built-in parsers: raw JSON from the queried url -> { kind, balance? }.
// A `windows`-type query may additionally return { windows: [{label, limitTokens}] }
// to supply quota limits from the provider; used amounts always come from the
// local meter ("this is DSH's own record").
// ---------------------------------------------------------------------------

const BUILTINS = {
  'deepseek-balance': (raw) => {
    const info = raw && Array.isArray(raw.balance_infos) ? raw.balance_infos[0] : undefined
    if (!info) throw new Error('deepseek-balance: response missing balance_infos[0]')
    return {
      kind: 'balance',
      balance: {
        currency: info.currency,
        total: info.total_balance,
        granted: info.granted_balance,
        toppedUp: info.topped_up_balance,
        available: raw.is_available === true,
      },
    }
  },
  // OpenCode GO: GET https://opencode.ai/zen/go/v1/usage ->
  // { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
  'opencode-go-usage': (raw) => {
    const u = raw && raw.usage
    if (!u) throw new Error('opencode-go-usage: response missing usage')
    const pick = (key, label, seconds) => {
      const w = u[key]
      if (!w || typeof w.percent !== 'number') return null
      return { label, seconds, percent: w.percent, resetsAt: w.resetsAt }
    }
    const windows = [
      pick('rolling', '5h', 5 * 3600),
      pick('weekly', '7d', 7 * 86400),
      pick('monthly', '1m', 30 * 86400),
    ].filter(Boolean)
    if (!windows.length) throw new Error('opencode-go-usage: no usable windows in response')
    return { kind: 'windows', windows }
  },
  // Generic balance shapes: { balance_infos: [...] } (DeepSeek-like) or a flat
  // { balance|total_balance|total|amount, currency } (optionally under `data`).
  'generic-balance': (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('generic-balance: response is not an object')
    if (Array.isArray(raw.balance_infos) && raw.balance_infos[0]) {
      const i = raw.balance_infos[0]
      return {
        kind: 'balance',
        balance: {
          currency: i.currency,
          total: i.total_balance ?? i.total,
          granted: i.granted_balance ?? i.granted,
          toppedUp: i.topped_up_balance ?? i.topped_up,
          available: raw.is_available === true,
        },
      }
    }
    const o = raw.data && typeof raw.data === 'object' ? raw.data : raw
    const total = o.balance ?? o.total_balance ?? o.total ?? o.amount
    if (total == null) throw new Error('generic-balance: no balance/total_balance/total/amount field found')
    return {
      kind: 'balance',
      balance: {
        currency: o.currency ?? o.currency_code,
        total: String(total),
        granted: o.granted_balance ?? o.granted,
        toppedUp: o.topped_up_balance ?? o.topped_up,
        available: o.is_available !== false,
      },
    }
  },
  // Generic percent windows: { usage: { <key>: { percent, resetsAt } } } —
  // any window key; seconds are matched from the configured windows by label.
  'generic-percent-windows': (raw) => {
    const u = raw && raw.usage
    if (!u || typeof u !== 'object') throw new Error('generic-percent-windows: response missing usage object')
    const windows = []
    for (const [key, w] of Object.entries(u)) {
      if (w && typeof w === 'object' && typeof w.percent === 'number') {
        windows.push({ label: key, percent: w.percent, resetsAt: w.resetsAt })
      }
    }
    if (!windows.length) throw new Error('generic-percent-windows: no percent windows found')
    return { kind: 'windows', windows }
  },
  // new-api (one-api family): GET /api/user/self with a System Access Token
  // (Bearer prefix per cc-switch usage) + `New-Api-User` header ->
  // { success, data: { group, quota, used_quota, ... } } where quota is an
  // integer number of units; money = units / 500000 (USD).
  'new-api-self': (raw) => {
    const d = raw && raw.data
    if (!d || typeof d.quota !== 'number') throw new Error('new-api: response missing data.quota')
    const perUnit = 500000
    const toMoney = (units) => (units / perUnit).toFixed(2)
    return {
      kind: 'balance',
      balance: {
        currency: 'USD',
        remaining: toMoney(d.quota),
        ...(typeof d.used_quota === 'number' ? { used: toMoney(d.used_quota) } : {}),
        total: toMoney(d.quota + (typeof d.used_quota === 'number' ? d.used_quota : 0)),
      },
    }
  },
  // sub2api: GET /api/platform-quotas (Bearer, platform API key) ->
  // { data: [ { platform, daily_limit_usd, weekly_limit_usd, monthly_limit_usd,
  //   daily_usage_usd, weekly_usage_usd, monthly_usage_usd, ... } ] }.
  // opts.platform selects one platform; defaults to the first entry.
  'sub2api-platform-quotas': (raw, opts) => {
    const list = raw?.data ?? raw
    const arr = Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : null
    if (!arr || !arr.length) throw new Error('sub2api: expected an array of platform quotas')
    const target = opts?.platform
    const p = target ? arr.find((x) => String(x.platform) === String(target)) : arr[0]
    if (!p) throw new Error(`sub2api: platform "${target}" not found in response`)
    const w = (label, seconds, limitUsd, usedUsd) => ({
      label,
      seconds,
      ...(limitUsd != null && Number.isFinite(Number(limitUsd)) ? { limitMoney: Number(limitUsd) } : {}),
      ...(usedUsd != null && Number.isFinite(Number(usedUsd)) ? { usedMoney: Number(usedUsd) } : {}),
    })
    return {
      kind: 'windows',
      windows: [
        w('1d', 86400, p.daily_limit_usd, p.daily_usage_usd),
        w('7d', 604800, p.weekly_limit_usd, p.weekly_usage_usd),
        w('1m', 2592000, p.monthly_limit_usd, p.monthly_usage_usd),
      ],
    }
  },
  // sub2api /v1/usage (OpenAI-compatible face): GET /v1/usage with a platform
  // API key ->
  // { remaining (| quota.remaining | balance), unit (| quota.unit), is_active }
  'sub2api-usage': (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('sub2api: response is not an object')
    const remaining = raw.remaining ?? raw.quota?.remaining ?? raw.balance
    if (remaining == null) throw new Error('sub2api: no remaining/quota.remaining/balance field')
    const unit = raw.unit ?? raw.quota?.unit ?? 'USD'
    return {
      kind: 'balance',
      balance: {
        currency: unit,
        total: String(remaining),
        available: raw.is_active ?? raw.isValid ?? true,
      },
    }
  },
}

/** Resolve a parser configuration to an async function (raw) -> snapshot part. */
async function loadParser(parse) {
  if (!parse) return null
  if (parse.builtin) {
    const fn = BUILTINS[parse.builtin]
    if (!fn) throw new Error(`quota-monitor: unknown builtin parser "${parse.builtin}"`)
    return fn
  }
  if (parse.source) {
    return new Function('raw', `"use strict"; return (${parse.source})(raw)`) // eslint-disable-line no-new-func
  }
  if (parse.file) {
    const mod = await import(pathToFileURL(path.resolve(parse.file)).href)
    const fn = mod.default ?? mod
    if (typeof fn !== 'function') throw new Error(`quota-monitor: parser file "${parse.file}" must export a function`)
    return fn
  }
  return null
}

// ---------------------------------------------------------------------------
// Whole-provider presets: one pick fills kind/url/apiKeyEnv/parse for the
// settings form (and is used implicitly for auto-discovered LLM providers).
// ---------------------------------------------------------------------------

const PROVIDER_PRESETS = {
  'deepseek-official': {
    label: 'DeepSeek 官方',
    kind: 'balance',
    url: DEEPSEEK_BALANCE_URL,
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    parse: { builtin: 'deepseek-balance' },
    note: '官方余额 API（余额型）',
    currency: 'CNY',
  },
  'opencode-go': {
    label: 'OpenCode GO 订阅',
    kind: 'windows',
    url: 'https://opencode.ai/zen/go/v1/usage',
    apiKeyEnv: 'OPENCODE_API_KEY',
    parse: { builtin: 'opencode-go-usage' },
    note: '5h/7d/1m 三窗口用量百分比（限额型，美元计费）',
    currency: 'USD',
  },
  'new-api': {
    label: 'new-api 网关',
    kind: 'balance',
    url: 'http://localhost:3000/api/user/self',
    apiKeyEnv: 'NEWAPI_TOKEN',
    headers: { 'New-Api-User': '1' },
    parse: { builtin: 'new-api-self' },
    note: 'one-api 系网关额度（Bearer + New-Api-User 头改成你的用户 id；quota ÷ 500000 = 美元）',
    currency: 'USD',
  },
  'sub2api': {
    label: 'sub2api 网关',
    kind: 'balance',
    url: 'http://localhost:8080/v1/usage',
    apiKeyEnv: 'SUB2API_API_KEY',
    parse: { builtin: 'sub2api-usage' },
    note: '订阅配额分发网关：/v1/usage 剩余额度（余额型）；高级：平台配额窗口见内置解析器 sub2api-platform-quotas',
    currency: 'USD',
  },
}

// ---------------------------------------------------------------------------
// Local usage store: append-only JSONL checkpoint under $DSH_HOME/storages.
// ---------------------------------------------------------------------------

function storageDir(ctx) {
  const dir = path.join(harnessHome(ctx), 'storages')
  try { mkdirSync(dir, { recursive: true }) } catch { /* best effort */ }
  return dir
}

function createUsageStore(dir) {
  const file = path.join(dir, 'quota-monitor-usage.jsonl')
  const rows = []
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (typeof row.at === 'number' && typeof row.tokens === 'number') rows.push(row)
      } catch { /* skip corrupt lines */ }
    }
  }
  const cutoff = Date.now() - USAGE_RETENTION_DAYS * DAY_MS
  let i = 0
  while (i < rows.length && rows[i].at < cutoff) i++
  if (i > 0) rows.splice(0, i)

  return {
    /**
     * Record one model call for a provider. `tokens` is the billable total
     * (input + output + cache); the optional breakdown keeps the cached share
     * and the model id for cache-ratio and per-model cost estimation. Older
     * checkpoint rows without a breakdown keep working.
     */
    record(provider, tokens, breakdown) {
      const row = { at: Date.now(), provider, tokens, ...(breakdown ?? {}) }
      rows.push(row)
      try { appendFileSync(file, `${JSON.stringify(row)}\n`) } catch { /* best effort */ }
      return row
    },
    /**
     * Aggregate token/request totals for one provider over the trailing
     * `seconds` window. Older checkpoint rows always carry `provider`, so no
     * fallback is needed.
     */
    since(seconds, provider) {
      const from = Date.now() - seconds * 1000
      let tokens = 0
      let requests = 0
      for (const r of rows) if (r.provider === provider && r.at >= from) { tokens += r.tokens; requests++ }
      return { tokens, requests }
    },
    /**
     * Aggregate one provider's usage since local midnight. Totals plus a
     * per-model breakdown ({model, tokens, input, output, cacheRead, cacheWrite})
     * so sessions that used different models across the day price correctly,
     * and an hourly token series (24 buckets) for the today chart.
     */
    today(provider) {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      const from = d.getTime()
      const agg = { tokens: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
      const byModel = new Map()
      // hourly buckets: { t: total, i: input, o: output, c: cacheRead }
      const series = new Array(24).fill(null).map(() => ({ t: 0, i: 0, o: 0, c: 0 }))
      for (const r of rows) {
        if (r.provider !== provider || r.at < from) continue
        agg.tokens += r.tokens
        agg.requests++
        if (typeof r.input === 'number') agg.input += r.input
        if (typeof r.output === 'number') agg.output += r.output
        if (typeof r.cacheRead === 'number') agg.cacheRead += r.cacheRead
        if (typeof r.cacheWrite === 'number') agg.cacheWrite += r.cacheWrite
        if (typeof r.cost === 'number') agg.cost += r.cost
        const hour = Math.floor((r.at - from) / 3600000)
        if (hour >= 0 && hour < 24) {
          series[hour].t += r.tokens
          if (typeof r.input === 'number') series[hour].i += r.input
          if (typeof r.output === 'number') series[hour].o += r.output
          if (typeof r.cacheRead === 'number') series[hour].c += r.cacheRead
        }
        if (r.model) {
          let m = byModel.get(r.model)
          if (!m) { m = { model: r.model, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; byModel.set(r.model, m) }
          m.tokens += r.tokens
          if (typeof r.input === 'number') m.input += r.input
          if (typeof r.output === 'number') m.output += r.output
          if (typeof r.cacheRead === 'number') m.cacheRead += r.cacheRead
          if (typeof r.cacheWrite === 'number') m.cacheWrite += r.cacheWrite
          if (typeof r.cost === 'number') m.cost += r.cost
        }
      }
      return { ...agg, byModel: [...byModel.values()], series }
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, entryConfig) {
  ensureHarnessDeps()
  const Schema = schemaModule
  const { installSettingsSection, settingsNamespace } = settingsModule

  // --- config schema — everything configurable, layered as schema defaults
  // < cordis.yml entry config < user settings document ---------------------
  const WindowSchema = Schema.object({
    label: Schema.string().required(),
    seconds: Schema.number().required(),
    limitTokens: Schema.number(),
    limitRequests: Schema.number(),
  })
  const ParserSchema = Schema.object({
    builtin: Schema.string(),
    source: Schema.string(),
    file: Schema.string(),
  })
  const ProviderSchema = Schema.object({
    kind: Schema.union(['balance', 'windows']).required(),
    url: Schema.string(),
    apiKeyEnv: Schema.string().role('credential-ref'),
    headers: Schema.dict(Schema.string()),
    parse: ParserSchema,
    windows: Schema.array(WindowSchema),
    lowBalanceThreshold: Schema.number(),
    currency: Schema.string().default('CNY'),
    // 'raw': send the credential as-is (no `Bearer ` prefix), e.g. new-api's
    // System Access Token; 'platform': sub2api-style multi-platform selection
    auth: Schema.union(['bearer', 'raw']).default('bearer'),
    platform: Schema.string(),
  })
  const Config = Schema.object({
    refreshMs: Schema.number().default(300000),
    cacheTtlMs: Schema.number().default(60000),
    lowBalanceThreshold: Schema.number().default(20),
    windows: Schema.array(WindowSchema).default([
      { label: '5h', seconds: 5 * 3600 },
      { label: '7d', seconds: 7 * 86400 },
      { label: '1m', seconds: 30 * 86400 },
    ]),
    providers: Schema.dict(ProviderSchema).default({}),
    showTodayUsed: Schema.boolean().default(true),
    // providers disabled by the user ({ [id]: true }); disabled providers are
    // neither monitored nor shown in the widget, whether they come from the
    // auto-discovery list or manual configuration
    disabledProviders: Schema.dict(Schema.boolean()).default({}),
    // off: only manually configured providers are monitored; on (default):
    // the current default provider and every registered LLM provider are
    // auto-monitored (with presets providing query config for known ones)
    autoDiscover: Schema.boolean().default(true),
  })
  const NS = settingsNamespace('quota-monitor')

  let current = () => entryConfig
  let cfg = entryConfig

  const refreshConfig = () => {
    const next = { ...current() }
    next.providers = next.providers ?? {}
    cfg = next
  }
  installSettingsSection(ctx, NS, Config, entryConfig, {
    setSource: (fn) => { current = fn },
    onChange: refreshConfig,
  })
  refreshConfig()

  const usage = createUsageStore(storageDir(ctx))
  const rateLimits = new Map() // provider -> { at, retryAfterMs }
  const cache = new Map() // provider -> { at, snapshot }

  const recordRateLimit = (provider, retryAfterMs) => {
    rateLimits.set(provider, { at: Date.now(), retryAfterMs })
  }

  const measureUsage = (pcfg, providerName) => {
    const windows = (pcfg && pcfg.windows && pcfg.windows.length ? pcfg.windows : cfg.windows ?? [])
    return windows.map((w) => {
      const m = usage.since(w.seconds, providerName)
      return {
        label: w.label,
        seconds: w.seconds,
        limitTokens: w.limitTokens,
        limitRequests: w.limitRequests,
        usedTokens: m.tokens,
        usedRequests: m.requests,
      }
    })
  }

  const resolveKey = async (apiKeyEnv) => {
    if (!apiKeyEnv) return undefined
    const credentials = ctx.get('credentials')
    try {
      const hit = credentials ? await credentials.resolve(apiKeyEnv) : undefined
      if (hit) return hit
    } catch { /* fall through to env */ }
    const env = process.env[apiKeyEnv]
    return env ? { value: env, source: 'env' } : undefined
  }

  const fail = (providerName, error, kind = 'balance') => ({
    provider: providerName,
    kind,
    fetchedAt: Date.now(),
    error,
  })

  const queryBalance = async (providerName, pcfg) => {
    const cached = cache.get(providerName)
    if (cached && Date.now() - cached.at < cfg.cacheTtlMs) return cached.snapshot
    const key = await resolveKey(pcfg.apiKeyEnv)
    if (!key) return fail(providerName, 'no-key')
    let res
    try {
      res = await fetch(pcfg.url, {
        method: 'GET',
        headers: {
          authorization: pcfg.auth === 'raw' ? key.value : `Bearer ${key.value}`,
          ...(pcfg.headers ?? {}),
        },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      })
    } catch {
      return fail(providerName, 'network')
    }
    if (!res.ok) return fail(providerName, `http-${res.status}`)
    let raw
    try { raw = await res.json() } catch { return fail(providerName, 'bad-json') }
    try {
      const parser = await loadParser(pcfg.parse)
      const parsed = parser ? await parser(raw, { platform: pcfg.platform }) : { kind: 'balance' }
      const snapshot = {
        provider: providerName,
        kind: 'balance',
        fetchedAt: Date.now(),
        balance: parsed.balance,
      }
      cache.set(providerName, { at: Date.now(), snapshot })
      return snapshot
    } catch (e) {
      return fail(providerName, `parse:${String(e.message ?? e)}`)
    }
  }

  /** Query a windows-type usage API; parser entries carry percent/resetsAt/limits. */
  const queryWindows = async (providerName, pcfg) => {
    const cached = cache.get(providerName)
    if (cached && Date.now() - cached.at < cfg.cacheTtlMs) return cached.snapshot
    const key = await resolveKey(pcfg.apiKeyEnv)
    if (!key) return fail(providerName, 'no-key', 'windows')
    let res
    try {
      res = await fetch(pcfg.url, {
        method: 'GET',
        headers: {
          authorization: pcfg.auth === 'raw' ? key.value : `Bearer ${key.value}`,
          accept: 'application/json',
          ...(pcfg.headers ?? {}),
        },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      })
    } catch {
      return fail(providerName, 'network', 'windows')
    }
    if (!res.ok) return fail(providerName, `http-${res.status}`, 'windows')
    let raw
    try { raw = await res.json() } catch { return fail(providerName, 'bad-json', 'windows') }
    try {
      const parser = await loadParser(pcfg.parse)
      const parsed = parser ? await parser(raw, { platform: pcfg.platform }) : { kind: 'windows' }
      const snapshot = {
        provider: providerName,
        kind: 'windows',
        fetchedAt: Date.now(),
        windows: parsed.windows ?? [],
      }
      cache.set(providerName, { at: Date.now(), snapshot })
      return snapshot
    } catch (e) {
      return fail(providerName, `parse:${String(e.message ?? e)}`, 'windows')
    }
  }

  /**
   * Merge provider-queried window entries with the configured window skeleton:
   * parser entries win per label (percent/resetsAt/limits), local metering
   * still supplies usedTokens/usedRequests for every window with a duration.
   */
  const mergeWindows = (pcfg, parsedWindows, providerName) => {
    const cfgWindows = (pcfg && pcfg.windows && pcfg.windows.length ? pcfg.windows : cfg.windows ?? [])
    const byLabel = new Map(cfgWindows.map((w) => [w.label, w]))
    if (!parsedWindows || !parsedWindows.length) return measureUsage(pcfg, providerName)
    return parsedWindows.map((pw) => {
      const cw = byLabel.get(pw.label)
      const seconds = pw.seconds ?? cw?.seconds
      const local = seconds ? usage.since(seconds, providerName) : null
      return {
        label: pw.label,
        seconds,
        limitTokens: pw.limitTokens ?? cw?.limitTokens,
        limitRequests: pw.limitRequests ?? cw?.limitRequests,
        limitMoney: pw.limitMoney,
        usedMoney: pw.usedMoney,
        percent: pw.percent,
        resetsAt: pw.resetsAt,
        usedTokens: local ? local.tokens : undefined,
        usedRequests: local ? local.requests : undefined,
      }
    })
  }

  const defaultProvider = () => {
    try {
      return ctx.get('settings')?.get('agent-default-model')?.provider
    } catch {
      return undefined
    }
  }

  /**
   * Today's local usage enriched with cache ratio and, when the provider
   * reports it on usage chunks, the real amount — no price tables, nothing
   * inferred. Providers without a usage price simply show no amount. The
   * currency is the provider's configured billing currency.
   */
  const todayUsedOf = (pcfg, providerName) => {
    if (!cfg.showTodayUsed) return undefined
    const agg = usage.today(providerName)
    const prompt = agg.input + agg.cacheRead
    const cacheRatio = prompt > 0 ? agg.cacheRead / prompt : undefined
    const hasBreakdown = agg.input > 0 || agg.output > 0 || agg.cacheRead > 0 || agg.cacheWrite > 0
    const out = {
      tokens: agg.tokens,
      requests: agg.requests,
      ...(cacheRatio !== undefined ? { cacheRatio } : {}),
      ...(hasBreakdown
        ? { input: agg.input, output: agg.output, cacheRead: agg.cacheRead, cacheWrite: agg.cacheWrite }
        : {}),
      ...(agg.series && agg.series.some((v) => v.t > 0) ? { series: agg.series } : {}),
    }
    const byModel = agg.byModel
      .filter((m) => m.cost > 0)
      .map((m) => ({ model: m.model, tokens: m.tokens, cost: Math.round(m.cost * 1000) / 1000 }))
    if (agg.cost > 0) {
      out.cost = Math.round(agg.cost * 1000) / 1000
      out.currency = pcfg?.currency || 'CNY'
      if (byModel.length) out.byModel = byModel
    }
    return out
  }

  const collectOne = async (providerName) => {
    const pcfg = cfg.providers[providerName]
    const preset = !pcfg ? PROVIDER_PRESETS[providerName] : undefined
    const kind = pcfg?.kind ?? preset?.kind ?? 'windows'
    const base = {
      provider: providerName,
      fetchedAt: Date.now(),
      todayUsed: todayUsedOf(pcfg ?? preset, providerName),
      lastRateLimit: rateLimits.get(providerName) ?? undefined,
      currency: pcfg?.currency ?? preset?.currency ?? 'CNY',
    }
    if (kind === 'balance') {
      if (pcfg?.url || preset) {
        const queryCfg = pcfg ?? {
          url: preset.url,
          apiKeyEnv: preset.apiKeyEnv,
          parse: preset.parse,
        }
        const q = await queryBalance(providerName, queryCfg)
        return { ...base, ...q }
      }
      return { ...base, kind: 'balance', error: 'no-url' }
    }
    if (kind === 'windows') {
      const low = pcfg?.lowBalanceThreshold ?? cfg.lowBalanceThreshold
      if (pcfg?.url || preset?.url) {
        const queryCfg = pcfg ?? {
          url: preset.url,
          apiKeyEnv: preset.apiKeyEnv,
          parse: preset.parse,
        }
        const q = await queryWindows(providerName, queryCfg)
        if (q.error) return { ...base, ...q, lowBalanceThreshold: low }
        return {
          ...base,
          kind: 'windows',
          lowBalanceThreshold: low,
          windows: mergeWindows(pcfg, q.windows, providerName),
        }
      }
      return {
        ...base,
        kind: 'windows',
        lowBalanceThreshold: low,
        windows: measureUsage(pcfg, providerName),
      }
    }
    return { ...base, kind: 'unknown', error: 'unsupported' }
  }

  const collect = async (providerName) => {
    const names = new Set()
    if (cfg.autoDiscover !== false) {
      // auto-discovery only covers providers with a known, stable preset
      // (official APIs like deepseek-official / opencode-go). Self-hosted or
      // custom gateways without a preset cannot be matched to a query config
      // nor classified as balance/windows, so they are never auto-added.
      const def = defaultProvider()
      if (def && PROVIDER_PRESETS[def]) names.add(def)
      // auto-discover providers registered in the harness LLM registry
      try {
        const llm = ctx.get('llm')
        if (llm && typeof llm.listProviders === 'function') {
          for (const p of llm.listProviders()) {
            const id = p?.provider ?? p?.id ?? p?.name
            if (id && PROVIDER_PRESETS[id]) names.add(id)
          }
        }
      } catch { /* llm unavailable */ }
    }
    for (const n of Object.keys(cfg.providers)) names.add(n)
    const active = [...names].filter((n) => !cfg.disabledProviders?.[n])
    if (providerName) {
      if (!active.includes(providerName)) return null
      return collectOne(providerName)
    }
    const out = await Promise.all(active.map((n) => collectOne(n)))
    return out
  }

  // --- local metering over every model call --------------------------------
  ctx.on('llm/stream', (options, next) => {
    const provider = options?.provider
    const model = options?.model
    const inner = next()
    return (async function* () {
      try {
        for await (const chunk of inner) {
          if (chunk && chunk.type === 'usage' && chunk.usage) {
            const u = chunk.usage
            // TokenUsage fields: inputTokens excludes the cache-read share
            // (inputTokens = prompt - cacheReadTokens), so the billable total
            // adds the cached share back; the breakdown keeps split pricing
            // and the model id (different sessions may use different models).
            const input = u.inputTokens ?? 0
            const output = u.outputTokens ?? 0
            const cacheRead = u.cacheReadTokens ?? 0
            const cacheWrite = u.cacheWriteTokens ?? 0
            usage.record(provider ?? 'unknown', input + output + cacheRead + cacheWrite, {
              input,
              output,
              cacheRead,
              cacheWrite,
              ...(model ? { model } : {}),
              // provider-reported amount, when an adapter provides one —
              // the authoritative price (promotions included)
              ...(typeof u.cost === 'number' ? { cost: u.cost } : {}),
            })
          }
          yield chunk
        }
      } catch (error) {
        if (error && error.code === 'RATE_LIMIT') {
          recordRateLimit(provider ?? 'unknown', error.providerRetryAfterMs)
        }
        throw error
      }
    })()
  })

  // --- endpoints ------------------------------------------------------------
  // Provider catalog for the settings form: whole-provider presets plus the
  // harness's own registered LLM providers (system-first naming: the config
  // key is the provider id, never a hand-typed name).
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/quota-monitor/presets',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'method-not-allowed' }))
        return
      }
      try {
        const systemProviders = []
        try {
          const llm = ctx.get('llm')
          if (llm && typeof llm.listProviders === 'function') {
            for (const p of llm.listProviders()) {
              const id = p?.provider ?? p?.id ?? p?.name
              if (id) systemProviders.push({ id, name: p?.name ?? id })
            }
          }
          if (llm && typeof llm.listConfigurableProviders === 'function') {
            for (const p of llm.listConfigurableProviders()) {
              const id = p?.provider ?? p?.id
              if (id && !systemProviders.some((s) => s.id === id)) {
                systemProviders.push({ id, name: p?.displayName ?? id })
              }
            }
          }
        } catch { /* llm unavailable */ }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ presets: PROVIDER_PRESETS, systemProviders }))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String((e && e.message) ?? e) }))
      }
    },
  })

  // Snapshot endpoint: current (default) provider, every auto-discovered LLM
  // provider, and every manually configured provider.
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/quota-monitor',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'method-not-allowed' }))
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const provider = url.searchParams.get('provider') || undefined
        const body = JSON.stringify(await collect(provider))
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(body)
      } catch (e) {
        console.error('[quota-monitor] snapshot error:', e)
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String((e && e.message) ?? e) }))
      }
    },
  })

  // Settings read/write: the wire configuration plane only exposes
  // allowlisted namespaces (LLM providers + shipped Web/product lists), so the
  // settings form reads and writes through this route and the host talks to
  // the settings service directly. GET returns the resolved configuration
  // (schema defaults + entry base + user layer) plus the raw user/base layers
  // so the form can label where each provider comes from; POST applies mutate
  // ops or the `remove-provider` action (also edits the profile patch file).
  const patchFileOf = () => path.join(harnessHome(ctx), 'profiles', 'web', 'cordis.patch.yml')

  /** Remove one provider key from the profile patch (base layer), preserving
  * `!!js` expressions with the same JSON_SCHEMA+js tag the loader uses. */
  const removeProviderFromPatch = async (providerName) => {
    const file = patchFileOf()
    if (!existsSync(file)) throw new Error(`profile patch not found: ${file}`)
    const yaml = harnessRequire()('js-yaml')
    const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      construct: (data) => ({ __jsExpr: data }),
      represent: (data) => data.__jsExpr,
    })
    const schema = yaml.JSON_SCHEMA.extend(JsExpr)
    const doc = yaml.load(readFileSync(file, 'utf8'), { schema })
    if (!Array.isArray(doc)) throw new Error('profile patch is not a list')
    const row = doc.find((e) => e && e.id === 'quota-monitor')
    if (!row || !row.config || !row.config.providers || typeof row.config.providers !== 'object') {
      throw new Error('profile patch has no quota-monitor providers row to edit')
    }
    delete row.config.providers[providerName]
    if (!Object.keys(row.config.providers).length) delete row.config.providers
    writeFileSync(file, yaml.dump(doc, { schema, noRefs: true }))
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/quota-monitor/settings',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          let user
          let base
          try {
            const settings = ctx.get('settings')
            if (settings && typeof settings.describe === 'function') {
              const descriptors = settings.describe({ redactSecrets: true })
              const ns = Array.isArray(descriptors)
                ? descriptors.find((d) => String(d.ns) === NS)
                : undefined
              if (ns) { user = ns.user; base = ns.base }
            }
          } catch { /* layers stay undefined */ }
          // auto-discovered system providers (read-only list for the form):
          // only providers with a known preset are shown — anything else
          // cannot be auto-configured (no query config, unknown balance vs
          // windows semantics) and would only mislead.
          const autoProviders = []
          if (cfg.autoDiscover !== false) {
            const seen = new Set(Object.keys(cfg.providers))
            const add = (id, name) => {
              if (!id || seen.has(id)) return
              const preset = PROVIDER_PRESETS[id]
              if (!preset) return
              seen.add(id)
              autoProviders.push({
                provider: id,
                name: name ?? preset?.label ?? id,
                kind: preset?.kind ?? 'windows',
                preset: true,
                disabled: !!cfg.disabledProviders?.[id],
              })
            }
            const def = defaultProvider()
            if (def) add(def)
            try {
              const llm = ctx.get('llm')
              if (llm && typeof llm.listProviders === 'function') {
                for (const p of llm.listProviders()) {
                  const id = p?.provider ?? p?.id ?? p?.name
                  if (id) add(id, p?.name)
                }
              }
            } catch { /* llm unavailable */ }
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ value: current(), user, base, autoProviders }))
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, message: 'method-not-allowed' }))
          return
        }
        const settings = ctx.get('settings')
        if (!settings || typeof settings.mutate !== 'function') {
          throw new Error('settings service unavailable')
        }
        let body = ''
        for await (const chunk of req) body += chunk
        const parsed = JSON.parse(body || '{}')
        if (parsed.action === 'remove-provider') {
          const providerName = parsed.provider
          if (!providerName || typeof providerName !== 'string') {
            throw new Error('expected { action: "remove-provider", provider }')
          }
          // 1) remove the user-layer entry first, while this fiber still owns
          //    the settings registration — the profile patch write below
          //    triggers the user-patch watcher, which hot-reloads this very
          //    plugin; mutating after that would hit "namespace not registered"
          await settings.mutate(NS, [{ op: 'unset', path: ['providers', providerName] }])
          // 2) remove the base-layer entry from the profile patch; the watcher
          //    re-applies the tree, so removal takes effect without a restart
          await removeProviderFromPatch(providerName)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, restartRequired: false }))
          return
        }
        const ops = Array.isArray(parsed.ops) ? parsed.ops : null
        if (!ops) throw new Error('expected { ops: [...] }')
        // service-level signature: mutate(ns, ops) — the { ns, ops } object
        // shape belongs to the wire remote, not the service
        await settings.mutate(NS, ops)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, message: String((e && e.message) ?? e) }))
      }
    },
  })
}
