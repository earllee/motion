import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { BlockRangeSelection } from './blockSelection'
import { isList } from './blocks'

const isItem = (n: PMNode | null | undefined) => !!n && (n.type.name === 'listItem' || n.type.name === 'taskItem')

/**
 * ⌘⇧↑/↓ on list items: move a run of sibling items one visual line, crossing nesting
 * levels the way an outliner does. Moving up past an item with children drops the run
 * in as that item's last child; moving up from the first child lifts it out above the
 * parent. Moving down mirrors that. Neighbouring lists of another kind (a to-do list
 * after a bullet list) count as one list, and moving past a plain block takes the
 * items out of the list with them.
 *
 * `from`/`to` are the positions just before the first and just after the last item
 * of the run. Returns null when there is nowhere to go.
 */
export function moveListItems(state: EditorState, from: number, to: number, dir: -1 | 1): Transaction | null {
  const { doc } = state
  const $from = doc.resolve(from)
  const list = $from.parent
  if (!isList(list) || !isItem($from.nodeAfter)) return null
  const listPos = $from.before()
  const first = $from.index()
  let last = first
  for (let pos = from + list.child(first).nodeSize; pos < to; pos += list.child(last).nodeSize) last++
  const target = findTarget(doc, listPos, first, last, dir)
  if (target == null) return null

  const run = list.content.cut(from - listPos - 1, to - listPos - 1)
  const whole = first === 0 && last === list.childCount - 1
  const tr = state.tr
  // take the run out (the whole list when it is all of it)
  const cutFrom = whole ? listPos : from
  const cutTo = whole ? listPos + list.nodeSize : to
  tr.delete(cutFrom, cutTo)
  const afterDelete = tr.steps.length
  const gap = tr.mapping.map(cutFrom)

  // put it back at the target, in a list of its own kind
  const at = tr.mapping.map(target)
  const $at = tr.doc.resolve(at)
  let itemPos: number
  if ($at.parent.type === list.type) {
    tr.insert(at, run)
    itemPos = at
  } else {
    let wrapAt = at
    if (isList($at.parent)) {
      // inside a list of another kind: step out of it, splitting it if needed
      if ($at.index() === 0) wrapAt = $at.before()
      else if ($at.index() === $at.parent.childCount) wrapAt = $at.after()
      else {
        tr.split(at)
        wrapAt = at + 1
      }
    }
    tr.insert(wrapAt, list.type.create(list.attrs, run))
    itemPos = wrapAt + 1
    const steps = tr.steps.length
    joinLists(tr, wrapAt + run.size + 2)
    joinLists(tr, wrapAt)
    itemPos = tr.mapping.slice(steps).map(itemPos)
  }
  // lists of the same kind that now meet where the run's list was
  if (whole) {
    const steps = tr.steps.length
    joinLists(tr, tr.mapping.slice(afterDelete).map(gap, -1))
    itemPos = tr.mapping.slice(steps).map(itemPos)
  }

  restoreSelection(state, tr, from, itemPos, run)
  return tr.scrollIntoView()
}

/** Join two same-kind lists that meet at `pos`. */
function joinLists(tr: Transaction, pos: number) {
  if (pos <= 0 || pos >= tr.doc.content.size) return
  const $pos = tr.doc.resolve(pos)
  const before = $pos.nodeBefore
  const after = $pos.nodeAfter
  if (before && after && isList(before) && before.type === after.type) tr.join(pos)
}

/** The position (in the original doc) the run moves to. */
function findTarget(doc: PMNode, listPos: number, first: number, last: number, dir: -1 | 1): number | null {
  const list = doc.nodeAt(listPos)!
  const $list = doc.resolve(listPos)
  const childPos = (parentPos: number, parent: PMNode, index: number) => {
    let pos = parentPos + 1
    for (let i = 0; i < index; i++) pos += parent.child(i).nodeSize
    return pos
  }

  // the item the run passes: its sibling, or the nearest item of a neighbouring list
  let item: { pos: number; node: PMNode } | null = null
  if (dir === -1 && first > 0) {
    const pos = childPos(listPos, list, first - 1)
    item = { pos, node: list.child(first - 1) }
  } else if (dir === 1 && last < list.childCount - 1) {
    const pos = childPos(listPos, list, last + 1)
    item = { pos, node: list.child(last + 1) }
  } else {
    const index = $list.index()
    const container = $list.parent
    const neighbourIndex = index + dir
    const neighbour = neighbourIndex >= 0 && neighbourIndex < container.childCount ? container.child(neighbourIndex) : null
    if (neighbour && isList(neighbour) && neighbour.childCount > 0) {
      const nPos = dir === -1 ? listPos - neighbour.nodeSize : listPos + list.nodeSize
      const i = dir === -1 ? neighbour.childCount - 1 : 0
      item = { pos: childPos(nPos, neighbour, i), node: neighbour.child(i) }
    } else if (isItem(container)) {
      // first/last child: lift out above/below the parent item
      return dir === -1 ? $list.before() : $list.after()
    } else if (neighbour) {
      // a plain block: the items leave the list and swap with it
      const lead = neighbourIndex === 0 && neighbour.isTextblock && container.type.name !== 'blockquote' && container.type.name !== 'doc'
      if (lead && dir === -1) return null
      return dir === -1 ? listPos - neighbour.nodeSize : listPos + list.nodeSize + neighbour.nodeSize
    } else {
      return null
    }
  }

  // passing an item with children goes into them; otherwise just past the item
  const node = item.node
  if (dir === -1) {
    const sub = node.lastChild
    if (node.childCount > 1 && isList(sub) && sub!.childCount > 0) return item.pos + node.nodeSize - 2
    return item.pos
  }
  const sub = node.childCount > 1 ? node.child(1) : null
  if (sub && isList(sub)) return item.pos + 1 + node.child(0).nodeSize + 1
  return item.pos + node.nodeSize
}

function restoreSelection(state: EditorState, tr: Transaction, from: number, itemPos: number, run: Fragment) {
  const sel = state.selection
  if (sel instanceof BlockRangeSelection) {
    const next = BlockRangeSelection.create(tr.doc, itemPos, itemPos + run.size - run.lastChild!.nodeSize)
    if (next) tr.setSelection(next)
  } else if (sel instanceof NodeSelection) {
    tr.setSelection(NodeSelection.create(tr.doc, itemPos))
  } else {
    const clamp = (p: number) => Math.max(0, Math.min(p, tr.doc.content.size))
    const anchor = clamp(itemPos + sel.anchor - from)
    const head = clamp(itemPos + sel.head - from)
    tr.setSelection(TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(head)))
  }
}
