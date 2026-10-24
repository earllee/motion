import { Extension, getMarkRange } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { createStore } from '@/store'

export interface LinkHover {
  href: string
  rect: DOMRect
  from: number
  to: number
}

export const linkHoverStore = createStore<LinkHover | null>(null)
export const wikiKey = new PluginKey<DecorationSet>('wikilinks')

const WIKI_RE = /\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/g

export interface LinkOptions {
  openLink: (href: string, event: MouseEvent) => void
  openWiki: (name: string, event: MouseEvent) => void
  resolveWiki: (name: string) => string | null
}

function wikiDecorations(doc: PMNode, resolve: (name: string) => string | null, caret = -1): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos, parent) => {
    if (!node.isText) return !node.type.spec.code
    if (parent?.type.spec.code || node.marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) return false
    const text = node.text!
    WIKI_RE.lastIndex = 0
    for (let m = WIKI_RE.exec(text); m; m = WIKI_RE.exec(text)) {
      const start = pos + m.index
      const end = start + m[0].length
      const name = m[1].trim()
      const found = resolve(name)
      // brackets fold away unless the caret is inside the link (so it stays editable)
      const editing = caret >= start && caret <= end
      const bracket = `wikilink-bracket${editing ? '' : ' folded'}`
      decos.push(Decoration.inline(start, start + 2, { class: bracket }))
      decos.push(
        Decoration.inline(start + 2, end - 2, {
          class: `wikilink${found ? '' : ' missing'}`,
          'data-wikilink': name,
          title: found ? found : `No page named “${name}”`
        })
      )
      decos.push(Decoration.inline(end - 2, end, { class: bracket }))
    }
    return false
  })
  return DecorationSet.create(doc, decos)
}

/** Click-to-open links, `[[wikilinks]]` to other pages, and the link hover card. */
export const Links = Extension.create<LinkOptions>({
  name: 'motionLinks',

  addOptions() {
    return {
      openLink: () => {},
      openWiki: () => {},
      resolveWiki: () => null
    }
  },

  addProseMirrorPlugins() {
    const options = this.options
    const key = wikiKey
    let hoverTimer: ReturnType<typeof setTimeout> | null = null
    let hideTimer: ReturnType<typeof setTimeout> | null = null

    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_c, state) => wikiDecorations(state.doc, options.resolveWiki, state.selection.head),
          apply: (tr, old, _o, state) =>
            tr.docChanged || tr.selectionSet || tr.getMeta(key)
              ? wikiDecorations(state.doc, options.resolveWiki, state.selection.head)
              : old.map(tr.mapping, tr.doc)
        },
        props: {
          decorations: (state) => key.getState(state),
          handleClick: (view, _pos, event) => {
            const target = event.target as HTMLElement
            if (event.button !== 0 || event.shiftKey) return false
            // don't hijack clicks that end a text selection
            if (!view.state.selection.empty) return false
            const wiki = target.closest<HTMLElement>('[data-wikilink]')
            if (wiki) {
              options.openWiki(wiki.dataset.wikilink!, event)
              return true
            }
            const a = target.closest<HTMLAnchorElement>('a[href]')
            if (a && view.dom.contains(a)) {
              event.preventDefault()
              options.openLink(a.getAttribute('href') || '', event)
              return true
            }
            return false
          },
          handleDOMEvents: {
            mouseover: (view, event) => {
              const a = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
              if (!a || !view.dom.contains(a)) return false
              if (hideTimer) clearTimeout(hideTimer)
              if (hoverTimer) clearTimeout(hoverTimer)
              hoverTimer = setTimeout(() => {
                const pos = view.posAtDOM(a, 0)
                const $pos = view.state.doc.resolve(pos)
                const range = getMarkRange($pos, view.state.schema.marks.link)
                if (!range) return
                linkHoverStore.set({
                  href: a.getAttribute('href') || '',
                  rect: a.getBoundingClientRect(),
                  from: range.from,
                  to: range.to
                })
              }, 450)
              return false
            },
            mouseout: (view, event) => {
              const a = (event.target as HTMLElement).closest('a[href]')
              if (!a || !view.dom.contains(a)) return false
              if (hoverTimer) clearTimeout(hoverTimer)
              hideTimer = setTimeout(() => {
                if (!document.querySelector('.link-hover:hover')) linkHoverStore.set(null)
              }, 300)
              return false
            },
            keydown: () => {
              if (hoverTimer) clearTimeout(hoverTimer)
              if (linkHoverStore.get()) linkHoverStore.set(null)
              return false
            }
          }
        }
      })
    ]
  }
})

/** Force wikilink decorations to recompute (e.g. after the file index changes). */
export function refreshWikilinks(view: import('@tiptap/pm/view').EditorView) {
  view.dispatch(view.state.tr.setMeta(wikiKey, true))
}
