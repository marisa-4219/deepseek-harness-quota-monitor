/**
 * Verify the cline-usage builtin parser through the real module export.
 *
 * The payload shapes below are the ones the live endpoint actually returned
 * (captured against a real Cline account), plus the boundary cases the contract
 * allows: a window that has not started yet carries no `resetsAt`, an account
 * without a ClinePass subscription answers with an empty `limits` array, and
 * unknown window types must be skipped rather than guessed at.
 *
 *   node test/verify-cline-parser.mjs
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
// The parser table is module-private; re-evaluate just that block to test it.
const start = src.indexOf('const BUILTINS = {')
const end = src.indexOf('/** Resolve a parser configuration')
if (start < 0 || end < 0) throw new Error('could not locate BUILTINS block')
const block = src.slice(start, end)
const BUILTINS = new Function(`${block}\nreturn BUILTINS`)()

const parse = BUILTINS['cline-usage']
let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}
const throws = (label, fn) => {
  try { fn(); check(label, false, '— did not throw') } catch { check(label, true) }
}
const byLabel = (r) => Object.fromEntries(r.windows.map((w) => [w.label, w]))

console.log('=== 1. the exact shape the live endpoint returned ===')
const live = parse({
  data: {
    limits: [
      { type: 'five_hour', percentUsed: 1, resetsAt: '2026-10-11T15:37:19.800691006Z' },
      { type: 'weekly', percentUsed: 0, resetsAt: '2026-10-18T10:37:19.803209439Z' },
      { type: 'monthly', percentUsed: 0, resetsAt: '2026-11-10T10:37:19.805517102Z' },
    ],
  },
  success: true,
})
check('kind is windows', live.kind === 'windows')
check('three windows', live.windows.length === 3, `got ${live.windows.length}`)
const l1 = byLabel(live)
check('five_hour -> 5h', !!l1['5h'])
check('weekly -> 7d', !!l1['7d'])
check('monthly -> 1m', !!l1['1m'])
check('5h seconds = 18000', l1['5h'].seconds === 18000)
check('7d seconds = 604800', l1['7d'].seconds === 604800)
check('1m seconds = 2592000', l1['1m'].seconds === 2592000)
check('percentUsed passed through unchanged', l1['5h'].percent === 1)
check('resetsAt preserved verbatim', l1['5h'].resetsAt === '2026-10-11T15:37:19.800691006Z')
check('no balance key for a windows-only provider', live.balance === undefined)

console.log('\n=== 2. order independence (shortest window first) ===')
const shuffled = parse({
  data: {
    limits: [
      { type: 'monthly', percentUsed: 5, resetsAt: '2026-11-10T10:00:00Z' },
      { type: 'five_hour', percentUsed: 9, resetsAt: '2026-10-11T15:00:00Z' },
      { type: 'weekly', percentUsed: 7, resetsAt: '2026-10-18T10:00:00Z' },
    ],
  },
})
check('labels ordered 5h, 7d, 1m', JSON.stringify(shuffled.windows.map((w) => w.label)) === '["5h","7d","1m"]',
  `got ${JSON.stringify(shuffled.windows.map((w) => w.label))}`)

console.log('\n=== 3. a window that has not started carries no resetsAt ===')
const unstarted = parse({
  data: { limits: [{ type: 'five_hour', percentUsed: 0 }, { type: 'weekly', percentUsed: 2, resetsAt: '2026-10-18T10:00:00Z' }] },
})
const u3 = byLabel(unstarted)
check('5h still rendered without resetsAt', !!u3['5h'])
check('resetsAt stays undefined (not invented)', u3['5h'].resetsAt === undefined)
check('the other window keeps its resetsAt', u3['7d'].resetsAt === '2026-10-18T10:00:00Z')

console.log('\n=== 4. unknown window types are skipped, not guessed ===')
const mixed = parse({
  data: {
    limits: [
      { type: 'daily', percentUsed: 50, resetsAt: '2026-10-12T00:00:00Z' },
      { type: 'five_hour', percentUsed: 3, resetsAt: '2026-10-11T15:00:00Z' },
      { type: '', percentUsed: 1 },
    ],
  },
})
check('only the recognised window survives', mixed.windows.length === 1, `got ${mixed.windows.length}`)
check('and it is the 5h one', mixed.windows[0].label === '5h')

console.log('\n=== 5. type is matched case- and whitespace-insensitively ===')
const sloppy = parse({ data: { limits: [{ type: ' Five_Hour ', percentUsed: 4, resetsAt: '2026-10-11T15:00:00Z' }] } })
check('" Five_Hour " still maps to 5h', sloppy.windows[0]?.label === '5h')

console.log('\n=== 6. non-numeric percentUsed is skipped ===')
const stringy = parse({
  data: { limits: [{ type: 'five_hour', percentUsed: '3' }, { type: 'weekly', percentUsed: 2, resetsAt: '2026-10-18T10:00:00Z' }] },
})
check('string percent ignored', stringy.windows.length === 1 && stringy.windows[0].label === '7d')
// Every window unusable is a failed query, not an empty card — same contract as
// the other percent-window parsers.
throws('all-unusable windows throws', () => parse({ data: { limits: [{ type: 'five_hour', percentUsed: Number.NaN }, { type: 'monthly', percentUsed: Infinity }] } }))

console.log('\n=== 7. a saturated window passes 100 through ===')
const full = parse({ data: { limits: [{ type: 'five_hour', percentUsed: 100, resetsAt: '2026-10-11T15:00:00Z' }] } })
check('percent 100 preserved', full.windows[0].percent === 100)

console.log('\n=== 8. envelope is optional, failures are loud ===')
const bare = parse({ limits: [{ type: 'five_hour', percentUsed: 6, resetsAt: '2026-10-11T15:00:00Z' }] })
check('a bare {limits} body still parses', bare.windows.length === 1)
// No ClinePass subscription: the endpoint answers with an empty list (or 404s).
throws('empty limits[] throws', () => parse({ data: { limits: [] } }))
throws('missing limits throws', () => parse({ data: { plan: 'nope' } }))
throws('null body throws', () => parse(null))
throws('only unrecognised types throws', () => parse({ data: { limits: [{ type: 'daily', percentUsed: 1 }] } }))

console.log('\n==================================================')
console.log(`PASS ${pass}  FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
