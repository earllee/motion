import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { baseExtensions } from '@/editor/schema'
import { parseMarkdown } from '@/editor/markdown/parse'
import { serializeMarkdown } from '@/editor/markdown/serialize'
import { currentBlock } from '@/editor/blocks'
import { BlockRangeSelection } from '@/editor/blockSelection'
import { moveListItems } from '@/editor/moveItems'

const schema = getSchema(baseExtensions())

function textPos(doc: EditorState['doc'], text: string) {
  let found = -1
  doc.descendants((n, pos) => {
    if (found < 0 && n.isTextblock && n.textContent === text) found = pos + 1
  })
  if (found < 0) throw new Error(`no ${text}`)
  return found
}

/** Two lists of the same kind side by side would render as one list but behave as two. */
function noSplitLists(doc: EditorState['doc']) {
  doc.descendants((n) => {
    for (let i = 1; i < n.childCount; i++) {
      const a = n.child(i - 1)
      const b = n.child(i)
      if (a.type.name.endsWith('List') && a.type === b.type) throw new Error(`adjacent ${a.type.name}s`)
    }
  })
}

/** Press ⌘⇧↑ (-1) or ⌘⇧↓ (1) `times` times with the caret in the item `at`; returns the markdown. */
function move(md: string, at: string, dir: -1 | 1, times = 1) {
  const { doc } = parseMarkdown(md, schema)
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, textPos(doc, at) + 1) })
  for (let i = 0; i < times; i++) {
    const info = currentBlock(state)!
    const tr = moveListItems(state, info.pos, info.pos + info.node.nodeSize, dir)
    if (!tr) return null
    state = state.apply(tr)
    noSplitLists(state.doc)
    // the caret stays in the moved item, one character in
    expect(state.selection.$from.parent.textContent).toBe(at)
    expect(state.selection.$from.parentOffset).toBe(1)
  }
  return serializeMarkdown(state.doc, null).trim()
}

describe('⌘⇧↑/↓ on list items', () => {
  it('swaps with a sibling', () => {
    expect(move('- one\n- two\n', 'two', -1)).toBe('- two\n- one')
    expect(move('- one\n- two\n', 'one', 1)).toBe('- two\n- one')
  })

  it('lifts out above the parent from the first child', () => {
    expect(move('- one\n  - two\n  - three\n', 'two', -1)).toBe('- two\n- one\n  - three')
  })

  it('lifts out below the parent from the last child', () => {
    expect(move('- one\n  - two\n- three\n', 'two', 1)).toBe('- one\n- two\n- three')
  })

  it('moves into the item above as its last child', () => {
    expect(move('- one\n  - two\n- three\n', 'three', -1)).toBe('- one\n  - two\n  - three')
  })

  it('moves into the item below as its first child', () => {
    expect(move('- one\n- two\n  - three\n', 'one', 1)).toBe('- two\n  - one\n  - three')
  })

  it('walks all the way through nested levels and back', () => {
    const md = '- a\n  - b\n    - c\n- d\n'
    expect(move(md, 'd', -1)).toBe('- a\n  - b\n    - c\n  - d')
    expect(move(md, 'd', -1, 2)).toBe('- a\n  - b\n    - c\n    - d')
    expect(move(md, 'd', -1, 3)).toBe('- a\n  - b\n    - d\n    - c')
    expect(move(md, 'd', -1, 4)).toBe('- a\n  - d\n  - b\n    - c')
    expect(move(md, 'd', -1, 5)).toBe('- d\n- a\n  - b\n    - c')
    expect(move('- d\n- a\n  - b\n    - c\n', 'd', 1, 5)).toBe('- a\n  - b\n    - c\n- d')
  })

  it('carries its own children along', () => {
    expect(move('- one\n- two\n  - kid\n', 'two', -1)).toBe('- two\n  - kid\n- one')
  })

  it('crosses between to-dos and bullets', () => {
    expect(move('- [ ] task\n- one\n', 'one', -1)).toBe('- one\n- [ ] task')
    expect(move('- one\n- [ ] task\n- two\n', 'one', 1)).toBe('- [ ] task\n- one\n- two')
    expect(move('- [ ] a\n  - b\n', 'b', -1)).toBe('- b\n- [ ] a')
    expect(move('- one\n  - [ ] t\n- two\n', 'two', -1)).toBe('- one\n  - [ ] t\n  - two')
  })

  it('moves past a paragraph out of the list', () => {
    expect(move('Intro\n\n- one\n- two\n', 'one', -1)).toBe('- one\n\nIntro\n\n- two')
    expect(move('- one\n\nOutro\n', 'one', 1)).toBe('Outro\n\n- one')
  })

  it('stops at the top and bottom of the document', () => {
    expect(move('- one\n- two\n', 'one', -1)).toBeNull()
    expect(move('- one\n- two\n', 'two', 1)).toBeNull()
  })

  it('moves a block selection of items across levels', () => {
    const { doc } = parseMarkdown('- a\n  - b\n  - c\n- d\n', schema)
    const b = doc.resolve(textPos(doc, 'b')).before(-1)
    const c = doc.resolve(textPos(doc, 'c')).before(-1)
    let state = EditorState.create({ doc })
    state = state.apply(state.tr.setSelection(BlockRangeSelection.create(doc, b, c)!))
    const tr = moveListItems(state, state.selection.from, state.selection.to, -1)!
    state = state.apply(tr)
    expect(serializeMarkdown(state.doc, null).trim()).toBe('- b\n- c\n- a\n- d')
    expect(state.selection).toBeInstanceOf(BlockRangeSelection)
    expect((state.selection as BlockRangeSelection).blocks().map((x) => x.node.textContent)).toEqual(['b', 'c'])
  })
})
