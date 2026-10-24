import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

interface FindState {
  query: string
  matches: { from: number; to: number }[]
  current: number
  decos: DecorationSet
}

export const findKey = new PluginKey<FindState>('find')

function search(doc: PMNode, query: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  if (!query) return out
  const q = query.toLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // map text offsets back to doc positions, skipping non-text inline nodes
    let text = ''
    const map: number[] = []
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) {
          text += child.text![i]
          map.push(pos + 1 + offset + i)
        }
      } else {
        text += '￼'
        map.push(pos + 1 + offset)
      }
    })
    const lower = text.toLowerCase()
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
      out.push({ from: map[i], to: map[i + q.length - 1] + 1 })
    }
    return false
  })
  return out
}

function build(doc: PMNode, query: string, current: number): FindState {
  const matches = search(doc, query)
  const cur = matches.length ? Math.max(0, Math.min(current, matches.length - 1)) : 0
  const decos = DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === cur ? 'find-match current' : 'find-match' }))
  )
  return { query, matches, current: cur, decos }
}

export const Find = Extension.create({
  name: 'find',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: '', matches: [], current: 0, decos: DecorationSet.empty }),
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(findKey) as { query?: string; current?: number } | undefined
            if (meta) return build(state.doc, meta.query ?? prev.query, meta.current ?? prev.current)
            if (tr.docChanged && prev.query) return build(state.doc, prev.query, prev.current)
            return prev
          }
        },
        props: {
          decorations: (state) => findKey.getState(state)?.decos
        }
      })
    ]
  }
})

export function setFindQuery(view: EditorView, query: string) {
  view.dispatch(view.state.tr.setMeta(findKey, { query, current: 0 }))
  revealCurrent(view)
}

export function findStep(view: EditorView, dir: 1 | -1) {
  const s = findKey.getState(view.state)
  if (!s || !s.matches.length) return
  const next = (s.current + dir + s.matches.length) % s.matches.length
  view.dispatch(view.state.tr.setMeta(findKey, { current: next }))
  revealCurrent(view)
}

export function findInfo(view: EditorView): { count: number; current: number } {
  const s = findKey.getState(view.state)
  return { count: s?.matches.length ?? 0, current: s?.current ?? 0 }
}

function revealCurrent(view: EditorView) {
  const s = findKey.getState(view.state)
  const m = s?.matches[s.current]
  if (!m) return
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to))
  view.dispatch(tr)
  const dom = view.domAtPos(m.from).node as HTMLElement
  const el = dom.nodeType === 3 ? dom.parentElement : dom
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
