import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { baseExtensions } from '@/editor/schema'
import { parseMarkdown } from '@/editor/markdown/parse'
import { serializeMarkdown } from '@/editor/markdown/serialize'
import { itemToTodo, todoToBullet } from '@/editor/blocks'

const schema = getSchema(baseExtensions())

/** Type `marker` + space at the start of the text `at` in `md`, as the input rule sees it. */
function typeMarker(md: string, at: string, marker: string) {
  const { doc } = parseMarkdown(md, schema)
  let start = -1
  doc.descendants((n, pos) => {
    if (start < 0 && n.isTextblock && n.textContent === at) start = pos + 1
  })
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, start) })
  state = state.apply(state.tr.insertText(marker))
  const tr = state.tr
  const result = itemToTodo(tr, start, start + marker.length, marker === '[x]')
  if (result) expect(tr.selection.$from.node(-1).type.name).toBe('taskItem')
  return result ? serializeMarkdown(tr.doc, null).trim() : null
}

describe('[] in a list item', () => {
  it('turns an empty bullet into a to-do', () => {
    expect(typeMarker('- one\n- \n', '', '[]')).toBe('- one\n- [ ]')
  })

  it('splits the list around the item and keeps its text', () => {
    expect(typeMarker('- one\n- two\n- three\n', 'two', '[]')).toBe('- one\n- [ ] two\n- three')
  })

  it('handles [ ] and [x]', () => {
    expect(typeMarker('- one\n- two\n', 'two', '[ ]')).toBe('- one\n- [ ] two')
    expect(typeMarker('- one\n- two\n', 'two', '[x]')).toBe('- one\n- [x] two')
  })

  it('works in nested and numbered items', () => {
    expect(typeMarker('- one\n  - two\n', 'two', '[]')).toBe('- one\n  - [ ] two')
    expect(typeMarker('1. one\n2. two\n', 'two', '[]')).toBe('1. one\n\n- [ ] two')
  })

  it('leaves plain paragraphs to the default rule', () => {
    expect(typeMarker('hello\n\nworld\n', 'world', '[]')).toBeNull()
  })
})

/** Type `- ` at the start of the text `at` in `md`, as the bullet input rule sees it. */
function typeDash(md: string, at: string) {
  const { doc } = parseMarkdown(md, schema)
  let start = -1
  doc.descendants((n, pos) => {
    if (start < 0 && n.isTextblock && n.textContent === at) start = pos + 1
  })
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, start) })
  state = state.apply(state.tr.insertText('-'))
  const tr = state.tr
  const result = todoToBullet(tr, start, start + 1)
  if (result) {
    expect(tr.selection.$from.node(-1).type.name).toBe('listItem')
    expect(tr.selection.$from.parentOffset).toBe(0)
  }
  return result ? serializeMarkdown(tr.doc, null).trim() : null
}

describe('- in a to-do', () => {
  it('turns an empty to-do into a bullet', () => {
    expect(typeDash('- [ ] one\n- [ ] \n', '')).toBe('- [ ] one\n-')
  })

  it('splits the list around the item and keeps its text', () => {
    expect(typeDash('- [ ] one\n- [x] two\n- [ ] three\n', 'two')).toBe('- [ ] one\n- two\n- [ ] three')
  })

  it('works in nested to-dos', () => {
    expect(typeDash('- [ ] one\n  - [ ] two\n', 'two')).toBe('- [ ] one\n  - two')
  })

  it('leaves bullets and paragraphs to the default rule', () => {
    expect(typeDash('- one\n- two\n', 'two')).toBeNull()
    expect(typeDash('hello\n\nworld\n', 'world')).toBeNull()
  })
})
