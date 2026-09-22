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
 * Every provider is just configuration (Settings -> Plugins -> 额度监控): url,
 * apiKeyEnv reference, and a JS parser in one of three forms — `builtin`
 * (registry), `source` (inline function body), or `file` (path to a .js
 * module). Adding a provider never requires code changes.
 *
 * Client-side UI (lib/client.js): sidebar widget on `sidebar.footer.action`
 * and the configuration page on the Plugins page's `plugins.item` slot.
 *
 * Settings model (DSH >= 0.1.7): there is no `installSection` helper any more.
 * A plugin merely DECLARES an exported `Config` schema and the settings service
 * projects it into a form automatically; every field an operator may edit live
 * must be marked `.volatile()`. `volatile` cannot sit under a `dict`/`array`
 * (`volatile fields require a fixed object path…`), which is why this plugin
 * marks the WHOLE Config volatile at the root instead of per field: that keeps
 * the dynamic `providers` map and its nested windows editable. A root-volatile
 * Config still defaults and validates like any other; reading it goes through
 * `config.get()`.
 *
 * Dependency note: this bundle is pnpm-linked into the profile's node_modules
 * as a symlink, so Node's upward node_modules lookup from this file's real
 * location would fail. `@deepseek-ai/schemastery` and `js-yaml` are therefore
 * resolved explicitly with createRequire anchored at the profile directory;
 * only node:* builtins are imported statically. The settings service is reached
 * through the `ctx.settings` seam, so no dsh-settings value import is needed.
 *
 * HTTP surface: `/api` is claimed wholesale by `@deepseek-ai/dsh-client-connection`,
 * which applies the Host/Origin trust fence and browser authentication before
 * dispatch. Plugin endpoints therefore register as exact Fetch routes on that
 * service (`ctx.connection.fetch.register`) instead of raw `webServer` routes —
 * a bare `webServer.register({ path: '/api/…' })` is shadowed by the connection
 * prefix route and answers 401.
 */
import { createRequire } from 'node:module'
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { removeProviderFromPatchFile } from './patch.js'

export const name = 'quota-monitor'
// `webServer` owns the HTTP carrier; `connection` owns the authenticated /api
// surface these routes mount on. Both must be present before apply runs.
export const inject = ['webServer', 'connection']

const QUERY_TIMEOUT_MS = 30000
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const DAY_MS = 86400000
const USAGE_RETENTION_DAYS = 90

// ---------------------------------------------------------------------------
// Harness dependency resolution (see dependency note above)
// ---------------------------------------------------------------------------

let schemaModule = null

/** Storage home: prefers the settings document location (accurate under any
* DSH_HOME); falls back to DSH_HOME or ~/.dsh. */
function harnessHome(ctx) {
  try {
    const doc = ctx.get('settings')?.documentPath
    if (doc) return path.dirname(doc)
  } catch { /* fall through */ }
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/**
 * Resolve a harness package (schemastery / js-yaml) from the harness
 * installation. `createRequire` walks upward from the anchor, so anchoring on
 * the shared `profiles/` directory finds the pnpm-managed copy regardless of
 * which profile this bundle was loaded into; a profile-local copy, when one
 * exists, wins because the per-profile anchor is tried first.
 * @param {string} id - package specifier to resolve.
 * @returns the resolved module namespace.
 */
function harnessRequirePackage(id) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const failures = []
  for (const anchor of [path.join(home, 'profiles', 'web'), path.join(home, 'profiles'), home]) {
    try {
      return createRequire(path.join(anchor, '__quota_monitor_noop__.cjs'))(id)
    } catch (error) {
      failures.push(`${anchor}: ${String(error?.message ?? error)}`)
    }
  }
  throw new Error(`quota-monitor: could not resolve "${id}" from the DSH installation\n  ${failures.join('\n  ')}`)
}

/**
 * Resolve schemastery from the harness installation. The settings seam itself
 * needs no import: the settings service reads the exported `Config` schema off
 * this entry and projects it into a form, so declaring the schema is the whole
 * registration contract.
 * @returns the schemastery module namespace.
 */
