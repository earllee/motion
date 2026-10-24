import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion, { exitSuggestion, type SuggestionProps } from '@tiptap/suggestion'
import { PluginKey, TextSelection } from '@tiptap/pm/state'
import type { ReactNode } from 'react'
import { createStore } from '@/store'
import {
  TextIcon,
  Glyph,
  BulletListIcon,
  NumberedListIcon,
  TodoIcon,
  ToggleIcon,
  QuoteIcon,
  CalloutIcon,
  DividerIcon,
  CodeBlockIcon,
  TableIcon,
  ImageIcon,
  MermaidIcon
} from '@/components/icons'
import { currentBlock, turnInto, placeCaret, type BlockKind } from '../blocks'

export interface SlashItem {
  id: string
  title: string
  section: string
  hint?: string
  keywords: string[]
  icon: ReactNode
  run: (editor: Editor) => void
}

export interface SlashState {
  open: boolean
  items: SlashItem[]
  active: number
  rect: DOMRect | null
  query: string
  command: ((item: SlashItem) => void) | null
}

export const slashKey = new PluginKey('slash')

export const slashStore = createStore<SlashState>({
  open: false,
  items: [],
  active: 0,
  rect: null,
  query: '',
  command: null
})

/** Hook for the host app (image picking needs the file path / dialogs). */
export const slashHooks: { pickImage: ((editor: Editor) => void) | null } = { pickImage: null }

/**
 * Apply a block kind the Notion way: an empty block is converted in place, a block
 * with text gets a new block of that kind inserted below.
 */
export function applyKind(editor: Editor, kind: BlockKind, attrs: Record<string, unknown> = {}) {
  const { state, view } = editor
  const info = currentBlock(state)
  if (!info) return
  const lead = info.node.isTextblock ? info.node : info.node.firstChild
  const empty = !!lead && lead.isTextblock && lead.content.size === 0
  if (empty || info.node.type.name === 'paragraph' && info.node.content.size === 0) {
    const tr = turnInto(state, info, kind, attrs)
    if (tr) view.dispatch(tr.scrollIntoView())
    else if (Object.keys(attrs).length) view.dispatch(state.tr.setNodeMarkup(info.pos, undefined, { ...info.node.attrs, ...attrs }))
    return
  }
  // insert an empty paragraph after, then convert it
  const at = info.pos + info.node.nodeSize
  const tr = state.tr.insert(at, state.schema.nodes.paragraph.create())
  tr.setSelection(TextSelection.create(tr.doc, at + 1))
  view.dispatch(tr)
  const next = currentBlock(editor.state)
  if (!next) return
  const tr2 = turnInto(editor.state, next, kind, attrs)
  if (tr2) view.dispatch(tr2.scrollIntoView())
}

/** Insert a leaf block (divider, table) at the caret's block, Notion-style. */
export function insertLeaf(editor: Editor, make: () => import('@tiptap/pm/model').Node) {
  const { state, view } = editor
  const info = currentBlock(state)
  if (!info) return
  const node = make()
  const isEmptyPara = info.node.type.name === 'paragraph' && info.node.content.size === 0
  const tr = state.tr
  let at: number
  if (isEmptyPara) {
    tr.replaceWith(info.pos, info.pos + info.node.nodeSize, node)
    at = info.pos + node.nodeSize
  } else {
    at = info.pos + info.node.nodeSize
    tr.insert(at, node)
    at += node.nodeSize
  }
  // always leave a paragraph after so typing continues
  const after = tr.doc.resolve(at).nodeAfter
  if (node.type.name === 'horizontalRule' && !(after && after.type.name === 'paragraph' && after.content.size === 0)) {
    tr.insert(at, state.schema.nodes.paragraph.create())
  }
  if (node.type.name === 'table') placeCaret(tr, at - node.nodeSize, 0)
  else placeCaret(tr, at, 0)
  view.dispatch(tr.scrollIntoView())
}

