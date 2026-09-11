// Profile-patch rewrite verification for provider removal.
//
// The removal helper is imported from its real module (duplicating it here is
// what let a real bug through once: DSH profile patches are a LAYER STACK, so a
// row usually lives inside an `insert:` block, not at the top level — a
// top-level-only search silently removed nothing and reported success).
//
//   node test/verify-patch-rewrite.mjs
//
// Covered: nested `insert:` rows, bare override rows, `!!js` expression
// preservation, the `config.providers` cleanup, and the idempotent no-op
// answers for a patch that never declared the provider.

import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { patchSchema, removeProviderFromPatchFile } from '../lib/patch.js'

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const require = createRequire(path.join(dshHome, 'profiles', 'web', '__quota_monitor_noop__.cjs'))
const yaml = require('js-yaml')

// Verification reads use the same schema the harness loader uses; a plain
// JSON_SCHEMA cannot read the `!!js` tag these fixtures carry.
const read = (file) => yaml.load(readFileSync(file, 'utf8'), { schema: patchSchema(yaml) })

let failures = 0
const ok = (condition, label, detail) => {
  if (condition) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'qm-patch-'))
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ } })

const nested = path.join(tmp, 'nested.yml')
writeFileSync(nested, [
  '# a real profile patch: every new row goes inside an insert block',
  '- insert:',
  '    - id: mcp-idea',
  '      name: "@deepseek-ai/dsh-mcp-client"',
  '    - id: quota-monitor',
  '      name: deepseek-harness-quota-monitor',
  '      config:',
  '        providers:',
  '          opencode-go:',
  '            kind: windows',
  '            url: https://opencode.ai/zen/go/v1/usage',
  '          deepseek-official:',
  '            kind: balance',
  '        lowBalanceThreshold: 20',
  '',
].join('\n'))

console.log('1. nested `insert:` row (the shape a live profile actually has)')
ok(removeProviderFromPatchFile(yaml, nested, 'opencode-go') === true, 'reports that the patch declared the provider')
const doc = read(nested)
const monitor = doc[0].insert.find((r) => r.id === 'quota-monitor')
ok(Object.keys(monitor.config.providers) .join(',') === 'deepseek-official', 'removes only the named provider')
ok(monitor.config.lowBalanceThreshold === 20, 'leaves sibling config fields alone')
ok(doc[0].insert.some((r) => r.id === 'mcp-idea'), 'leaves other rows alone')
ok(removeProviderFromPatchFile(yaml, nested, 'absent-provider') === false, 'a provider the patch never declared is a false no-op')
const untouched = readFileSync(nested, 'utf8')
ok(untouched.includes('deepseek-official'), 'a no-op leaves the file as it was')

console.log('\n2. bare override row + !!js expression preservation')
const bare = path.join(tmp, 'bare.yml')
writeFileSync(bare, [
  '- id: system-prompt',
  "  config:",
  "    persona: !!js ctx.something ?? '默认'",
  '- id: quota-monitor',
  '  name: deepseek-harness-quota-monitor',
  '  config:',
  '    providers:',
  '      last-provider:',
  '        kind: balance',
  '',
].join('\n'))
ok(removeProviderFromPatchFile(yaml, bare, 'last-provider') === true, 'finds a bare (top-level) row too')
const bareDoc = read(bare)
ok(bareDoc.find((r) => r.id === 'quota-monitor').config === undefined, 'prunes the emptied providers map and its config parent')
const persona = readFileSync(bare, 'utf8').includes('!!js')
ok(persona, 'preserves the !!js expression in an unrelated row')

console.log('\n3. missing / malformed inputs')
ok(removeProviderFromPatchFile(yaml, path.join(tmp, 'nope.yml'), 'x') === false, 'a missing patch file is a false no-op')
const notAList = path.join(tmp, 'notalist.yml')
writeFileSync(notAList, 'id: quota-monitor\n')
ok(removeProviderFromPatchFile(yaml, notAList, 'x') === false, 'a non-list patch is a false no-op')
const noRow = path.join(tmp, 'norow.yml')
writeFileSync(noRow, '- insert:\n    - id: something-else\n')
ok(removeProviderFromPatchFile(yaml, noRow, 'x') === false, 'a patch without the row is a false no-op')

console.log(`\n${failures === 0 ? 'PATCH REWRITE OK' : `FAIL (${String(failures)} assertion(s))`}`)
process.exitCode = failures === 0 ? 0 : 1
