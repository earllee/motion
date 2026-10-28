import type { Node as PMNode, Schema, ResolvedPos } from '@tiptap/pm/model'
import { Fragment } from '@tiptap/pm/model'
import { EditorState, NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/**
 * "Blocks" are what Notion lets you hover, drag and turn into something else:
 * top-level nodes, list/to-do items, and children of quotes/callouts/toggles.
 * The lead paragraph of a container (item, toggle, callout, quote) stands for the
 * container itself.
 */
export interface BlockInfo {
  pos: number
  node: PMNode
  depth: number
}

export const CONTAINERS = new Set(['listItem', 'taskItem', 'toggle', 'callout', 'blockquote'])
const LISTS = new Set(['bulletList', 'orderedList', 'taskList'])
const TABLE_PARTS = new Set(['tableRow', 'tableCell', 'tableHeader'])

export function isList(node: PMNode | null | undefined): boolean {
  return !!node && LISTS.has(node.type.name)
}

export function blockAtResolved($pos: ResolvedPos): BlockInfo | null {
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d)
    const parent = $pos.node(d - 1)
    if (TABLE_PARTS.has(node.type.name) || TABLE_PARTS.has(parent.type.name)) continue
    if (LISTS.has(node.type.name)) continue
    if (node.isTextblock && CONTAINERS.has(parent.type.name) && $pos.index(d - 1) === 0) continue
    return { pos: $pos.before(d), node, depth: d }
  }
  if ($pos.depth === 0) {
    const after = $pos.nodeAfter
    if (after) return { pos: $pos.pos, node: after, depth: 1 }
  }
  return null
}

export function blockAt(doc: PMNode, pos: number): BlockInfo | null {
  return blockAtResolved(doc.resolve(Math.max(0, Math.min(pos, doc.content.size))))
}

/** The block the selection is in (or the selected block for a NodeSelection). */
export function currentBlock(state: EditorState): BlockInfo | null {
  const sel = state.selection
  if (sel instanceof NodeSelection) {
    const $pos = state.doc.resolve(sel.from)
    return { pos: sel.from, node: sel.node, depth: $pos.depth + 1 }
  }
  return blockAtResolved(sel.$from)
}

/** Lead textblock of a block: itself, or the first paragraph of a container. */
export function leadText(node: PMNode): PMNode | null {
  if (node.isTextblock) return node
  if (CONTAINERS.has(node.type.name) && node.firstChild?.isTextblock) return node.firstChild
  return null
}

export type BlockKind =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'toggle'
  | 'blockquote'
  | 'callout'
  | 'codeBlock'

export function kindOf(node: PMNode, parent?: PMNode | null): BlockKind | null {
  switch (node.type.name) {
    case 'paragraph':
      return 'paragraph'
    case 'heading':
      return node.attrs.level === 1 ? 'h1' : node.attrs.level === 2 ? 'h2' : 'h3'
    case 'listItem':
      return parent?.type.name === 'orderedList' ? 'orderedList' : 'bulletList'
    case 'taskItem':
      return 'taskList'
    case 'toggle':
    case 'blockquote':
    case 'callout':
    case 'codeBlock':
      return node.type.name as BlockKind
    default:
      return null
  }
}

function inlineOf(node: PMNode, schema: Schema): Fragment {
  const lead = leadText(node)
  if (!lead) return Fragment.empty
  if (lead.type.name === 'codeBlock') return lead.textContent ? Fragment.from(schema.text(lead.textContent)) : Fragment.empty
  return lead.content
}

function restOf(node: PMNode): PMNode[] {
  if (node.isTextblock || !CONTAINERS.has(node.type.name)) return []
  const out: PMNode[] = []
  node.forEach((c, _o, i) => {
    if (i > 0 || !c.isTextblock) out.push(c)
  })
  return out
}

function stripMarks(frag: Fragment, schema: Schema): Fragment {
  const text = frag.textBetween(0, frag.size, '\n', '\n')
  return text ? Fragment.from(schema.text(text)) : Fragment.empty
}

function build(kind: BlockKind, inline: Fragment, rest: PMNode[], schema: Schema, attrs: Record<string, unknown> = {}): PMNode[] {
  const n = schema.nodes
  const p = n.paragraph.create(null, inline)
  switch (kind) {
    case 'paragraph':
      return [p, ...rest]
    case 'h1':
    case 'h2':
    case 'h3':
      return [n.heading.create({ level: Number(kind[1]) }, inline), ...rest]
    case 'codeBlock':
      return [n.codeBlock.create({ language: null, ...attrs }, stripMarks(inline, schema)), ...rest]
    case 'blockquote':
      return [n.blockquote.create(null, [p, ...rest])]
    case 'callout':
      return [n.callout.create({ kind: 'note', ...attrs }, [p, ...rest])]
    case 'toggle':
      return [n.toggle.create(null, [p, ...rest])]
    case 'bulletList':
      return [n.bulletList.create(null, n.listItem.create(null, [p, ...rest]))]
    case 'orderedList':
      return [n.orderedList.create(null, n.listItem.create(null, [p, ...rest]))]
    case 'taskList':
      return [n.taskList.create(null, n.taskItem.create({ checked: false }, [p, ...rest]))]
  }
}

