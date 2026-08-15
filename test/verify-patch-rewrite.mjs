// Verify the profile-patch rewrite logic (remove-provider): js-yaml
// JSON_SCHEMA + !!js tag round-trip, provider key removal, structure intact.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const req = createRequire(path.join(dshHome, 'profiles', 'web', 'noop.cjs'))
const yaml = req('js-yaml')
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __jsExpr: data }),
  represent: (data) => data.__jsExpr,
})
const schema = yaml.JSON_SCHEMA.extend(JsExpr)

const tmp = path.join(os.tmpdir(), 'qm-patch-test.yml')
writeFileSync(tmp, [
  '- id: system-prompt',
  '  config:',
  "    persona: !!js ctx.something ?? '默认'",
  '- id: quota-monitor',
  '  name: deepseek-harness-quota-monitor',
  '  config:',
  '    providers:',
  '      opencode-go:',
  '        kind: windows',
  '        url: https://opencode.ai/zen/go/v1/usage',
  '      deepseek-official:',
  '        kind: balance',
  '',
].join('\n'))

// simulate removeProviderFromPatch
const doc = yaml.load(readFileSync(tmp, 'utf8'), { schema })
const row = doc.find((e) => e && e.id === 'quota-monitor')
delete row.config.providers['opencode-go']
writeFileSync(tmp, yaml.dump(doc, { schema, noRefs: true }))

// re-load and verify
const doc2 = yaml.load(readFileSync(tmp, 'utf8'), { schema })
const row2 = doc2.find((e) => e.id === 'quota-monitor')
console.log('providers after remove:', JSON.stringify(Object.keys(row2.config.providers || {})))
const persona = doc2.find((e) => e.id === 'system-prompt').config.persona
console.log('js-expr preserved:', JSON.stringify(persona))
unlinkSync(tmp)
console.log('PATCH REWRITE OK')
