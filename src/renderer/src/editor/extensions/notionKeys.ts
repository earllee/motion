import { Extension, InputRule, textblockTypeInputRule, wrappingInputRule } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, TextSelection, Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { liftListItem, sinkListItem } from '@tiptap/pm/schema-list'
import {
  blockAtResolved,
  currentBlock,
  deleteBlock,
  duplicateBlock,
  itemToTodo,
  todoToBullet,
  moveBlock,
  placeCaret,
  turnInto,
  type BlockKind
} from '../blocks'
import {
  BlockRangeSelection,
  deleteBlockRange,
  duplicateBlockRange,
  extendBlockSelection,
  moveBlockRange,
  selectBlocksForText,
  selectedBlocks,
  turnSelection
} from '../blockSelection'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const isItem = (n: PMNode | null | undefined) => !!n && (n.type.name === 'listItem' || n.type.name === 'taskItem')

/** The innermost list item (bullet, numbered or to-do) at the selection start, and whether it is nested. */
function listItemAt(state: EditorState) {
  const { $from } = state.selection
  // a block selection of items starts between them
  if (isItem($from.nodeAfter)) return { type: $from.nodeAfter!.type, nested: isItem($from.node($from.depth - 1)) }
  for (let d = $from.depth; d > 0; d--) {
    if (isItem($from.node(d))) return { type: $from.node(d).type, nested: d >= 3 && isItem($from.node(d - 2)) }
  }
  return null
}

const atStartOfTextblock = (state: EditorState) => {
  const { $from, empty } = state.selection
  return empty && $from.parent.isTextblock && $from.parentOffset === 0
}

/** Replace a container (toggle/callout/quote) with its children. */
function unwrapContainer(state: EditorState, dispatch: EditorView['dispatch'] | undefined, depth: number) {
  const $from = state.selection.$from
  const container = $from.node(depth)
  const pos = $from.before(depth)
  const tr = state.tr.replaceWith(pos, pos + container.nodeSize, container.content)
  placeCaret(tr, pos, 0)
  dispatch?.(tr.scrollIntoView())
  return true
}

/**
 * Notion keyboard behavior on top of TipTap's defaults: Backspace at the start of a
 * typed block turns it back into text, Esc selects the block, ⌘D duplicates,
 * ⌘⇧↑/↓ moves, ⌘⌥0–8 turns into, ⌘↵ toggles to-dos and toggles.
 */
