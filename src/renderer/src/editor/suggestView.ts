import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMSerializer, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { diff, plainMd, type Change, type Review } from './review'

/** Holds the suggestion marks; PageView recomputes them and dispatches them as meta. */
export const suggestKey = new PluginKey<DecorationSet>('suggestions')

export function suggestPlugin() {
  return new Plugin<DecorationSet>({
    key: suggestKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const next = tr.getMeta(suggestKey) as DecorationSet | undefined
        return next ?? set.map(tr.mapping, tr.doc)
      }
    },
    props: {
      decorations: (state) => suggestKey.getState(state)
    }
  })
}

/** What one suggestion does, for its card: "Add", "Delete" or "Replace … with …". */
export interface Suggestion {
  added: string
  removed: string
  /** the frontmatter changed */
  props?: boolean
}

/** A textblock's text, with each inline non-text node as one placeholder char, and the doc position of every char. */
function chars(node: PMNode, pos: number): { text: string; at: number[] } {
  let text = ''
  const at: number[] = []
  node.forEach((child, offset) => {
    if (child.isText) {
      for (let k = 0; k < child.text!.length; k++) at.push(pos + 1 + offset + k)
      text += child.text
    } else {
      at.push(pos + 1 + offset)
      text += '￼'
    }
  })
  at.push(pos + 1 + node.content.size)
  return { text, at }
}

/** Node range of segments [a, b), ignoring the frontmatter segment. */
function nodeRange(segs: Review['cur']['segs'], a: number, b: number): [number, number] | null {
  const real = segs.slice(a, b).filter((s) => s.from >= 0)
  return real.length ? [real[0].from, real[real.length - 1].to] : null
}

const textOf = (doc: PMNode, range: [number, number] | null) => {
  if (!range) return ''
  const out: string[] = []
  for (let k = range[0]; k < range[1]; k++) out.push(doc.child(k).textContent)
  return out.filter(Boolean).join(' ')
}

/** Short content hash, so a widget is redrawn when what it shows changes. */
const hash = (t: string) => {
  let h = 0
  for (let k = 0; k < t.length; k++) h = (h * 31 + t.charCodeAt(k)) | 0
  return (h >>> 0).toString(36)
}

/**
 * Doc position for each offset of a block's markdown source: walk the source against the
 * block's text, skipping syntax (markers, link targets) that doesn't show.
 */
function sourceMap(src: string, node: PMNode, pos: number): number[] {
  const { text, at } = chars(node, pos)
  const map: number[] = []
  let j = 0
  for (let i = 0; i < src.length; i++) {
    // an inline node (image, hard break) is one placeholder; step over it at the next real char
    while (text[j] === '\ufffc' && src[i] === text[j + 1]) j++
    map.push(at[j])
    if (j < text.length && src[i] === text[j]) j++
  }
  map.push(at[j])
  return map
}

/**
 * Notion-style suggestion marks for the open page: added text in blue, deleted text
 * greyed out and struck through, inline where it was. Edits inside a paragraph or
 * heading are marked word by word, and a list marks just the items that changed.
 * `set` is null if the parsed text doesn't line up with the editor's nodes (mid-edit).
 */
