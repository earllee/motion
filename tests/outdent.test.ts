import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { baseExtensions } from '@/editor/schema'
import { parseMarkdown } from '@/editor/markdown/parse'
import { serializeMarkdown } from '@/editor/markdown/serialize'
import { BlockRangeSelection } from '@/editor/blockSelection'
import { outdentListItem } from '@/editor/listIndent'

const schema = getSchema(baseExtensions())

function find(doc: EditorState['doc'], text: string) {
  let pos = -1
  doc.descendants((n, p) => {
    if (pos < 0 && n.isTextblock && n.textContent === text) pos = p + 1
  })
  return pos
}

/** Press Shift-Tab with the caret `offset` characters into the text `at` in `md`. */
function shiftTab(md: string, at: string, offset = 0) {
  const { doc } = parseMarkdown(md, schema)
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, find(doc, at) + offset) })
  let next = state
  const handled = outdentListItem(state, (tr) => (next = state.apply(tr)))
  const { $from } = next.selection
  // what gets saved reads back as the same document
  expect(parseMarkdown(serializeMarkdown(next.doc, null), schema).doc.eq(next.doc)).toBe(true)
  return {
    handled,
    md: serializeMarkdown(next.doc, null).trim(),
    caret: { text: $from.parent.textContent, offset: $from.parentOffset, item: $from.node(-1).type.name }
  }
}

describe('Shift-Tab on a nested list item', () => {
  it('outdents a bullet under a bullet', () => {
    const r = shiftTab('- one\n  - two\n', 'two', 2)
    expect(r.md).toBe('- one\n- two')
    expect(r.caret).toEqual({ text: 'two', offset: 2, item: 'listItem' })
  })

  it('keeps a bullet nested under a to-do a bullet', () => {
    const r = shiftTab('- [ ] one\n  - two\n', 'two', 1)
    expect(r.md).toBe('- [ ] one\n- two')
    expect(r.caret).toEqual({ text: 'two', offset: 1, item: 'listItem' })
  })

  it('keeps a to-do nested under a bullet a to-do', () => {
    const r = shiftTab('- one\n  - [x] two\n', 'two')
    expect(r.md).toBe('- one\n- [x] two')
    expect(r.caret.item).toBe('taskItem')
  })

  it('keeps a bullet nested under a numbered item a bullet', () => {
    expect(shiftTab('1. one\n   - two\n', 'two').md).toBe('1. one\n\n- two')
  })

  it('splits the outer list and carries the following siblings along', () => {
    const r = shiftTab('- [ ] a\n  - b\n  - c\n  - d\n- [ ] e\n', 'c')
    expect(r.md).toBe('- [ ] a\n  - b\n- c\n  - d\n- [ ] e')
    expect(r.caret).toEqual({ text: 'c', offset: 0, item: 'listItem' })
  })

  it('continues numbering after the split', () => {
    expect(shiftTab('1. a\n   - b\n2. c\n', 'b').md).toBe('1. a\n\n- b\n\n2. c')
  })

  it('outdents one level from deep nesting', () => {
    expect(shiftTab('- a\n  - [ ] b\n    - c\n', 'c').md).toBe('- a\n  - [ ] b\n  - c')
  })

  it('leaves top-level items alone', () => {
    const r = shiftTab('- one\n- two\n', 'two')
    expect(r.handled).toBe(false)
    expect(r.md).toBe('- one\n- two')
  })

  it('outdents a block selection of items', () => {
    const { doc } = parseMarkdown('- [ ] a\n  - b\n  - c\n', schema)
    const b = doc.resolve(find(doc, 'b')).before(-1)
    const c = doc.resolve(find(doc, 'c')).before(-1)
    const state = EditorState.create({ doc, selection: BlockRangeSelection.create(doc, b, c)! })
    let next = state
    expect(outdentListItem(state, (tr) => (next = state.apply(tr)))).toBe(true)
    expect(serializeMarkdown(next.doc, null).trim()).toBe('- [ ] a\n- b\n- c')
    expect(next.selection).toBeInstanceOf(BlockRangeSelection)
    expect(next.doc.slice(next.selection.from, next.selection.to).content.textBetween(0, next.selection.to - next.selection.from, '|')).toBe('b|c')
  })
})
