import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { liftListItem } from '@tiptap/pm/schema-list'
import { BlockRangeSelection } from './blockSelection'

const isItem = (n: PMNode | null | undefined) => !!n && (n.type.name === 'listItem' || n.type.name === 'taskItem')

/** Depth of the innermost list holding the selection's first item, or -1. */
function listDepthAt(state: EditorState) {
  const { $from } = state.selection
  // a block selection of items starts between them
  if (isItem($from.nodeAfter)) return $from.depth
  for (let d = $from.depth; d > 0; d--) if (isItem($from.node(d))) return d - 1
  return -1
}

/**
 * Shift-Tab on a nested list item: move it (and any selected siblings) out one level,
 * right after its parent item, keeping its own kind. A bullet nested under a to-do
 * stays a bullet, and a to-do under a bullet stays a to-do. Items after it in the
 * same list become its children, like ProseMirror's liftListItem. Top-level items are
 * left alone. Returns false when there is no nested item to outdent.
 */
export function outdentListItem(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, $to } = state.selection
  const listDepth = listDepthAt(state)
  if (listDepth < 2 || !isItem($from.node(listDepth - 1))) return false
  const list = $from.node(listDepth)
  const pDepth = listDepth - 1
  const oDepth = listDepth - 2
  const outer = $from.node(oDepth)

  // same kind of list one level up: ProseMirror's lift already does the right thing
  if (outer.type === list.type) return liftListItem(list.child($from.index(listDepth)).type)(state, dispatch)

  const startIdx = $from.index(listDepth)
  const sameList = $to.depth >= listDepth && $to.before(listDepth) === $from.before(listDepth)
  const endIdx = !sameList ? startIdx : $to.depth > listDepth ? $to.index(listDepth) : $to.index(listDepth) - 1
  if (!dispatch) return true

  const items: PMNode[] = []
  list.forEach((n) => items.push(n))
  const before = items.slice(0, startIdx)
  const moved = items.slice(startIdx, endIdx + 1)
  const rest = items.slice(endIdx + 1)

  // the items after the moved ones nest under the last moved item
  if (rest.length) {
    const last = moved[moved.length - 1]
    const tail = last.lastChild
    moved[moved.length - 1] =
      tail && tail.type === list.type
        ? last.copy(last.content.replaceChild(last.childCount - 1, tail.copy(tail.content.append(Fragment.from(rest)))))
        : last.copy(last.content.addToEnd(list.copy(Fragment.from(rest))))
  }

  // the parent item keeps the items before them, or loses the sub-list
  const parent = $from.node(pDepth)
  const listIdx = $from.index(pDepth)
  const parentKids: PMNode[] = []
  parent.forEach((n, _, i) => {
    if (i !== listIdx) parentKids.push(n)
    else if (before.length) parentKids.push(list.copy(Fragment.from(before)))
  })
  const newParent = parent.copy(Fragment.from(parentKids))

  // split the outer list around the parent and put the moved items between, in their own list
  const pIdx = $from.index(oDepth)
  const outerKids: PMNode[] = []
  outer.forEach((n) => outerKids.push(n))
  const head = outer.copy(Fragment.from([...outerKids.slice(0, pIdx), newParent]))
  const after = outerKids.slice(pIdx + 1)
  const nodes = [head, list.copy(Fragment.from(moved))]
  if (after.length) {
    const attrs = 'start' in outer.attrs ? { ...outer.attrs, start: Number(outer.attrs.start ?? 1) + pIdx + 1 } : outer.attrs
    nodes.push(outer.type.create(attrs, Fragment.from(after), outer.marks))
  }

  const outerPos = $from.before(oDepth)
  const oldStart = $from.posAtIndex(startIdx, listDepth)
  const tr = state.tr.replaceWith(outerPos, outerPos + outer.nodeSize, Fragment.from(nodes))
  // the moved items keep their insides, so the selection just shifts with them
  const delta = outerPos + head.nodeSize + 1 - oldStart
  const sel = state.selection
  if (sel instanceof BlockRangeSelection) {
    const next = BlockRangeSelection.create(tr.doc, sel.anchorBlock + delta, sel.headBlock + delta)
    if (next) tr.setSelection(next)
  } else if (sameList) {
    tr.setSelection(TextSelection.create(tr.doc, sel.anchor + delta, sel.head + delta))
  } else {
    tr.setSelection(TextSelection.create(tr.doc, sel.from + delta))
  }
  dispatch(tr.scrollIntoView())
  return true
}