export function makeTable(editor: Editor, rows = 3, cols = 3) {
  const { schema } = editor.state
  const cell = (header: boolean) => schema.nodes[header ? 'tableHeader' : 'tableCell'].create(null, schema.nodes.paragraph.create())
  const rowNodes = Array.from({ length: rows }, (_, r) =>
    schema.nodes.tableRow.create(null, Array.from({ length: cols }, () => cell(r === 0)))
  )
  return schema.nodes.table.create(null, rowNodes)
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', title: 'Text', section: 'Basic blocks', keywords: ['paragraph', 'plain'], icon: <TextIcon size={18} />, run: (e) => applyKind(e, 'paragraph') },
  { id: 'h1', title: 'Heading 1', section: 'Basic blocks', hint: '#', keywords: ['title', 'big', 'h1'], icon: <Glyph text="H1" size={20} />, run: (e) => applyKind(e, 'h1') },
  { id: 'h2', title: 'Heading 2', section: 'Basic blocks', hint: '##', keywords: ['subtitle', 'medium', 'h2'], icon: <Glyph text="H2" size={20} />, run: (e) => applyKind(e, 'h2') },
  { id: 'h3', title: 'Heading 3', section: 'Basic blocks', hint: '###', keywords: ['small', 'h3'], icon: <Glyph text="H3" size={20} />, run: (e) => applyKind(e, 'h3') },
  { id: 'bullet', title: 'Bulleted list', section: 'Basic blocks', hint: '-', keywords: ['unordered', 'ul', 'bullets'], icon: <BulletListIcon size={18} />, run: (e) => applyKind(e, 'bulletList') },
  { id: 'numbered', title: 'Numbered list', section: 'Basic blocks', hint: '1.', keywords: ['ordered', 'ol', 'numbers'], icon: <NumberedListIcon size={18} />, run: (e) => applyKind(e, 'orderedList') },
  { id: 'todo', title: 'To-do list', section: 'Basic blocks', hint: '[]', keywords: ['todo', 'task', 'checkbox', 'check'], icon: <TodoIcon size={18} />, run: (e) => applyKind(e, 'taskList') },
  { id: 'toggle', title: 'Toggle list', section: 'Basic blocks', hint: '>>', keywords: ['collapse', 'details', 'expand'], icon: <ToggleIcon size={16} />, run: (e) => applyKind(e, 'toggle') },
  { id: 'quote', title: 'Quote', section: 'Basic blocks', hint: '"', keywords: ['blockquote', 'citation'], icon: <QuoteIcon size={18} />, run: (e) => applyKind(e, 'blockquote') },
  { id: 'callout', title: 'Callout', section: 'Basic blocks', keywords: ['note', 'alert', 'admonition', 'info', 'warning', 'tip'], icon: <CalloutIcon size={18} />, run: (e) => applyKind(e, 'callout', { kind: 'note' }) },
  { id: 'divider', title: 'Divider', section: 'Basic blocks', hint: '---', keywords: ['hr', 'line', 'separator', 'rule'], icon: <DividerIcon size={18} />, run: (e) => insertLeaf(e, () => e.schema.nodes.horizontalRule.create()) },
  { id: 'code', title: 'Code', section: 'Basic blocks', hint: '```', keywords: ['codeblock', 'snippet', 'pre'], icon: <CodeBlockIcon size={18} />, run: (e) => applyKind(e, 'codeBlock') },
  { id: 'table', title: 'Table', section: 'Basic blocks', keywords: ['grid', 'rows', 'columns'], icon: <TableIcon size={18} />, run: (e) => insertLeaf(e, () => makeTable(e)) },
  { id: 'image', title: 'Image', section: 'Media', keywords: ['picture', 'photo', 'png', 'jpg', 'screenshot'], icon: <ImageIcon size={18} />, run: (e) => slashHooks.pickImage?.(e) },
  { id: 'mermaid', title: 'Mermaid diagram', section: 'Advanced', keywords: ['diagram', 'flowchart', 'chart', 'graph', 'sequence'], icon: <MermaidIcon size={18} />, run: (e) => applyKind(e, 'codeBlock', { language: 'mermaid' }) },
  { id: 'warning', title: 'Warning callout', section: 'Advanced', keywords: ['caution', 'alert', 'danger'], icon: <span style={{ fontSize: 15 }}>⚠️</span>, run: (e) => applyKind(e, 'callout', { kind: 'warning' }) },
  { id: 'tip', title: 'Tip callout', section: 'Advanced', keywords: ['hint', 'success'], icon: <span style={{ fontSize: 15 }}>✅</span>, run: (e) => applyKind(e, 'callout', { kind: 'tip' }) }
]

export function filterSlash(query: string): SlashItem[] {
  const q = query.toLowerCase().trim()
  if (!q) return SLASH_ITEMS
  const scored = SLASH_ITEMS.map((item) => {
    const title = item.title.toLowerCase()
    let score = 0
    if (title.startsWith(q)) score = 3
    else if (title.split(/\s+/).some((w) => w.startsWith(q))) score = 2
    else if (item.keywords.some((k) => k.startsWith(q)) || item.hint === q) score = 1
    else if (title.includes(q) || item.keywords.some((k) => k.includes(q))) score = 0.5
    return { item, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item)
}

export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      Suggestion<SlashItem, SlashItem>({
        editor,
        pluginKey: slashKey,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.parent.type.spec.code) return false
          for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.spec.tableRole) return false
          return true
        },
        items: ({ query }) => filterSlash(query),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
          editor.chain().focus().deleteRange(range).run()
          props.run(editor)
        },
        render: () => {
          let latest: SuggestionProps<SlashItem, SlashItem> | null = null
          const sync = (props: SuggestionProps<SlashItem, SlashItem>, reset = false) => {
            latest = props
            slashStore.set((s) => ({
              open: true,
              items: props.items,
              active: reset ? 0 : Math.min(s.active, Math.max(0, props.items.length - 1)),
              rect: props.clientRect?.() ?? null,
              query: props.query,
              command: (item) => props.command(item)
            }))
          }
          return {
            onStart: (props) => sync(props, true),
            onUpdate: (props) => sync(props, props.query !== slashStore.get().query),
            onKeyDown: ({ event }) => {
              const s = slashStore.get()
              if (!s.open) return false
              if (event.key === 'Escape') {
                exitSuggestion(editor.view, slashKey)
                slashStore.set((x) => ({ ...x, open: false }))
                return true
              }
              if (!s.items.length) return false
              if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
                slashStore.set((x) => ({ ...x, active: (x.active + 1) % x.items.length }))
                return true
              }
              if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
                slashStore.set((x) => ({ ...x, active: (x.active - 1 + x.items.length) % x.items.length }))
                return true
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                const item = s.items[s.active]
                if (item && latest) latest.command(item)
                return true
              }
              return false
            },
            onExit: () => {
              latest = null
              slashStore.set((s) => ({ ...s, open: false, command: null }))
            }
          }
        }
      })
    ]
  }
})
