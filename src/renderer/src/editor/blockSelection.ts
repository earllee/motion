import { Selection, SelectionRange, TextSelection, NodeSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import type { Mappable } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'
import { blockAtResolved, CONTAINERS, currentBlock, turnInto, type BlockKind } from './blocks'

/**
 * Notion's multi-block selection: a run of sibling blocks, highlighted blue, with no
 * text caret. `anchorBlock`/`headBlock` are the positions just before the first and
 * last blocks of the run (head moves with ⇧↑/⇧↓).
 */
export class BlockRangeSelection extends Selection {
  readonly anchorBlock: number
  readonly headBlock: number

  constructor(doc: PMNode, anchorBlock: number, headBlock: number) {
    const a = doc.nodeAt(anchorBlock)!
    const h = doc.nodeAt(headBlock)!
    const from = Math.min(anchorBlock, headBlock)
    const to = Math.max(anchorBlock + a.nodeSize, headBlock + h.nodeSize)
    const $from = doc.resolve(from)
    const $to = doc.resolve(to)
    super($from, $to, [new SelectionRange($from, $to)])
    this.anchorBlock = anchorBlock
    this.headBlock = headBlock
  }

  /** null unless both positions sit right before blocks in the same parent */
  static create(doc: PMNode, anchorBlock: number, headBlock: number): BlockRangeSelection | null {
    if (anchorBlock < 0 || headBlock < 0 || anchorBlock > doc.content.size || headBlock > doc.content.size) return null
    const a = doc.nodeAt(anchorBlock)
    const h = doc.nodeAt(headBlock)
    if (!a || !h || !a.isBlock || !h.isBlock) return null
    const $a = doc.resolve(anchorBlock)
    const $h = doc.resolve(headBlock)
    if ($a.depth !== $h.depth || $a.start() !== $h.start()) return null
    return new BlockRangeSelection(doc, anchorBlock, headBlock)
  }

  map(doc: PMNode, mapping: Mappable): Selection {
    const a = mapping.mapResult(this.anchorBlock, 1)
    const h = mapping.mapResult(this.headBlock, 1)
    const sel = !a.deleted && !h.deleted ? BlockRangeSelection.create(doc, a.pos, h.pos) : null
    return sel ?? TextSelection.near(doc.resolve(Math.min(mapping.map(this.from), doc.content.size)))
  }

  eq(other: Selection): boolean {
    return other instanceof BlockRangeSelection && other.anchorBlock === this.anchorBlock && other.headBlock === this.headBlock
  }

  replace(tr: Transaction, content: Slice = Slice.empty) {
    if (content.size === 0) deleteBlockRange(tr, this.from, this.to)
    else super.replace(tr, content)
  }

  toJSON() {
    return { type: 'blockRange', anchor: this.anchorBlock, head: this.headBlock }
  }

  static fromJSON(doc: PMNode, json: { anchor: number; head: number }) {
    return BlockRangeSelection.create(doc, json.anchor, json.head) ?? Selection.atStart(doc)
  }

  getBookmark() {
    return new BlockRangeBookmark(this.anchorBlock, this.headBlock)
  }

  /** the selected sibling blocks, in document order */
  blocks(): { pos: number; node: PMNode }[] {
    const out: { pos: number; node: PMNode }[] = []
    const parent = this.$from.parent
    const start = this.$from.start()
    parent.forEach((node, offset) => {
      const pos = start + offset
      if (pos >= this.from && pos + node.nodeSize <= this.to) out.push({ pos, node })
    })
    return out
  }
}

BlockRangeSelection.prototype.visible = false
Selection.jsonID('blockRange', BlockRangeSelection)

class BlockRangeBookmark {
  constructor(
    readonly anchor: number,
    readonly head: number
  ) {}
  map(mapping: Mappable) {
    return new BlockRangeBookmark(mapping.map(this.anchor, 1), mapping.map(this.head, 1))
  }
  resolve(doc: PMNode) {
    return BlockRangeSelection.create(doc, this.anchor, this.head) ?? TextSelection.near(doc.resolve(Math.min(this.anchor, doc.content.size)))
  }
}

/** Delete a run of sibling blocks; an emptied list/quote/toggle goes too. */
export function deleteBlockRange(tr: Transaction, from: number, to: number) {
  let $from = tr.doc.resolve(from)
  let $to = tr.doc.resolve(to)
  while ($from.depth > 0 && from === $from.start() && to === $to.end()) {
    // the run is the whole parent's content: remove the parent instead
    from = $from.before()
    to = $to.after()
    $from = tr.doc.resolve(from)
    $to = tr.doc.resolve(to)
  }
  tr.delete(from, to)
  if (tr.doc.content.size === 0) tr.insert(0, tr.doc.type.schema.nodes.paragraph.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), -1))
}

