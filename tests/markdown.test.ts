import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { baseExtensions } from '@/editor/schema'
import { parseMarkdown } from '@/editor/markdown/parse'
import { serializeMarkdown } from '@/editor/markdown/serialize'

const schema = getSchema(baseExtensions())
const ROOT = process.env.MD_ROOT || join(__dirname, '../../..')
const SKIP = new Set(['node_modules', '.git', 'out', 'release', 'dist'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(md|markdown)$/i.test(name)) out.push(p)
  }
  return out
}

const files = walk(ROOT)

/** Re-serialize everything from scratch (as if every block were edited). */
function fresh(text: string) {
  const { doc, source } = parseMarkdown(text, schema)
  return serializeMarkdown(doc, null, source.frontmatter)
}

describe('markdown round-trip', () => {
  it('found files', () => expect(files.length).toBeGreaterThan(10))

  it('preserves untouched files byte-for-byte', () => {
    const bad: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      const { doc, source } = parseMarkdown(text, schema)
      if (serializeMarkdown(doc, source) !== text) bad.push(f)
    }
    expect(bad).toEqual([])
  })

  it('re-serialized output parses to the same document', () => {
    const bad: { f: string; a: string; b: string }[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      const a = parseMarkdown(text, schema).doc
      const out = fresh(text)
      const b = parseMarkdown(out, schema).doc
      // mdKind only records how a link was spelled; [url](url) may come back as a bare url
      const norm = (j: unknown) => JSON.stringify(j).replace(/"mdKind":(null|"bare"|"angle"),?/g, '')
      if (norm(a.toJSON()) !== norm(b.toJSON())) bad.push({ f, a: '', b: '' })
    }
    expect(bad.map((x) => x.f)).toEqual([])
  })

  it('re-serialization is idempotent', () => {
    const bad: string[] = []
    for (const f of files) {
      const once = fresh(readFileSync(f, 'utf8'))
      if (fresh(once) !== once) bad.push(f)
    }
    expect(bad).toEqual([])
  })
})
