/**
 * Profile-patch (`cordis.patch.yml`) editing for the quota-monitor bundle.
 *
 * The patch is a profile's composition *base* layer: no settings-document write
 * can reach it, so removing a provider the patch declares is a file edit. Two
 * facts shape how that edit is done:
 *
 *   1. The file is a layer stack, so a row lives either bare (an id-targeted
 *      override of a row another layer already inserted) or inside an
 *      `insert:` block. Both shapes are searched, because a top-level-only
 *      search silently removes nothing from the shape a live profile has.
 *   2. The file is USER-AUTHORED and carries the harness's `!!js` expressions.
 *      js-yaml can *read* that tag but cannot *emit* it, so a parse → mutate →
 *      `dump` round-trip rewrites `!!js ctx.foo` into a plain mapping —
 *      corrupting every expression in the file. The edit is therefore
 *      surgical: js-yaml decides whether this bundle's row declares the
 *      provider, and the bytes of that one provider entry are removed from the
 *      text, leaving every other line byte-identical.
 *
 * This module is deliberately free of harness imports so it can be unit-tested
 * directly: the caller passes the `js-yaml` module resolved from the harness
 * installation.
 *
 * @module deepseek-harness-quota-monitor/patch
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** Row id this bundle's patch entry uses. */
export const PATCH_ROW_ID = 'quota-monitor'

/**
 * Build the YAML schema the harness loader uses: JSON_SCHEMA plus a scalar `js`
 * tag that reads `!!js` expressions as an opaque marker object.
 *
 * `represent` must be present even though this module never dumps: js-yaml
 * registers a type's tag only when the type can also represent it, so a
 * construct-only type leaves the tag unknown and every patch carrying a `!!js`
 * expression fails to load.
 * @param yaml - the js-yaml module.
 * @returns a schema usable for reading a patch document.
 */
export function patchSchema(yaml) {
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data) => ({ __jsExpr: data }),
    represent: (data) => data.__jsExpr,
  })
  return yaml.JSON_SCHEMA.extend(JsExpr)
}

/**
 * Every row of a patch layer stack: the bare rows plus each `insert:` block's
 * rows, in file order.
 * @param doc - the parsed patch document.
 * @returns the flattened row list (empty for a non-list document).
 */
export function patchRows(doc) {
  if (!Array.isArray(doc)) return []
  return doc.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const nested = Array.isArray(entry.insert) ? entry.insert.filter((row) => row && typeof row === 'object') : []
    return [entry, ...nested]
  })
}

/** Indentation width of a line (0 for a blank or unindented line). */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  return match === null ? 0 : match[0].length
}

/** Whether a line is blank or a YAML comment. */
function isBlankOrComment(line) {
  const trimmed = line.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

/**
 * Remove one child entry (a YAML block mapping or sequence item) from a text
 * block, given the line index of its key/`-` line and that line's indent.
 * Consumes every following line that is blank, a comment, or indented deeper
 * than the key, so the entry's whole subtree goes and nothing else does.
 * @param lines - the file's lines (without terminators).
 * @param start - index of the entry's own line.
 * @param indent - the entry's indentation width.
 * @returns the index of the first line that is not part of the entry.
 */
function subtreeEnd(lines, start, indent) {
  let index = start + 1
  while (index < lines.length) {
    const line = lines[index]
    if (isBlankOrComment(line)) { index++; continue }
    if (indentOf(line) <= indent) break
    index++
  }
  return index
}

/**
 * Whether the key line at `index` opens an empty mapping — nothing but blank
 * lines and comments before the block ends. Such a line must go: leaving
 * `providers:` with no children parses as null, not as an absent key.
 * @param lines - the file's lines.
 * @param index - the key line to test.
 * @returns true when the key has no nested content.
 */
function isEmptyBlock(lines, index) {
  const end = subtreeEnd(lines, index, indentOf(lines[index]))
  return lines.slice(index + 1, end).every(isBlankOrComment)
}

/**
 * Remove a mapping entry whose value turned empty, then its own parent when
 * that empties too, so no dangling `key:` line is left behind.
 * @param lines - the file's lines (mutated in place).
 * @param index - the entry's key line.
 * @returns the number of lines removed.
 */
function pruneEmptyAncestors(lines, index) {
  let removed = 0
  let cursor = index
  while (cursor >= 0 && cursor < lines.length && isEmptyBlock(lines, cursor)) {
    const indent = indentOf(lines[cursor])
    lines.splice(cursor, 1)
    removed++
    // the enclosing key is the nearest previous line with less indentation
    let parent = cursor - 1
    while (parent >= 0 && isBlankOrComment(lines[parent])) parent--
    if (parent < 0 || indentOf(lines[parent]) >= indent) break
    cursor = parent
  }
  return removed
}

/**
 * Drop one provider key from this bundle's patch row.
 *
 * Idempotent and total: a missing file, a non-list document, a patch without
 * the row, or a row that never declared the provider all report `false` and
 * leave the file byte-identical. The caller has already removed the user-layer
 * entry through the settings transport, so "the patch had nothing to remove" is
 * a normal outcome, not an error.
 * @param yaml - the js-yaml module.
 * @param file - absolute path of the profile patch file.
 * @param providerName - provider key to remove from the row's base layer.
 * @returns whether the patch actually declared that provider.
 */
export function removeProviderFromPatchFile(yaml, file, providerName) {
  if (!existsSync(file)) return false
  const text = readFileSync(file, 'utf8')
  const doc = yaml.load(text, { schema: patchSchema(yaml) })
  const row = patchRows(doc).find((entry) => entry.id === PATCH_ROW_ID)
  const providers = row?.config?.providers
  if (!providers || typeof providers !== 'object' || !Object.hasOwn(providers, providerName)) return false

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  // The provider key line inside this row's `config:` → `providers:` mapping.
  // Anchoring on the row first keeps an identically named provider of another
  // patch row out of the blast radius.
  const rowStart = lines.findIndex((line) => new RegExp(`^[ \\t]*-[ \\t]*id:[ \\t]*['"]?${PATCH_ROW_ID}['"]?[ \\t]*$`).test(line))
  if (rowStart < 0) return false
  const rowIndent = indentOf(lines[rowStart])
  const rowEnd = subtreeEnd(lines, rowStart, rowIndent)
  const keyPattern = new RegExp(`^([ \\t]*)['"]?${providerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?[ \\t]*:`)
  let entryStart = -1
  let entryIndent = 0
  for (let index = rowStart + 1; index < rowEnd; index++) {
    const match = keyPattern.exec(lines[index])
    if (match !== null) { entryStart = index; entryIndent = indentOf(lines[index]); break }
  }
  if (entryStart < 0) return false
  const entryEnd = subtreeEnd(lines, entryStart, entryIndent)
  lines.splice(entryStart, entryEnd - entryStart)
  // `providers:` (and `config:` above it) must not survive with no children,
  // or the patch would parse `providers:` as null instead of as absent.
  let cursor = entryStart - 1
  while (cursor >= 0 && isBlankOrComment(lines[cursor])) cursor--
  if (cursor >= 0) pruneEmptyAncestors(lines, cursor)
  writeFileSync(file, lines.join(eol))
  return true
}