function itemFor(kind: BlockKind, inline: Fragment, rest: PMNode[], schema: Schema, checked = false): PMNode {
  const p = schema.nodes.paragraph.create(null, inline)
  return kind === 'taskList'
    ? schema.nodes.taskItem.create({ checked }, [p, ...rest])
    : schema.nodes.listItem.create(null, [p, ...rest])
}

const listTypeFor = (kind: BlockKind) =>
  kind === 'bulletList' || kind === 'orderedList' || kind === 'taskList' ? kind : null

/**
 * Turn the block at `info` into `kind`, keeping its text and children. List items are
 * converted individually: the surrounding list is split around them.
 */
export function turnInto(
  state: EditorState,
  info: BlockInfo,
  kind: BlockKind,
  attrs: Record<string, unknown> = {}
): Transaction | null {
  const { schema, doc } = state
  const { node, pos } = info
  const tr = state.tr
  const inline = inlineOf(node, schema)
  const rest = restOf(node)
  // where the caret should land: offset into the lead text
  const sel = state.selection
  const lead = leadText(node)
  let caretOffset = inline.size
  if (lead && sel.empty) {
    const leadStart = lead === node ? pos + 1 : pos + 2
    caretOffset = Math.max(0, Math.min(inline.size, sel.from - leadStart))
  }

  const isItem = node.type.name === 'listItem' || node.type.name === 'taskItem'
  if (isItem) {
    const $pos = doc.resolve(pos)
    const list = $pos.parent
    const listPos = $pos.before()
    const index = $pos.index()
    const targetList = listTypeFor(kind)
    if (targetList === list.type.name) return null
    const before: PMNode[] = []
    const after: PMNode[] = []
    list.forEach((c, _o, i) => {
      if (i < index) before.push(c)
      else if (i > index) after.push(c)
    })
    const pieces: PMNode[] = []
    if (before.length) pieces.push(list.type.create(list.attrs, before))
    let replacement: PMNode[]
    if (targetList) {
      const checked = node.type.name === 'taskItem' ? node.attrs.checked : false
      replacement = [schema.nodes[targetList].create(null, itemFor(kind, inline, rest, schema, checked))]
    } else {
      replacement = build(kind, inline, rest, schema, attrs)
    }
    pieces.push(...replacement)
    if (after.length) pieces.push(list.type.create(list.attrs, after))
    tr.replaceWith(listPos, listPos + list.nodeSize, pieces)
    const startOfReplacement = listPos + (before.length ? pieces[0].nodeSize : 0)
    placeCaret(tr, startOfReplacement, caretOffset)
    joinAdjacentLists(tr, startOfReplacement)
    return tr
  }

  const current = kindOf(node)
  if (current === kind && !Object.keys(attrs).length) return null
  const replacement = build(kind, inline, rest, schema, attrs)
  tr.replaceWith(pos, pos + node.nodeSize, replacement)
  placeCaret(tr, pos, caretOffset)
  if (listTypeFor(kind)) joinAdjacentLists(tr, pos)
  return tr
}

/** Put the caret `offset` characters into the first textblock at or after `pos`. */
export function placeCaret(tr: Transaction, pos: number, offset = 0) {
  let target = -1
  tr.doc.nodesBetween(pos, tr.doc.content.size, (n, p) => {
    if (target >= 0) return false
    if (n.isTextblock) {
      target = p + 1 + Math.min(offset, n.content.size)
      return false
    }
    return true
  })
  if (target >= 0) tr.setSelection(TextSelection.create(tr.doc, target))
}

/** Merge a list at `pos` with same-type lists right before/after it (Notion has no list boundaries). */
export function joinAdjacentLists(tr: Transaction, pos: number) {
  const $pos = tr.doc.resolve(pos)
  const parent = $pos.parent
  const index = $pos.index()
  const node = parent.maybeChild(index)
  if (!node || !isList(node)) return
  const next = parent.maybeChild(index + 1)
  if (next && next.type === node.type) {
    const at = pos + node.nodeSize
    if (canJoinAt(tr, at)) tr.join(at)
  }
  const prev = parent.maybeChild(index - 1)
  if (prev && prev.type === node.type && canJoinAt(tr, pos)) tr.join(pos)
}

function canJoinAt(tr: Transaction, pos: number): boolean {
  const $pos = tr.doc.resolve(pos)
  const a = $pos.nodeBefore
  const b = $pos.nodeAfter
  return !!a && !!b && a.type === b.type && a.canAppend(b)
}

export function duplicateBlock(state: EditorState, info: BlockInfo): Transaction {
  const tr = state.tr
  const end = info.pos + info.node.nodeSize
  tr.insert(end, info.node.copy(info.node.content))
  const sel = state.selection
  if (sel instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, end))
  else placeCaret(tr, end, sel.$from.parentOffset)
  return tr
}

