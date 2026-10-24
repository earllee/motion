import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

function textFor(node: PMNode, parent: PMNode | null, index: number, pos: number, hasAnchor: boolean): string {
  if (node.type.name === 'heading') {
    if (pos === 0 && node.attrs.level === 1) return 'Untitled'
    return `Heading ${node.attrs.level}`
  }
  if (node.type.name !== 'paragraph') return ''
  switch (parent?.type.name) {
    case 'listItem':
      return index === 0 && hasAnchor ? 'List' : ''
    case 'taskItem':
      return index === 0 ? 'To-do' : ''
    case 'toggle':
      return index === 0 ? 'Toggle' : ''
    case 'blockquote':
      return hasAnchor ? 'Empty quote' : ''
    case 'callout':
      return hasAnchor ? 'Type something…' : ''
    case 'tableCell':
    case 'tableHeader':
      return ''
    default:
      return hasAnchor ? "Type '/' for commands" : ''
  }
}

/** Notion's per-block placeholders, computed from the current state on every render. */
export const Placeholders = Extension.create({
  name: 'placeholders',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('placeholders'),
        props: {
          decorations(state) {
            const { anchor } = state.selection
            const decos: Decoration[] = []
            state.doc.descendants((node, pos, parent, index) => {
              if (!node.isTextblock) return true
              if (node.content.size > 0 || node.type.spec.code) return false
              const hasAnchor = anchor >= pos && anchor <= pos + node.nodeSize
              const text = textFor(node, parent, index, pos, hasAnchor)
              if (text) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'is-empty', 'data-placeholder': text }))
              return false
            })
            return DecorationSet.create(state.doc, decos)
          }
        }
      })
    ]
  }
})
