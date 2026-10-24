import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { BlockRangeSelection } from '../blockSelection'
import type { EditorView } from '@tiptap/pm/view'
import { blockAt, type BlockInfo } from '../blocks'
import { createStore } from '@/store'

/** Where a dragged block would land: a horizontal line above/below a block. */
export const dropLineStore = createStore<{ top: number; left: number; width: number } | null>(null)

/** The blocks being dragged by the ⋮⋮ handle (one block or a selected run). */
export const blockDrag: { current: { from: number; to: number; nodes: PMNode[] } | null } = { current: null }

/** Widen a run that is a parent's entire content to the parent, so nothing is left empty. */
function wholeRange(doc: PMNode, from: number, to: number): [number, number] {
  let $from = doc.resolve(from)
  let $to = doc.resolve(to)
  while ($from.depth > 0 && from === $from.start() && to === $to.end()) {
    from = $from.before()
    to = $to.after()
    $from = doc.resolve(from)
    $to = doc.resolve(to)
  }
  return [from, to]
}

export function dropTarget(view: EditorView, x: number, y: number): { pos: number; rect: DOMRect; info: BlockInfo; before: boolean } | null {
  const er = view.dom.getBoundingClientRect()
  const found = view.posAtCoords({ left: Math.min(Math.max(x, er.left + 6), er.right - 6), top: y })
  if (!found) return null
  let info: BlockInfo | null = null
  if (found.inside >= 0) {
    const n = view.state.doc.nodeAt(found.inside)
    if (n && n.isBlock && n.isAtom) info = { pos: found.inside, node: n, depth: 1 }
  }
  if (!info) info = blockAt(view.state.doc, found.pos)
  if (!info) return null
  const dom = view.nodeDOM(info.pos) as HTMLElement | null
  if (!dom) return null
  // For containers, only the lead line counts as "the block"; below it means inside/after children.
  const rect = dom.getBoundingClientRect()
  const before = y < rect.top + Math.min(rect.height, 40) / 2
  return { pos: before ? info.pos : info.pos + info.node.nodeSize, rect, info, before }
}

/** Notion-style block drag & drop: vertical position decides before/after, with a blue line. */
export const BlockDrop = Extension.create({
  name: 'blockDrop',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockDrop'),
        props: {
          handleDOMEvents: {
            dragover: (view, event) => {
              if (!blockDrag.current) return false
              const t = dropTarget(view, event.clientX, event.clientY)
              const wrap = view.dom.parentElement?.parentElement
              // keep the last line while between targets so it glides instead of flickering
              if (!t || !wrap) return false
              const wr = wrap.getBoundingClientRect()
              const top = (t.before ? t.rect.top : t.rect.bottom) - wr.top - 2
              dropLineStore.set({ top, left: t.rect.left - wr.left, width: t.rect.width })
              return false
            },
            dragleave: (view, event) => {
              if (!view.dom.parentElement?.parentElement?.contains(event.relatedTarget as Node)) dropLineStore.set(null)
              return false
            },
            dragend: () => {
              dropLineStore.set(null)
              return false
            },
            drop: () => {
              setTimeout(() => dropLineStore.set(null), 0)
              return false
            }
          },
          handleDrop: (view, event, _slice, moved) => {
            const drag = blockDrag.current
            if (!drag) return false
            blockDrag.current = null
            dropLineStore.set(null)
            const t = dropTarget(view, event.clientX, event.clientY)
            if (!t) return false
            event.preventDefault()
            if (t.pos >= drag.from && t.pos <= drag.to) return true
            const tr = view.state.tr
            if (moved) {
              const [from, to] = wholeRange(tr.doc, drag.from, drag.to)
              tr.delete(from, to)
            }
            const at = tr.mapping.map(t.pos)
            const before = tr.doc.content.size
            tr.replaceRange(at, at, new Slice(Fragment.fromArray(drag.nodes), 0, 0))
            const inserted = tr.doc.content.size - before
            try {
              // select what landed: one block, or the whole run
              const $at = tr.doc.resolve(at)
              const first = $at.nodeAfter && $at.nodeAfter.type === drag.nodes[0].type ? at : tr.mapping.map(at, -1)
              if (drag.nodes.length === 1) tr.setSelection(NodeSelection.create(tr.doc, first))
              else {
                const lastSize = drag.nodes[drag.nodes.length - 1].nodeSize
                const run = BlockRangeSelection.create(tr.doc, first, first + inserted - lastSize)
                if (run) tr.setSelection(run)
              }
            } catch {
              /* wrapped into a list etc. — keep the default selection */
            }
            view.dispatch(tr.scrollIntoView().setMeta('uiEvent', 'drop'))
            view.focus()
            return true
          }
        }
      })
    ]
  }
})