const TABLE_PARTS = new Set(['table', 'tableRow', 'tableCell', 'tableHeader'])

/**
 * Esc on a text selection: select every block it touches. Blocks are lifted to a
 * common parent, so a selection from a paragraph into a nested list item selects
 * the whole item.
 */
export function selectBlocksForText(state: EditorState): Selection | null {
  const { doc, selection } = state
  const a = blockAtResolved(selection.$from)
  const b = blockAtResolved(selection.$to)
  if (!a || !b) return null
  if (a.pos === b.pos) return NodeSelection.create(doc, a.pos)
  const $a = doc.resolve(a.pos)
  const $b = doc.resolve(b.pos)
  let depth = $a.sharedDepth(b.pos)
  // never split a table: treat it as one block
  for (let d = 1; d <= depth; d++) {
    if (TABLE_PARTS.has($a.node(d).type.name)) {
      depth = d - 1
      break
    }
  }
  const unit = ($p: typeof $a, pos: number) => ($p.depth === depth ? pos : $p.before(depth + 1))
  const ua = unit($a, a.pos)
  const ub = unit($b, b.pos)
  const shared = depth > 0 ? $a.node(depth) : doc
  // the lead line of an item/toggle/callout stands for the whole container
  if (depth > 0 && CONTAINERS.has(shared.type.name) && ua === $a.start(depth) && shared.firstChild?.isTextblock) {
    return NodeSelection.create(doc, $a.before(depth))
  }
  if (ua === ub) return NodeSelection.create(doc, ua)
  const backwards = selection.anchor > selection.head
  return BlockRangeSelection.create(doc, backwards ? ub : ua, backwards ? ua : ub)
}

/** Blocks the current selection acts on: a block range, a selected block, or none. */
export function selectedBlocks(state: EditorState): { pos: number; node: PMNode }[] | null {
  const sel = state.selection
  if (sel instanceof BlockRangeSelection) return sel.blocks()
  if (sel instanceof NodeSelection && sel.node.isBlock) return [{ pos: sel.from, node: sel.node }]
  return null
}

/** ⇧↑/⇧↓: grow or shrink the run by one sibling at the head. */
export function extendBlockSelection(state: EditorState, dir: -1 | 1): Selection | null {
  const sel = state.selection
  let anchor: number
  let head: number
  if (sel instanceof BlockRangeSelection) {
    anchor = sel.anchorBlock
    head = sel.headBlock
  } else if (sel instanceof NodeSelection && sel.node.isBlock) {
    anchor = head = sel.from
  } else return null
  const $head = state.doc.resolve(head)
  const index = $head.index()
  const parent = $head.parent
  const nextIndex = index + dir
  if (nextIndex < 0 || nextIndex >= parent.childCount) return sel
  let pos = $head.start()
  for (let i = 0; i < nextIndex; i++) pos += parent.child(i).nodeSize
  // never pull a container's lead line into a run on its own
  if (CONTAINERS.has(parent.type.name) && nextIndex === 0 && parent.firstChild?.isTextblock) return sel
  if (pos === anchor) return NodeSelection.create(state.doc, anchor)
  return BlockRangeSelection.create(state.doc, anchor, pos) ?? sel
}

/** Copy of the selected blocks inserted right after them, then selected. */
export function duplicateBlockRange(state: EditorState, sel: BlockRangeSelection): Transaction {
  const nodes = sel.blocks().map((b) => b.node)
  const tr = state.tr.insert(sel.to, Fragment.fromArray(nodes))
  const size = nodes.reduce((n, b) => n + b.nodeSize, 0)
  const last = sel.to + size - nodes[nodes.length - 1].nodeSize
  const next = BlockRangeSelection.create(tr.doc, sel.to, last)
  if (next) tr.setSelection(next)
  return tr
}