export const NotionKeys = Extension.create({
  name: 'notionKeys',
  priority: 1000,

  addKeyboardShortcuts() {
    const editor = this.editor
    const run = (fn: (state: EditorState, dispatch: EditorView['dispatch']) => boolean) => () =>
      fn(editor.state, editor.view.dispatch)
    // Like run, but first applies any selection change the browser hasn't reported yet
    // (a fast ⇧↓ then Esc would otherwise act on the old caret).
    const fresh = (fn: (state: EditorState, dispatch: EditorView['dispatch']) => boolean) => () => {
      ;(editor.view as unknown as { domObserver?: { flush(): void } }).domObserver?.flush()
      return fn(editor.state, editor.view.dispatch)
    }

    const turn = (kind: BlockKind) => fresh(() => turnSelection(editor.view, kind))

    const deleteSelected = run((state, dispatch) => {
      const sel = state.selection
      if (sel instanceof BlockRangeSelection) {
        const tr = state.tr
        deleteBlockRange(tr, sel.from, sel.to)
        dispatch(tr.scrollIntoView())
        return true
      }
      if (sel instanceof NodeSelection && sel.node.isBlock) {
        const info = currentBlock(state)
        if (info) dispatch(deleteBlock(state, info))
        return true
      }
      return false
    })

    return {
      Delete: deleteSelected,
      Backspace: run((state, dispatch) => {
        const sel = state.selection
        if (deleteSelected()) return true
        if (!atStartOfTextblock(state)) return false
        const $from = sel.$from
        const parent = $from.parent
        const depth = $from.depth
        // heading / code → text
        if (parent.type.name === 'heading' || parent.type.name === 'codeBlock') {
          if (parent.type.name === 'codeBlock' && parent.textContent) return false
          const info = blockAtResolved($from)
          if (!info) return false
          const tr = turnInto(state, info, 'paragraph')
          if (tr) dispatch(tr)
          return true
        }
        if (depth < 2) return false
        const container = $from.node(depth - 1)
        const isLead = $from.index(depth - 1) === 0
        if (!isLead) return false
        const name = container.type.name
        if (name === 'listItem' || name === 'taskItem') {
          return liftListItem(container.type)(state, dispatch)
        }
        if (name === 'toggle' || name === 'callout' || name === 'blockquote') {
          return unwrapContainer(state, dispatch, depth - 1)
        }
        return false
      }),

      Enter: run((state, dispatch) => {
        if (state.selection instanceof BlockRangeSelection) {
          // back to editing at the end of the run
          dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(state.selection.to - 1), -1)))
          return true
        }
        const { $from, empty } = state.selection
        if (!empty) return false
        const depth = $from.depth
        const parent = $from.parent
        if (depth >= 2) {
          const container = $from.node(depth - 1)
          const isLead = $from.index(depth - 1) === 0
          if (container.type.name === 'toggle' && isLead) {
            const dom = editor.view.nodeDOM($from.before(depth - 1)) as HTMLElement | null
            const open = dom?.classList.contains('is-open')
            if (parent.content.size === 0 && container.childCount === 1) return unwrapContainer(state, dispatch, depth - 1)
            if (!open && $from.parentOffset === parent.content.size) {
              // closed toggle: new sibling toggle below, like Notion
              const after = $from.after(depth - 1)
              const tr = state.tr.insert(
                after,
                state.schema.nodes.toggle.create(null, state.schema.nodes.paragraph.create())
              )
              tr.setSelection(TextSelection.create(tr.doc, after + 2))
              dispatch(tr.scrollIntoView())
              return true
            }
          }
        }
        // Enter at the start of a non-empty heading inserts a text block above
        if (parent.type.name === 'heading' && $from.parentOffset === 0 && parent.content.size > 0) {
          const pos = $from.before()
          const tr = state.tr.insert(pos, state.schema.nodes.paragraph.create())
          dispatch(tr.scrollIntoView())
          return true
        }
        // Enter in a table cell: line break (cells hold one paragraph)
        if ($from.node(depth - 1)?.type.spec.tableRole === 'cell' || $from.node(depth - 1)?.type.spec.tableRole === 'header_cell') {
          dispatch(state.tr.replaceSelectionWith(state.schema.nodes.hardBreak.create()).scrollIntoView())
          return true
        }
        return false
      }),

      'Mod-Enter': run((state, dispatch) => {
        const { $from } = state.selection
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d)
          if (node.type.name === 'taskItem') {
            dispatch(state.tr.setNodeMarkup($from.before(d), undefined, { ...node.attrs, checked: !node.attrs.checked }))
            return true
          }
          if (node.type.name === 'toggle') {
            const dom = editor.view.nodeDOM($from.before(d)) as HTMLElement | null
            dom?.querySelector<HTMLElement>(':scope > .toggle-button')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            return true
          }
        }
        dispatch(state.tr.replaceSelectionWith(state.schema.nodes.hardBreak.create()).scrollIntoView())
        return true
      }),

      Escape: fresh((state, dispatch) => {
        const sel = state.selection
        if (sel instanceof NodeSelection || sel instanceof BlockRangeSelection) {
          // second Esc: back to a caret at the end of the block(s)
          dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(sel.to - 1), -1)))
          return true
        }
        // a text selection across blocks selects all of them
        const blocks = selectBlocksForText(state)
        if (!blocks) return false
        dispatch(state.tr.setSelection(blocks))
        return true
      }),

      'Shift-ArrowUp': fresh((state, dispatch) => {
        const next = extendBlockSelection(state, -1)
        if (!next) return false
        dispatch(state.tr.setSelection(next).scrollIntoView())
        return true
      }),
      'Shift-ArrowDown': fresh((state, dispatch) => {
        const next = extendBlockSelection(state, 1)
        if (!next) return false
        dispatch(state.tr.setSelection(next).scrollIntoView())
        return true
      }),

      'Mod-a': run((state, dispatch) => {
        // first ⌘A selects the block's text, the second selects every block
        const sel = state.selection
        const { $from, $to } = sel
        if (sel instanceof BlockRangeSelection || sel instanceof NodeSelection) {
          const first = 0
          const last = state.doc.content.size - state.doc.lastChild!.nodeSize
          const all = BlockRangeSelection.create(state.doc, first, last)
          if (all) dispatch(state.tr.setSelection(all))
          return true
        }
        if ($from.sameParent($to) && $from.parent.isTextblock) {
          const whole = $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size
          if (!whole) {
            dispatch(state.tr.setSelection(TextSelection.create(state.doc, $from.start(), $from.end())))
            return true
          }
        }
        const last = state.doc.content.size - state.doc.lastChild!.nodeSize
        const all = state.doc.childCount > 1 ? BlockRangeSelection.create(state.doc, 0, last) : NodeSelection.create(state.doc, 0)
        if (all) dispatch(state.tr.setSelection(all))
        return true
      }),

      ArrowUp: run((state, dispatch) => selectSibling(state, dispatch, -1)),
      ArrowDown: run((state, dispatch) => selectSibling(state, dispatch, 1)),

      'Mod-d': run((state, dispatch) => {
        if (state.selection instanceof BlockRangeSelection) {
          dispatch(duplicateBlockRange(state, state.selection).scrollIntoView())
          return true
        }
        const info = currentBlock(state)
        if (!info) return false
        dispatch(duplicateBlock(state, info).scrollIntoView())
        return true
      }),

      'Mod-Shift-ArrowUp': fresh((state, dispatch) => moveSelected(state, dispatch, -1)),
      'Mod-Shift-ArrowDown': fresh((state, dispatch) => moveSelected(state, dispatch, 1)),

      'Mod-Alt-0': turn('paragraph'),
      'Mod-Alt-1': turn('h1'),
      'Mod-Alt-2': turn('h2'),
      'Mod-Alt-3': turn('h3'),
      'Mod-Alt-4': turn('taskList'),
      'Mod-Alt-5': turn('bulletList'),
      'Mod-Alt-6': turn('orderedList'),
      'Mod-Alt-7': turn('toggle'),
      'Mod-Alt-8': turn('codeBlock'),

      Tab: fresh((state, dispatch) => {
        const { $from } = state.selection
        if ($from.parent.type.name === 'codeBlock') {
          dispatch(state.tr.insertText('  '))
          return true
        }
        // nest the item (or selected items) under the one above it
        const item = listItemAt(state)
        if (item) {
          sinkListItem(item.type)(state, dispatch)
          return true
        }
        // nest a paragraph under the list item right above it
        const info = blockAtResolved($from)
        if (info && info.node.type.name === 'paragraph' && info.depth >= 1) {
          const $b = state.doc.resolve(info.pos)
          const prev = $b.nodeBefore
          if (prev && (prev.type.name === 'bulletList' || prev.type.name === 'orderedList' || prev.type.name === 'taskList')) {
            const insertAt = info.pos - 2 // end of the last item's content
            const tr = state.tr.delete(info.pos, info.pos + info.node.nodeSize)
            tr.insert(insertAt, info.node)
            placeCaret(tr, insertAt, $from.parentOffset)
            dispatch(tr.scrollIntoView())
            return true
          }
        }
        // swallow Tab so focus never leaves the editor
        return true
      }),
      'Shift-Tab': fresh((state, dispatch) => {
        const { $from } = state.selection
        // a continuation paragraph inside a list item moves back out after the list
        const depth = $from.depth
        if (depth >= 3) {
          const item = $from.node(depth - 1)
          const index = $from.index(depth - 1)
          if ((item.type.name === 'listItem' || item.type.name === 'taskItem') && index > 0 && $from.parent.type.name === 'paragraph') {
            const list = $from.node(depth - 2)
            if ($from.index(depth - 2) === list.childCount - 1 && index === item.childCount - 1) {
              const para = $from.parent
              const paraPos = $from.before(depth)
              const listEnd = $from.after(depth - 2)
              const tr = state.tr.insert(listEnd, para)
              tr.delete(paraPos, paraPos + para.nodeSize)
              placeCaret(tr, tr.mapping.map(listEnd) - para.nodeSize, $from.parentOffset)
              dispatch(tr.scrollIntoView())
              return true
            }
          }
        }
        // top-level items stay in their list
        const item = listItemAt(state)
        if (item?.nested) liftListItem(item.type)(state, dispatch)
        return true
      })
    }
  },

  addInputRules() {
    const { schema } = this.editor
    return [
      // Notion: `"` + space makes a quote
      wrappingInputRule({ find: /^\s*"\s$/, type: schema.nodes.blockquote }),
      // ``` makes a code block immediately (TipTap's rule waits for a space)
      textblockTypeInputRule({ find: /^```$/, type: schema.nodes.codeBlock }),
      // `>` + space after `>` makes a toggle (`>> `)
      wrappingInputRule({ find: /^>>\s$/, type: schema.nodes.toggle }),
      // `[] ` in a bullet/numbered item makes it a to-do (TipTap's rule would nest a new list)
      new InputRule({
        find: /^\[([ x])?\]\s$/,
        handler: ({ state, range, match }) => {
          if (!itemToTodo(state.tr, range.from, range.to, match[1] === 'x')) return null
        }
      }),
      // and `- ` in a to-do makes it a bullet again
      new InputRule({
        find: /^[-+*]\s$/,
        handler: ({ state, range }) => {
          if (!todoToBullet(state.tr, range.from, range.to)) return null
        }
      }),
      // typing [text](url) makes a link
      new InputRule({
        find: /(?:^|[^!])\[([^[\]]+)\]\(([^()\s]+)\)$/,
        handler: ({ state, range, match }) => {
          const [full, text, href] = match
          const start = range.from + (full.length - (text.length + href.length + 4))
          state.tr.replaceWith(start, range.to, schema.text(text, [schema.marks.link.create({ href })]))
          state.tr.removeStoredMark(schema.marks.link)
        }
      })
    ]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockSelectionClass'),
        props: {
          attributes: (state): Record<string, string> =>
            selectedBlocks(state) ? { class: 'has-block-selection' } : {},
          decorations: (state) => {
            const sel = state.selection
            if (!(sel instanceof BlockRangeSelection)) return null
            return DecorationSet.create(
              state.doc,
              sel.blocks().map((b) => Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: 'block-selected' }))
            )
          },
          // typing over selected blocks would silently replace them; Notion ignores it
          handleTextInput: (view) => !!selectedBlocks(view.state),
          handleDOMEvents: { mousedown: shiftClickBlocks }
        }
      })
    ]
  }
})

/** ⌘⇧↑/↓: move the selected blocks, the blocks a text selection touches, or the caret's block. */
function moveSelected(state: EditorState, dispatch: EditorView['dispatch'], dir: -1 | 1): boolean {
  let sel = state.selection
  if (!(sel instanceof BlockRangeSelection) && !sel.empty && !sel.$from.sameParent(sel.$to)) {
    const blocks = selectBlocksForText(state)
    if (blocks) {
      state = state.apply(state.tr.setSelection(blocks))
      sel = blocks
    }
  }
  if (sel instanceof BlockRangeSelection) {
    const tr = moveBlockRange(state, sel, dir)
    if (tr) dispatch(tr)
    return true
  }
  const info = currentBlock(state)
  const tr = info && moveBlock(state, info, dir)
  if (tr) dispatch(tr)
  return true
}

/** Shift-click in another block selects every block from the caret's to the clicked one. */
function shiftClickBlocks(view: EditorView, event: MouseEvent): boolean {
  if (!event.shiftKey || event.button !== 0) return false
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!hit) return false
  const { state } = view
  const sel = state.selection
  const anchor = sel instanceof BlockRangeSelection ? sel.anchorBlock + 1 : sel instanceof NodeSelection ? sel.from + 1 : sel.anchor
  const $anchor = state.doc.resolve(Math.min(anchor, state.doc.content.size))
  const $hit = state.doc.resolve(hit.pos)
  const a = blockAtResolved($anchor)
  const b = blockAtResolved($hit)
  if (!a || !b || a.pos === b.pos) return false
  const asText = state.apply(state.tr.setSelection(TextSelection.between($anchor, $hit)))
  const blocks = selectBlocksForText(asText)
  if (!blocks) return false
  event.preventDefault()
  view.dispatch(state.tr.setSelection(blocks))
  view.focus()
  return true
}

/** With a block selected, ↑/↓ select the previous/next block. */
function selectSibling(state: EditorState, dispatch: EditorView['dispatch'], dir: -1 | 1): boolean {
  const sel = state.selection
  // with a run selected, ↑/↓ step out of it to the block above/below
  if (!(sel instanceof BlockRangeSelection) && (!(sel instanceof NodeSelection) || !sel.node.isBlock)) return false
  const target = dir === -1 ? sel.from - 1 : sel.to + 1
  if (target < 0 || target > state.doc.content.size) return true
  const $t = state.doc.resolve(Math.max(0, Math.min(target, state.doc.content.size)))
  // find the block at the neighbouring position
  const probe = dir === -1 ? TextSelection.near($t, -1).$from : TextSelection.near($t, 1).$from
  const info = blockAtResolved(probe)
  if (!info || info.pos === sel.from) return true
  dispatch(state.tr.setSelection(NodeSelection.create(state.doc, info.pos)).scrollIntoView())
  return true
}

