/**
 * Verify the commandcode-credits builtin parser through the real module export.
 * Exercises the field traps: nested windowLimits, resetAt in ms/s/ISO,
 * string-valued `exceeded`, and a response with no planId.
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
// The parser table is module-private; re-evaluate just that block to test it.
const start = src.indexOf('const BUILTINS = {')
const end = src.indexOf('/** Resolve a parser configuration')
if (start < 0 || end < 0) throw new Error('could not locate BUILTINS block')
const block = src.slice(start, end)
const BUILTINS = new Function(`${block}\nreturn BUILTINS`)()

const parse = BUILTINS['commandcode-credits']
let pass = 0
let fail = 0
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

console.log('=== 1. canonical shape (windowLimits beside credits) ===')
const r1 = parse({
  credits: { monthlyCredits: 42.5, purchasedCredits: 10, freeCredits: 0, belowThreshold: false, creditThreshold: 5, planId: 'individual-goat' },
  windowLimits: {
    limited: true,
    exceeded: '',
    fiveHour: { used: 4.5, cap: 14, exceeded: false, resetAt: 1790083955000 },
    weekly: { used: 12.0, cap: 35, exceeded: false, resetAt: 1790600000000 },
  },
})
check('kind is windows', r1.kind === 'windows')
check('balance remaining = 52.5', r1.balance.remaining === '52.5', `got ${r1.balance.remaining}`)
check('balance currency USD', r1.balance.currency === 'USD')
check('balance available (exceeded empty string)', r1.balance.available === true)
check('plan total derived from planId (70)', r1.balance.total === '70', `got ${r1.balance.total}`)
const w1 = Object.fromEntries(r1.windows.map((w) => [w.label, w]))
check('5h percent = 32.1', w1['5h'].percent === 32.1, `got ${w1['5h'].percent}`)
check('7d percent = 34.3', w1['7d'].percent === 34.3, `got ${w1['7d'].percent}`)
check('1m derived window present', !!w1['1m'])
check('1m percent = 25', w1['1m'].percent === 25, `got ${w1['1m'].percent}`)
check('resetAt ms -> ISO', w1['5h'].resetsAt === new Date(1790083955000).toISOString(), `got ${w1['5h'].resetsAt}`)
check('seconds on 5h is 18000', w1['5h'].seconds === 18000)

console.log('\n=== 2. windowLimits NESTED under credits + epoch seconds + ISO ===')
const r2 = parse({
  credits: {
    monthlyCredits: 5, purchasedCredits: 0, freeCredits: 1,
    windowLimits: {
      exceeded: 'fiveHour',
      fiveHour: { used: 14, cap: 14, exceeded: true, resetAt: 1790083955 },
      weekly: { used: 1, cap: 35, exceeded: false, resetAt: '2027-01-02T03:04:05.000Z' },
    },
  },
})
const w2 = Object.fromEntries(r2.windows.map((w) => [w.label, w]))
check('nested windowLimits discovered', !!w2['5h'])
check('epoch seconds -> ISO', w2['5h'].resetsAt === new Date(1790083955000).toISOString(), `got ${w2['5h'].resetsAt}`)
check('5h exceeded flag', w2['5h'].exceeded === true)
check('ISO passthrough normalised', w2['7d'].resetsAt === '2027-01-02T03:04:05.000Z', `got ${w2['7d'].resetsAt}`)
check('exceeded string -> available false', r2.balance.available === false)
check('remaining = 6', r2.balance.remaining === '6', `got ${r2.balance.remaining}`)
check('no planId -> no total', r2.balance.total === undefined)
check('no planId -> no derived 1m window', !w2['1m'])

console.log('\n=== 3. no windowLimits at all (balance still reported) ===')
const r3 = parse({ credits: { monthlyCredits: 3.25, purchasedCredits: 0, freeCredits: 0 } })
check('balance-only accepted', r3.kind === 'windows' && r3.windows.length === 0)
check('remaining = 3.25', r3.balance.remaining === '3.25', `got ${r3.balance.remaining}`)
check('available default true', r3.balance.available === true)

console.log('\n=== 4. error paths ===')
const throws = (label, fn) => {
  try { fn(); check(`${label} throws`, false, '(did not throw)') }
  catch { check(`${label} throws`, true) }
}
throws('null body', () => parse(null))
throws('missing credits', () => parse({ windowLimits: {} }))
throws('empty credits object with zero balance', () => parse({ credits: {} }))

console.log('\n=== 5. windowLimits under data (envelope variant) ===')
const r5 = parse({ data: { credits: { monthlyCredits: 7, purchasedCredits: 0, freeCredits: 0 }, windowLimits: { fiveHour: { used: 1, cap: 4, resetAt: 0 } } } })
check('data envelope discovered', r5.balance.remaining === '7', `got ${r5.balance.remaining}`)
check('resetAt 0 -> no resetsAt', r5.windows[0].resetsAt === undefined)

console.log(`\n${'='.repeat(50)}\nPASS ${pass}  FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