/** Swap the whole run with the sibling above/below it. */
export function moveBlockRange(state: EditorState, sel: BlockRangeSelection, dir: -1 | 1): Transaction | null {
  const $from = state.doc.resolve(sel.from)
  const parent = $from.parent
  const first = $from.index()
  const count = sel.blocks().length
  const otherIndex = dir === -1 ? first - 1 : first + count
  if (otherIndex < 0 || otherIndex >= parent.childCount) return null
  if (CONTAINERS.has(parent.type.name) && otherIndex === 0 && parent.firstChild?.isTextblock) return null
  const other = parent.child(otherIndex)
  const run = Fragment.fromArray(sel.blocks().map((b) => b.node))
  const tr = state.tr
  if (dir === -1) {
    const start = sel.from - other.nodeSize
    tr.replaceWith(start, sel.to, run.append(Fragment.from(other)))
    const lastPos = start + run.size - run.lastChild!.nodeSize
    const next = BlockRangeSelection.create(tr.doc, start, lastPos)
    if (next) tr.setSelection(next)
  } else {
    tr.replaceWith(sel.from, sel.to + other.nodeSize, Fragment.from(other).append(run))
    const start = sel.from + other.nodeSize
    const next = BlockRangeSelection.create(tr.doc, start, start + run.size - run.lastChild!.nodeSize)
    if (next) tr.setSelection(next)
  }
  return tr.scrollIntoView()
}

const LISTS = new Set(['bulletList', 'orderedList', 'taskList'])

/**
 * Turn every block the selection touches into `kind`: a block selection, a text
 * selection across blocks, or just the caret's block. Lists count as their items,
 * so a run of bullets becomes a run of numbered items, never one empty item.
 */
export function turnSelection(view: EditorView, kind: BlockKind, attrs: Record<string, unknown> = {}): boolean {
  const state = view.state
  const sel = state.selection
  let range: Selection | null = sel instanceof BlockRangeSelection || (sel instanceof NodeSelection && sel.node.isBlock) ? sel : null
  if (!range && !sel.empty && !sel.$from.sameParent(sel.$to)) range = selectBlocksForText(state)
  const blocks = range instanceof BlockRangeSelection ? range.blocks() : range instanceof NodeSelection ? [{ pos: range.from, node: range.node }] : null
  if (!blocks) {
    const info = currentBlock(state)
    const tr = info && turnInto(state, info, kind, attrs)
    if (tr) view.dispatch(tr.scrollIntoView())
    return !!info
  }
  const targets: number[] = []
  for (const b of blocks) {
    if (LISTS.has(b.node.type.name)) b.node.forEach((_item, offset) => targets.push(b.pos + 1 + offset))
    else targets.push(b.pos)
  }
  // last first, so earlier positions stay valid; remember the mapping to restore the selection
  const maps: Transaction['mapping'][] = []
  for (const pos of targets.reverse()) {
    const s = view.state
    const node = s.doc.nodeAt(pos)
    if (!node) continue
    const tr = turnInto(s, { pos, node, depth: s.doc.resolve(pos).depth + 1 }, kind, attrs)
    if (!tr) continue
    maps.push(tr.mapping)
    view.dispatch(tr)
  }
  const map = (p: number, bias: number) => maps.reduce((acc, m) => m.map(acc, bias), p)
  const s = view.state
  const from = Math.min(map(sel.from, 1), s.doc.content.size)
  const to = Math.min(map(sel.to, -1), s.doc.content.size)
  if (sel instanceof TextSelection) {
    view.dispatch(s.tr.setSelection(TextSelection.between(s.doc.resolve(from), s.doc.resolve(to))).scrollIntoView())
  } else {
    const text = s.apply(s.tr.setSelection(TextSelection.between(s.doc.resolve(from), s.doc.resolve(to))))
    const again = selectBlocksForText(text)
    if (again) view.dispatch(s.tr.setSelection(again).scrollIntoView())
  }
  return true
}
