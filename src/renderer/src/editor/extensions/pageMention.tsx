import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion, { exitSuggestion, type SuggestionProps } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import type { FileEntry } from '@shared/types'
import { createStore } from '@/store'
import { dirOf, relativePath, stemOf } from '@/api'

export interface PageItem {
  file: FileEntry
  label: string
}

export interface MentionState {
  open: boolean
  mode: 'mention' | 'wiki'
  items: PageItem[]
  active: number
  rect: DOMRect | null
  command: ((item: PageItem) => void) | null
}

export const mentionStore = createStore<MentionState>({ open: false, mode: 'mention', items: [], active: 0, rect: null, command: null })

export interface MentionOptions {
  files: () => FileEntry[]
  docPath: () => string | null
}

function rank(files: FileEntry[], query: string, docPath: string | null): PageItem[] {
  const q = query.toLowerCase().trim()
  const here = docPath ? dirOf(docPath) : ''
  const scored = files
    .filter((f) => f.path !== docPath)
    .map((f) => {
      const label = f.title || stemOf(f.path)
      const stem = stemOf(f.path).toLowerCase()
      const t = label.toLowerCase()
      let score = 0
      if (!q) score = 1 + (dirOf(f.path) === here ? 1 : 0) + f.mtime / 1e15
      else if (stem.startsWith(q) || t.startsWith(q)) score = 4
      else if (stem.includes(q) || t.includes(q)) score = 3
      else if (f.rel.toLowerCase().includes(q)) score = 2
      return { item: { file: f, label }, score }
    })
    .filter((s) => s.score > 0)
  scored.sort((a, b) => b.score - a.score || a.item.file.rel.length - b.item.file.rel.length)
  return scored.slice(0, 8).map((s) => s.item)
}

function plugin(editor: Editor, options: MentionOptions, char: string, mode: 'mention' | 'wiki', key: PluginKey) {
  return Suggestion<PageItem, PageItem>({
    editor,
    pluginKey: key,
    char,
    allowSpaces: true,
    startOfLine: false,
    allowedPrefixes: mode === 'wiki' ? null : [' ', '(', ' '],
    allow: ({ state, range }) => {
      const $from = state.doc.resolve(range.from)
      return !$from.parent.type.spec.code
    },
    items: ({ query }) => (query.length > 60 || /\]\]/.test(query) ? [] : rank(options.files(), query, options.docPath())),
    command: ({ editor, range, props }: { editor: Editor; range: Range; props: PageItem }) => {
      const doc = options.docPath()
      const { schema } = editor.state
      if (mode === 'wiki') {
        editor.chain().focus().deleteRange(range).insertContent(`[[${stemOf(props.file.path)}]] `).run()
        return
      }
      const href = doc ? relativePath(dirOf(doc), props.file.path) : props.file.path
      const text = schema.text(props.label, [schema.marks.link.create({ href })])
      const tr = editor.state.tr.replaceWith(range.from, range.to, [text, schema.text(' ')])
      editor.view.dispatch(tr)
      editor.view.focus()
    },
    render: () => {
      let latest: SuggestionProps<PageItem, PageItem> | null = null
      const sync = (props: SuggestionProps<PageItem, PageItem>) => {
        latest = props
        mentionStore.set((s) => ({
          open: props.items.length > 0,
          mode,
          items: props.items,
          active: Math.min(s.active, Math.max(0, props.items.length - 1)),
          rect: props.clientRect?.() ?? null,
          command: (item) => props.command(item)
        }))
      }
      return {
        onStart: (props) => {
          mentionStore.set((s) => ({ ...s, active: 0 }))
          sync(props)
        },
        onUpdate: sync,
        onKeyDown: ({ event }) => {
          const s = mentionStore.get()
          if (!s.open) return false
          if (event.key === 'Escape') {
            exitSuggestion(editor.view, key)
            mentionStore.set((x) => ({ ...x, open: false }))
            return true
          }
          if (event.key === 'ArrowDown') {
            mentionStore.set((x) => ({ ...x, active: (x.active + 1) % x.items.length }))
            return true
          }
          if (event.key === 'ArrowUp') {
            mentionStore.set((x) => ({ ...x, active: (x.active - 1 + x.items.length) % x.items.length }))
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
          mentionStore.set((s) => ({ ...s, open: false, command: null }))
        }
      }
    }
  })
}

/** `@` links to another page (relative markdown link); `[[` inserts a wikilink. */
export const PageMention = Extension.create<MentionOptions>({
  name: 'pageMention',
  addOptions() {
    return { files: () => [], docPath: () => null }
  },
  addProseMirrorPlugins() {
    return [
      plugin(this.editor, this.options, '@', 'mention', new PluginKey('pageMention')),
      plugin(this.editor, this.options, '[[', 'wiki', new PluginKey('wikiMention'))
    ]
  }
})
