import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import { baseExtensions } from '@/editor/schema'
import { parseMarkdown } from '@/editor/markdown/parse'
import { sliceToMarkdown, textOnlySlice } from '@/editor/extensions/clipboard'

const schema = getSchema(baseExtensions())

/** What the clipboard gets when copying from `from` to `to` (a text and an offset in it), as ProseMirror slices a selection. */
function copy(md: string, from: [string, number], to: [string, number]) {
  const { doc } = parseMarkdown(md, schema)
  const at = ([text, offset]: [string, number]) => {
    let pos = -1
    doc.descendants((n, p) => {
      if (pos < 0 && n.isTextblock && n.textContent === text) pos = p + 1 + offset
    })
    return pos
  }
  const slice = textOnlySlice(doc.slice(at(from), at(to), true))
  return { text: sliceToMarkdown(slice), slice }
}

describe('copying inside one line', () => {
  it('leaves out the bullet', () => {
    expect(copy('- one two\n- three\n', ['one two', 0], ['one two', 7]).text).toBe('one two')
  })

  it('leaves out the to-do marker', () => {
    const { text, slice } = copy('- [ ] buy milk\n- [x] done\n', ['buy milk', 4], ['buy milk', 8])
    expect(text).toBe('milk')
    expect(slice.content.firstChild!.type.name).toBe('paragraph')
  })

  it('leaves out the number and nesting', () => {
    expect(copy('1. top\n   - nested item\n', ['nested item', 0], ['nested item', 6]).text).toBe('nested')
  })

  it('keeps inline formatting', () => {
    expect(copy('- some **bold** text\n', ['some bold text', 0], ['some bold text', 9]).text).toBe('some **bold**')
  })
})

describe('copying across lines', () => {
  it('keeps the bullets', () => {
    expect(copy('- one\n- two\n', ['one', 0], ['two', 3]).text).toBe('- one\n- two')
  })

  it('keeps the to-do markers', () => {
    expect(copy('- [ ] one\n- [x] two\n', ['one', 1], ['two', 2]).text).toBe('- [ ] ne\n- [x] tw')
  })
})