export function suggestionMarks(doc: PMNode, r: Review, changes: Change[], schema: Schema): { set: DecorationSet | null; items: Suggestion[] } {
  const items: Suggestion[] = changes.map((ch) => {
    const h = r.hunks[ch.hunk]
    if (ch.word) {
      const bt = r.base.segs[h.b0].text
      const ct = r.cur.segs[h.c0].text
      return { added: plainMd(ct.slice(...ch.word.c)).trim(), removed: plainMd(bt.slice(...ch.word.b)).trim() }
    }
    return {
      added: textOf(r.cur.doc, nodeRange(r.cur.segs, h.c0, h.c1)),
      removed: textOf(r.base.doc, nodeRange(r.base.segs, h.b0, h.b1)),
      props: h.b0 === 0 || h.c0 === 0
    }
  })
  if (r.cur.doc.childCount !== doc.childCount) return { set: null, items }
  const pos: number[] = []
  doc.forEach((_, offset) => pos.push(offset))
  pos.push(doc.content.size)
  const decos: Decoration[] = []
  const serializer = DOMSerializer.fromSchema(schema)
  const attrs = (i: number, cls: string) => ({ class: cls, 'data-change': String(i) })
  const deleted = (i: number, at: number, nodes: PMNode[], key: string) =>
    decos.push(
      Decoration.widget(
        at,
        () => {
          const box = document.createElement('div')
          box.className = 'suggest-del-block'
          box.contentEditable = 'false'
          box.dataset.change = String(i)
          for (const n of nodes) box.append(serializer.serializeNode(n))
          return box
        },
        { side: -1, key, ignoreSelection: true, stopEvent: () => true }
      )
    )

  changes.forEach((ch, i) => {
    const h = r.hunks[ch.hunk]
    if (ch.word) {
      const cs = r.cur.segs[h.c0]
      const map = sourceMap(cs.text, doc.child(cs.from), pos[cs.from])
      const from = map[ch.word.c[0]]
      const to = map[ch.word.c[1]]
      if (to > from) decos.push(Decoration.inline(from, to, attrs(i, 'suggest-ins')))
      const gone = items[i].removed
      if (gone)
        decos.push(
          Decoration.widget(
            from,
            () => {
              const span = document.createElement('span')
              span.className = 'suggest-del'
              span.dataset.change = String(i)
              span.textContent = gone
              return span
            },
            { side: -1, key: `del-${i}-${hash(gone)}`, marks: [] }
          )
        )
      return
    }

    const cur = nodeRange(r.cur.segs, h.c0, h.c1)
    const base = nodeRange(r.base.segs, h.b0, h.b1)
    const next = r.cur.segs.slice(h.c1).find((s) => s.from >= 0)
    const anchor = cur ? pos[cur[0]] : next ? pos[next.from] : doc.content.size
    if (cur && base && !items[i].props && cur[1] - cur[0] === 1 && base[1] - base[0] === 1) {
      const node = doc.child(cur[0])
      const old = r.base.doc.child(base[0])
      // one list (or other container) changed in place: just the items that differ
      if (!node.isTextblock && node.type === old.type && node.childCount && old.childCount) {
        const kids = (x: PMNode) => Array.from({ length: x.childCount }, (_, k) => JSON.stringify(x.child(k).toJSON()))
        const parts = diff(kids(old), kids(node))
        if (node.childCount > parts.reduce((t, p) => t + p.c1 - p.c0, 0)) {
          const at: number[] = []
          node.forEach((_, offset) => at.push(pos[cur[0]] + 1 + offset))
          at.push(pos[cur[0]] + node.nodeSize - 1)
          const added: string[] = []
          const removed: string[] = []
          parts.forEach((p, n) => {
            const gone = Array.from({ length: p.b1 - p.b0 }, (_, k) => old.child(p.b0 + k))
            if (gone.length) deleted(i, at[p.c0], gone, `delitem-${i}-${n}-${hash(kids(old).slice(p.b0, p.b1).join())}`)
            removed.push(...gone.map((g) => g.textContent))
            for (let k = p.c0; k < p.c1; k++) {
              decos.push(Decoration.node(at[k], at[k + 1], attrs(i, 'suggest-ins-node')))
              added.push(node.child(k).textContent)
            }
          })
          items[i] = { added: added.filter(Boolean).join(' '), removed: removed.filter(Boolean).join(' ') }
          return
        }
      }
    }
    if (base) {
      const nodes = Array.from({ length: base[1] - base[0] }, (_, k) => r.base.doc.child(base[0] + k))
      deleted(i, anchor, nodes, `delblock-${i}-${hash(r.base.segs.slice(h.b0, h.b1).map((x) => x.key).join('\n'))}`)
    }
    if (cur) for (let k = cur[0]; k < cur[1]; k++) decos.push(Decoration.node(pos[k], pos[k + 1], attrs(i, 'suggest-ins-node')))
  })
  return { set: DecorationSet.create(doc, decos), items }
}
