import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { sinkListItem } from '@tiptap/pm/schema-list'
import { baseExtensions } from '@/editor/schema'
import { parseMarkdown } from '@/editor/markdown/parse'
import { serializeMarkdown } from '@/editor/markdown/serialize'
import { sinkIntoPreviousList } from '@/editor/extensions/notionKeys'

const schema = getSchema(baseExtensions())

/** Press Tab with the caret in the text `at`, the way the Tab key handler does. */
function tab(md: string, at: string) {
  const { doc } = parseMarkdown(md, schema)
  let start = -1
  doc.descendants((n, pos) => {
    if (start < 0 && n.isTextblock && n.textContent === at) start = pos + 1
  })
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, start + 2) })
  const dispatch = (tr: import('@tiptap/pm/state').Transaction) => (state = state.apply(tr))
  const item = state.selection.$from.node(-1).type
  if (!sinkListItem(item)(state, dispatch)) sinkIntoPreviousList(state, dispatch)
  expect(state.selection.$from.parent.textContent).toBe(at)
  expect(state.selection.$from.parentOffset).toBe(2)
  return serializeMarkdown(state.doc, null).trim()
}

describe('Tab on a list item', () => {
  it('nests a to-do under the item above it', () => {
    expect(tab('- [ ] one\n- [x] two\n', 'two')).toBe('- [ ] one\n  - [x] two')
  })

  it('nests a to-do that follows a bullet', () => {
    expect(tab('- one\n- [x] two\n- [ ] three\n', 'two')).toBe('- one\n  - [x] two\n- [ ] three')
  })

  it('joins the nested to-dos already under the bullet', () => {
    expect(tab('- one\n  - [ ] a\n  - [ ] b\n- [x] two\n', 'two')).toBe(
      '- one\n  - [ ] a\n  - [ ] b\n  - [x] two'
    )
  })

  it('nests a bullet that follows a to-do', () => {
    expect(tab('- [ ] one\n- two\n', 'two')).toBe('- [ ] one\n  - two')
  })

  it('keeps the item’s own children', () => {
    expect(tab('- one\n- [x] two\n  - child\n', 'two')).toBe('- one\n  - [x] two\n    - child')
  })
})