export function deleteBlock(state: EditorState, info: BlockInfo): Transaction {
  const tr = state.tr
  const $pos = state.doc.resolve(info.pos)
  const parent = $pos.parent
  // deleting the only item of a list/container removes the wrapper too
  if (parent.childCount === 1 && $pos.depth > 0) {
    return deleteBlock(state, { pos: $pos.before(), node: parent, depth: $pos.depth })
  }
  tr.delete(info.pos, info.pos + info.node.nodeSize)
  if (tr.doc.content.size === 0) tr.insert(0, state.schema.nodes.paragraph.create())
  const near = Math.min(info.pos, tr.doc.content.size)
  tr.setSelection(TextSelection.near(tr.doc.resolve(near), -1))
  return tr
}

/** Swap a block with its previous/next sibling. */
export function moveBlock(state: EditorState, info: BlockInfo, dir: -1 | 1): Transaction | null {
  const $pos = state.doc.resolve(info.pos)
  const parent = $pos.parent
  const index = $pos.index()
  const otherIndex = index + dir
  if (otherIndex < 0 || otherIndex >= parent.childCount) return null
  // never move a container's lead paragraph out of place
  if (CONTAINERS.has(parent.type.name) && (otherIndex === 0 || index === 0) && parent.type.name !== 'blockquote')
    if (parent.child(0).isTextblock) return null
  const other = parent.child(otherIndex)
  const tr = state.tr
  const selOffset = state.selection.from - info.pos
  const isNodeSel = state.selection instanceof NodeSelection
  if (dir === -1) {
    const otherPos = info.pos - other.nodeSize
    tr.replaceWith(otherPos, info.pos + info.node.nodeSize, [info.node, other])
    restoreSelection(tr, otherPos, selOffset, isNodeSel)
  } else {
    const end = info.pos + info.node.nodeSize
    tr.replaceWith(info.pos, end + other.nodeSize, [other, info.node])
    restoreSelection(tr, info.pos + other.nodeSize, selOffset, isNodeSel)
  }
  return tr.scrollIntoView()
}

function restoreSelection(tr: Transaction, blockPos: number, offset: number, nodeSel: boolean) {
  if (nodeSel) tr.setSelection(NodeSelection.create(tr.doc, blockPos))
  else tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(blockPos + offset, tr.doc.content.size))))
}

/** Insert an empty paragraph after a block and put the caret in it. */
export function insertParagraphAfter(state: EditorState, info: BlockInfo, text = ''): Transaction {
  const tr = state.tr
  const { schema } = state
  // after a list item, the new block is a sibling item (Notion keeps you in the list)
  if (info.node.type.name === 'listItem' || info.node.type.name === 'taskItem') {
    const item =
      info.node.type.name === 'taskItem'
        ? schema.nodes.taskItem.create({ checked: false }, schema.nodes.paragraph.create(null, text ? schema.text(text) : null))
        : schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, text ? schema.text(text) : null))
    const at = info.pos + info.node.nodeSize
    tr.insert(at, item)
    tr.setSelection(TextSelection.create(tr.doc, at + 2 + text.length))
    return tr
  }
  const at = info.pos + info.node.nodeSize
  tr.insert(at, schema.nodes.paragraph.create(null, text ? schema.text(text) : null))
  tr.setSelection(TextSelection.create(tr.doc, at + 1 + text.length))
  return tr
}

export function selectBlock(view: EditorView, pos: number) {
  const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos))
  view.dispatch(tr)
}

/**
 * Typing `[] ` (or `[ ] `/`[x] `) at the start of a bullet or numbered item turns that
 * item into a to-do. `from`–`to` is the typed marker, which is dropped. Extends `tr`
 * (an input rule's transaction) and returns false if the marker isn't in such an item.
 */
export function itemToTodo(tr: Transaction, from: number, to: number, checked = false): boolean {
  if (!convertItem(tr, from, to, 'listItem', 'taskList')) return false
  const $sel = tr.selection.$from
  if (checked) tr.setNodeMarkup($sel.before($sel.depth - 1), null, { checked: true })
  return true
}

/** The inverse of `itemToTodo`: typing `- ` at the start of a to-do makes it a bullet. */
export function todoToBullet(tr: Transaction, from: number, to: number): boolean {
  return convertItem(tr, from, to, 'taskItem', 'bulletList')
}

function convertItem(tr: Transaction, from: number, to: number, itemType: string, kind: BlockKind): boolean {
  const $from = tr.doc.resolve(from)
  const d = $from.depth
  if (d < 2 || $from.parentOffset !== 0 || $from.index(d - 1) !== 0) return false
  if ($from.node(d - 1).type.name !== itemType) return false
  const pos = $from.before(d - 1)
  tr.delete(from, to)
  const state = EditorState.create({ doc: tr.doc, selection: TextSelection.create(tr.doc, from) })
  const turned = turnInto(state, { pos, node: tr.doc.nodeAt(pos)!, depth: d - 1 }, kind)!
  turned.steps.forEach((step) => tr.step(step))
  tr.setSelection(TextSelection.create(tr.doc, turned.selection.from))
  return true
}