function ensureHarnessDeps() {
  if (schemaModule) return schemaModule
  const pkg = harnessRequirePackage('@deepseek-ai/schemastery')
  schemaModule = pkg && pkg.object ? pkg : (pkg.default ?? pkg)
  if (!schemaModule || typeof schemaModule.object !== 'function') {
    throw new Error('quota-monitor: @deepseek-ai/schemastery could not be resolved from the DSH installation')
  }
  return schemaModule
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
  // Command Code (cmd): GET https://api.commandcode.ai/alpha/billing/credits
  // with `Authorization: Bearer <key>` ->
  // { credits: { monthlyCredits, purchasedCredits, freeCredits, belowThreshold,
  //              creditThreshold, planId? },
  //   windowLimits: { limited, exceeded, fiveHour: {used,cap,exceeded,resetAt},
  //                   weekly: {…} } }
  //
  // Two field traps this parser absorbs: `windowLimits` is sometimes nested
  // under `credits` instead of sitting beside it, and a window carries no
  // `percent` (it is `used / cap`) while its reset field is `resetAt` — epoch
  // MILLISECONDS — not `resetsAt`. Both windows are reported alongside the
  // credit balance, because a healthy balance can still sit on an exhausted
  // 5-hour window.
  'commandcode-credits': (raw, opts) => {
    if (!raw || typeof raw !== 'object') throw new Error('commandcode: response is not an object')
    const credits = raw.credits ?? raw.data?.credits
    if (!credits || typeof credits !== 'object') throw new Error('commandcode: response missing credits')

    // Epoch milliseconds, epoch seconds, or an ISO string — all accepted.
    const toIso = (value) => {
      if (value == null || value === '' || value === 0) return undefined
      if (typeof value === 'string') {
        const parsed = Date.parse(value)
        return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
      // Heuristic: anything below 1e12 is too small for epoch ms, so it is epoch seconds.
      const ms = value < 1e12 ? value * 1000 : value
      const date = new Date(ms)
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
    }

    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

    const monthly = num(credits.monthlyCredits) ?? 0
    const purchased = num(credits.purchasedCredits) ?? 0
    const free = num(credits.freeCredits) ?? 0
    const remaining = monthly + purchased + free

    // Plan table (planId -> monthly credit allowance). Only used when the
    // response happens to carry a planId; no second request is made for it.
    const PLAN_CREDITS = {
      'individual-go': 10,
      'individual-goat': 70,
      'individual-pro': 30,
      'individual-pro-v1': 80,
      'individual-provider': 15,
      'individual-max': 150,
      'individual-ultra': 300,
      'teams-pro': 40,
    }
    const planId = typeof (credits.planId ?? opts?.planId) === 'string'
      ? String(credits.planId ?? opts.planId).toLowerCase().replace(/_/g, '-')
      : undefined
    // Allowance resolution, most explicit first: a configured figure, then the
    // plan table, then nothing (no monthly bar rather than a guessed one).
    const configuredAllowance = num(opts?.monthlyCredits) ?? num(credits.monthlyCreditsTotal)
    const planAllowance = planId
      ? PLAN_CREDITS[
          Object.keys(PLAN_CREDITS)
            .filter((id) => planId.startsWith(id))
            .sort((a, b) => b.length - a.length)[0]
        ]
      : undefined
    const planTotal = configuredAllowance ?? planAllowance

    const limits = raw.windowLimits ?? credits.windowLimits ?? raw.data?.windowLimits
    const windows = []
    const span = (key, label, seconds) => {
      const w = limits?.[key]
      if (!w || typeof w !== 'object') return
      const used = num(w.used)
      const cap = num(w.cap)
      const resetsAt = toIso(w.resetAt)
      windows.push({
        label,
        seconds,
        ...(used != null ? { usedMoney: used } : {}),
        ...(cap != null ? { limitMoney: cap } : {}),
        // A window with no cap cannot express a percentage; report usage only.
        ...(used != null && cap != null && cap > 0
          ? { percent: Math.round((used / cap) * 1000) / 10 }
          : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(w.exceeded === true ? { exceeded: true } : {}),
      })
    }
    span('fiveHour', '5h', 5 * 3600)
    span('weekly', '7d', 7 * 86400)
    // Derived monthly bar — only when planId made the allowance knowable.
    if (planTotal != null) {
      windows.push({
        label: '1m',
        seconds: 30 * 86400,
        usedMoney: Math.round((planTotal - remaining) * 100) / 100,
        limitMoney: planTotal,
        percent: Math.round(((planTotal - remaining) / planTotal) * 1000) / 10,
      })
    }

    if (!windows.length && remaining === 0 && monthly === 0) {
      throw new Error('commandcode: no windowLimits and no credits in response')
    }
    return {
      kind: 'windows',
      windows,
      // Carried alongside the windows so the card can show the credit balance
      // without a second endpoint.
      balance: {
        currency: 'USD',
        remaining: String(Math.round(remaining * 100) / 100),
        available: limits?.exceeded == null || limits.exceeded === '' || limits.exceeded === false,
        ...(planTotal != null ? { total: String(planTotal) } : {}),
        ...(typeof credits.belowThreshold === 'boolean' ? { belowThreshold: credits.belowThreshold } : {}),
      },
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
  'commandcode': {
    label: 'Command Code 订阅',
    kind: 'windows',
    url: 'https://api.commandcode.ai/alpha/billing/credits',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    parse: { builtin: 'commandcode-credits' },
    note: '5 小时 / 7 天滚动窗口 + Credits 余额（未公开文档的 /alpha 接口，可能随上游变动；Go 套餐无 API 权限）',
    currency: 'USD',
    // Cloudflare answers requests with no User-Agent with 403 (error 1010),
    // so this endpoint needs one even though it is a plain GET.
    headers: { 'user-agent': 'deepseek-harness-quota-monitor' },
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
//
// There is no settings-namespace literal to declare here: in DSH >= 0.1.7 the
// settings entry id IS the namespace, and both halves reach it through the
// composition row's `id` (`quota-monitor` in cordis.patch.yml) rather than
// through a value this bundle exports.

/** One window's shape, shared by the global default list and provider overrides. */
function windowSchema(Schema) {
  return Schema.object({
    label: Schema.string().required(),
    seconds: Schema.number().required(),
    limitTokens: Schema.number(),
    limitRequests: Schema.number(),
  })
}

/** One provider's query configuration. */
function providerSchema(Schema, WindowSchema) {
  return Schema.object({
    kind: Schema.union(['balance', 'windows']).required(),
    url: Schema.string(),
    apiKeyEnv: Schema.string().role('credential-ref'),
    headers: Schema.dict(Schema.string()),
    parse: Schema.object({
      builtin: Schema.string(),
      source: Schema.string(),
      file: Schema.string(),
    }),
    windows: Schema.array(WindowSchema),
    lowBalanceThreshold: Schema.number(),
    // Display name for the sidebar card. Optional: the route's own displayName
    // is used when this is unset, and the raw route id only as a last resort.
    label: Schema.string(),
    // Optional plan/allowance hint. Command Code's credits endpoint does NOT
    // return a planId, and its monthly window exists only as a derived figure
    // (allowance − remaining), so a provider that needs a monthly bar declares
    // its plan or allowance here. Read by parsers through `opts`.
    planId: Schema.string(),
    monthlyCredits: Schema.number(),
    currency: Schema.string().default('CNY'),
    // 'raw': send the credential as-is (no `Bearer ` prefix), e.g. new-api's
    // System Access Token
    auth: Schema.union(['bearer', 'raw']).default('bearer'),
    platform: Schema.string(),
  })
}

/**
 * The declared configuration schema.
 *
 * Exporting `Config` IS the settings registration in DSH >= 0.1.7: the
 * settings service reads this schema off the loaded entry and projects it into
 * a form, so there is no install call to make. Construction therefore happens
 * at module load, not inside `apply`.
 *
 * The trailing `.volatile()` is load-bearing, not decoration: schemastery
 * rejects a volatile node beneath a `dict` or `array` ("volatile fields require
 * a fixed object path without an enclosing volatile field"), and this
 * configuration is a dynamic `providers` map of nested objects and window
 * arrays. Marking the ROOT volatile makes every path beneath it live-editable —
 * including `providers.<name>.url` — where per-field marking cannot be
 * expressed at all. Read it back with `config.get()`.
 */
export const Config = (() => {
  const Schema = ensureHarnessDeps()
  const WindowSchema = windowSchema(Schema)
  return Schema.object({
    refreshMs: Schema.number().default(300000),
    cacheTtlMs: Schema.number().default(60000),
    lowBalanceThreshold: Schema.number().default(20),
    windows: Schema.array(WindowSchema).default([
      { label: '5h', seconds: 5 * 3600 },
      { label: '7d', seconds: 7 * 86400 },
      { label: '1m', seconds: 30 * 86400 },
    ]),
    providers: Schema.dict(providerSchema(Schema, WindowSchema)).default({}),
    showTodayUsed: Schema.boolean().default(true),
    // providers disabled by the user ({ [id]: true }); disabled providers are
    // neither monitored nor shown in the widget, whether they come from the
    // auto-discovery list or manual configuration
    disabledProviders: Schema.dict(Schema.boolean()).default({}),
    // off: only manually configured providers are monitored; on (default):
    // the current default provider and every registered LLM provider are
    // auto-monitored (with presets providing query config for known ones)
    autoDiscover: Schema.boolean().default(true),
  }).volatile()
})()

export function apply(ctx, config) {
  if (!config || typeof config.get !== 'function') {
    throw new Error('quota-monitor: Config must be declared as a volatile schema so settings stay live-editable')
  }
  /** Latest resolved configuration section (settings re-resolve it in place). */
  const cfg = () => config.get()

  const usage = createUsageStore(storageDir(ctx))
  const rateLimits = new Map() // provider -> { at, retryAfterMs }
  const cache = new Map() // provider -> { at, snapshot }

  const recordRateLimit = (provider, retryAfterMs) => {
    rateLimits.set(provider, { at: Date.now(), retryAfterMs })
  }

  const measureUsage = (pcfg, providerName) => {
    const windows = (pcfg && pcfg.windows && pcfg.windows.length ? pcfg.windows : cfg().windows ?? [])
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
    if (cached && Date.now() - cached.at < cfg().cacheTtlMs) return cached.snapshot
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
      const parsed = parser ? await parser(raw, { platform: pcfg.platform, planId: pcfg.planId, monthlyCredits: pcfg.monthlyCredits }) : { kind: 'balance' }
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
    if (cached && Date.now() - cached.at < cfg().cacheTtlMs) return cached.snapshot
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
      const parsed = parser ? await parser(raw, { platform: pcfg.platform, planId: pcfg.planId, monthlyCredits: pcfg.monthlyCredits }) : { kind: 'windows' }
      const snapshot = {
        provider: providerName,
        kind: 'windows',
        fetchedAt: Date.now(),
        windows: parsed.windows ?? [],
        // Some window APIs also report a credit balance (Command Code); carry
        // it through so the card can show both from the one query.
        ...(parsed.balance ? { balance: parsed.balance } : {}),
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
    const cfgWindows = (pcfg && pcfg.windows && pcfg.windows.length ? pcfg.windows : cfg().windows ?? [])
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
    if (cfg().showTodayUsed === false) return undefined
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

  /**
   * Human-readable name for one provider, for the card.
   *
   * The snapshot's `provider` field is the ROUTE ID — the key everything else is
   * addressed by (config section, credential scope, local metering, the
   * `llm/stream` provider field). It is not a label: an id like `commandcode` or
   * `onerouter-cmd` reads as a typo in the UI, and the route usually already
   * declares a proper name. So the card prints this instead, most specific
   * first:
   *
   *   1. `label` in this provider's own config section — the operator's override
   *   2. the LLM route's `displayName` — the name the route itself declares
   *   3. the preset label — our curated copy for a known provider
   *   4. the route id, as a last resort
   *
   * @param providerName - route id.
   * @param pcfg - the provider's config section, when one exists.
   * @param preset - the matching preset, when there is no config section.
   * @returns the display name to print.
   */
  const displayNameOf = (providerName, pcfg, preset) => {
    const usable = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
    const explicit = usable(pcfg?.label)
    if (explicit) return explicit
    try {
      const llm = ctx.get('llm')
      // The route's own declared display name is the most authoritative label:
      // it is what the Models page shows and what the operator chose.
      const source = typeof llm?.listConfigurableProviders === 'function'
        ? llm.listConfigurableProviders()
        : typeof llm?.listProviders === 'function' ? llm.listProviders() : []
      const hit = source.find((p) => (p?.id ?? p?.provider) === providerName)
      const declared = usable(hit?.displayName) ?? usable(hit?.name)
      if (declared && declared !== providerName) return declared
    } catch { /* llm unavailable: fall through to the preset label */ }
    return usable(preset?.label) ?? providerName
  }

  const collectOne = async (providerName) => {
    const pcfg = cfg().providers?.[providerName]
    const preset = !pcfg ? PROVIDER_PRESETS[providerName] : undefined
    const kind = pcfg?.kind ?? preset?.kind ?? 'windows'
    const base = {
      provider: providerName,
      // `provider` stays the id (every other surface keys off it); `label` is
      // what the card prints, so a route named `commandcode` can read as
      // "Command Code" without renaming the route.
      label: displayNameOf(providerName, pcfg, preset),
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
          headers: preset.headers,
        }
        const q = await queryBalance(providerName, queryCfg)
        return { ...base, ...q }
      }
      return { ...base, kind: 'balance', error: 'no-url' }
    }
    if (kind === 'windows') {
      const low = pcfg?.lowBalanceThreshold ?? cfg().lowBalanceThreshold
      if (pcfg?.url || preset?.url) {
        const queryCfg = pcfg ?? {
          url: preset.url,
          apiKeyEnv: preset.apiKeyEnv,
          parse: preset.parse,
          headers: preset.headers,
        }
        const q = await queryWindows(providerName, queryCfg)
        if (q.error) return { ...base, ...q, lowBalanceThreshold: low }
        return {
          ...base,
          kind: 'windows',
          lowBalanceThreshold: low,
          windows: mergeWindows(pcfg, q.windows, providerName),
          // Some window APIs (Command Code) also report a credit balance.
          ...(q.balance ? { balance: q.balance } : {}),
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
    const c = cfg()
    const names = new Set()
    if (c.autoDiscover !== false) {
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
            const id = p?.id ?? p?.provider ?? p?.name
            if (id && PROVIDER_PRESETS[id]) names.add(id)
          }
        }
      } catch { /* llm unavailable */ }
    }
    for (const n of Object.keys(c.providers ?? {})) names.add(n)
    const active = [...names].filter((n) => !c.disabledProviders?.[n])
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
  // All three endpoints live on the authenticated `/api` channel owned by
  // @deepseek-ai/dsh-client-connection. Registering exact Fetch routes on that
  // service puts them behind the same Host/Origin fence and browser-session
  // cookie as every shipped endpoint; a raw webServer route under /api would be
  // shadowed by the connection prefix route and answer 401.
  const connection = ctx.get('connection')
  if (!connection || typeof connection.fetch?.register !== 'function') {
    throw new Error('quota-monitor: the connection service (ctx.connection.fetch) is unavailable in this composition')
  }

  /**
   * Register one exact JSON Fetch route on the shared API channel.
   * @param pathname - absolute path below /api (no query string).
   * @param methods - HTTP methods this route owns.
   * @param handler - receives the Fetch request; its resolved value is the JSON body.
   */
  const jsonRoute = (pathname, methods, handler) => {
    const route = {
      path: pathname,
      methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return Response.json(await handler(request))
        } catch (e) {
          return Response.json({ error: String((e && e.message) ?? e) }, { status: 500 })
        }
      },
    }
    ctx.effect(() => connection.fetch.register(route), `quota-monitor: ${pathname} fetch route`)
  }

  // Provider catalog for the settings form: whole-provider presets plus the
  // harness's own registered LLM providers (system-first naming: the config
  // key is the provider id, never a hand-typed name).
  jsonRoute('/api/quota-monitor/presets', ['GET'], async () => {
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
    return { presets: PROVIDER_PRESETS, systemProviders }
  })

  // Snapshot endpoint: current (default) provider, every auto-discovered LLM
  // provider, and every manually configured provider.
  jsonRoute('/api/quota-monitor', ['GET'], async (request) => {
    const provider = new URL(request.url).searchParams.get('provider') || undefined
    return await collect(provider)
  })

  // The configuration card reads and writes through the shipped Remote
  // settings transport, so this plugin ships no settings endpoint of its own.
  // What remains host-side: the read-only auto-discovered provider list, and
  // removal from the profile patch (`base` layer), which the settings document
  // cannot reach.

  /**
   * The active profile's user patch file. `ctx.profileContext` is the
   * authoritative source (DSH >= 0.1.7 profiles live at
   * `$DSH_HOME/profiles/<name>/cordis.patch.yml`); the older
   * `$DSH_HOME/profiles/web/cordis.patch.yml` guess is kept only as a fallback
   * for a composition that does not expose it.
   */
  const patchFileOf = () => {
    try {
      const patchPath = ctx.get('profileContext')?.patchPath
      if (patchPath) return patchPath
    } catch { /* not launched from a profile */ }
    return path.join(harnessHome(ctx), 'profiles', 'web', 'cordis.patch.yml')
  }

  /**
   * Drop one provider from the profile patch (`cordis.patch.yml`, the
   * composition base layer the settings document cannot reach). The caller has
   * already removed the user-layer entry through the settings transport, so a
   * provider the patch never declared simply reports `false`.
   * @param providerName - provider key to remove from the patch's base layer.
   * @returns whether the patch actually declared that provider.
   */
  const removeProviderFromPatch = (providerName) =>
    removeProviderFromPatchFile(harnessRequirePackage('js-yaml'), patchFileOf(), providerName)

  // Provider removal touches two layers. The user layer is the ordinary case
  // and rides the shipped Remote settings transport; the profile patch is the
  // composition `base` layer, which no settings write can reach — this route
  // exists only for that second layer, and it is a no-op when the patch does
  // not declare the provider.
  jsonRoute('/api/quota-monitor/profile-provider', ['POST'], async (request) => {
    const parsed = await request.json().catch(() => ({}))
    const providerName = parsed.provider
    if (!providerName || typeof providerName !== 'string') {
      throw new Error('expected { provider }')
    }
    const removed = removeProviderFromPatch(providerName)
    return { ok: true, removed, restartRequired: false }
  })

  jsonRoute('/api/quota-monitor/settings', ['GET'], async () => {
    // auto-discovered system providers (read-only list for the form):
    // only providers with a known preset are shown — anything else
    // cannot be auto-configured (no query config, unknown balance vs
    // windows semantics) and would only mislead.
    const autoProviders = []
    const c = cfg()
    if (c.autoDiscover !== false) {
      const seen = new Set(Object.keys(c.providers ?? {}))
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
          disabled: !!c.disabledProviders?.[id],
        })
      }
      const def = defaultProvider()
      if (def) add(def)
      try {
        const llm = ctx.get('llm')
        if (llm && typeof llm.listProviders === 'function') {
          for (const p of llm.listProviders()) {
            const id = p?.id ?? p?.provider ?? p?.name
            if (id) add(id, p?.name)
          }
        }
      } catch { /* llm unavailable */ }
    }
    return { autoProviders }
  })
}
