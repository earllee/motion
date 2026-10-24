import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { parseMarkdown } from '../markdown/parse'
import { serializeFragment, serializeInline } from '../markdown/serialize'

/** Markdown for a copied slice; inline text when the copy is inside one block. */
export function sliceToMarkdown(slice: Slice): string {
  let content = slice.content
  let openStart = slice.openStart
  let openEnd = slice.openEnd
  // drill into wrappers to find a single block of text, but keep lists (their items need markers)
  const LIST = new Set(['bulletList', 'orderedList', 'taskList'])
  while (content.childCount === 1 && openStart > 0 && openEnd > 0 && !content.firstChild!.isTextblock && !LIST.has(content.firstChild!.type.name)) {
    content = content.firstChild!.content
    openStart--
    openEnd--
  }
  if (content.childCount === 1 && content.firstChild!.isTextblock && openStart > 0 && openEnd > 0) {
    const tb = content.firstChild!
    if (tb.type.name === 'codeBlock') return tb.textContent
    return serializeInline(tb.type.schema.nodes.paragraph.create(null, tb.content), {})
  }
  const nodes: PMNode[] = []
  content.forEach((n) => nodes.push(n))
  return serializeFragment(nodes)
}

/** Parse pasted plain text as markdown. */
export function markdownToSlice(text: string, view: EditorView): Slice {
  const { doc } = parseMarkdown(text, view.state.schema)
  const content = doc.content
  if (content.childCount === 1 && content.firstChild!.type.name === 'paragraph') {
    return new Slice(content, 1, 1)
  }
  return new Slice(content, 0, 0)
}

const looksLikeCodeEditorHtml = (html: string) =>
  /<meta[^>]*charset|vscode|font-family:\s*(Menlo|Monaco|'SF Mono'|Consolas|monospace)/i.test(html) &&
  !/<(h[1-6]|ul|ol|table|blockquote)\b/i.test(html)

const looksLikeMarkdown = (text: string) =>
  /(^|\n)(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\|.*\|)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)/.test(text)

/** Split spreadsheet TSV into rows of cells; quoted cells may hold tabs, newlines and "" escapes. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  const src = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' && cell === '') {
      let j = i + 1
      let quoted = ''
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') { quoted += '"'; j += 2 }
        else if (src[j] === '"') { j++; break }
        else quoted += src[j++]
      }
      // only a real quoted cell if it ends at a cell boundary
      if (j >= src.length || src[j] === '\t' || src[j] === '\n') { cell = quoted; i = j; continue }
    }
    if (ch === '\t') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += ch
    i++
  }
  row.push(cell)
  rows.push(row)
  return rows
}

/** GFM table for cells copied from Numbers, Excel or Sheets; null when the text isn't a grid. */
export function tsvToMarkdown(text: string, html = ''): string | null {
  if (!text.includes('\t')) return null
  let rows = parseTsv(text).map((r) => r.map((c) => c.trim()))
  rows = rows.filter((r) => r.some((c) => c))
  const width = Math.max(0, ...rows.map((r) => r.length))
  const fromSheet = /<table\b/i.test(html)
  // without table HTML, only a consistent grid counts (tab-indented code doesn't)
  if (rows.length < 2 || width < 2 || (!fromSheet && rows.some((r) => r.length !== width))) return null
  const keep = Array.from({ length: width }, (_, ci) => rows.some((r) => r[ci]))
  const cell = (c = '') => c.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
  const line = (r: string[]) => '| ' + keep.flatMap((k, ci) => (k ? [cell(r[ci])] : [])).join(' | ') + ' |'
  const cols = keep.filter(Boolean).length
  return [line(rows[0]), '| ' + Array(cols).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n')
}

export const MarkdownClipboard = Extension.create<{ onImage?: (file: File) => Promise<string | null> }>({
  name: 'markdownClipboard',

  addOptions() {
    return { onImage: undefined }
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin({
        key: new PluginKey('markdownClipboard'),
        props: {
          clipboardTextSerializer: (slice) => sliceToMarkdown(slice),
          clipboardTextParser: (text, $context, plain, view) => {
            if ($context.parent.type.spec.code || plain) {
              return new Slice(Fragment.from(view.state.schema.text(text.replace(/\r\n?/g, '\n'))), 0, 0)
            }
            return markdownToSlice(text, view)
          },
          handlePaste: (view, event) => {
            const data = event.clipboardData
            if (!data) return false
            const inCode = !!view.state.selection.$from.parent.type.spec.code
            // spreadsheets also put a picture of the cells on the clipboard; the cells win
            const table = inCode ? null : tsvToMarkdown(data.getData('text/plain'), data.getData('text/html'))
            if (table) {
              event.preventDefault()
              view.dispatch(view.state.tr.replaceSelection(markdownToSlice(table, view)).scrollIntoView())
              return true
            }
            // images → saved next to the doc under assets/
            const files = Array.from(data.files || []).filter((f) => f.type.startsWith('image/') && f.size > 0)
            if (files.length && options.onImage) {
              event.preventDefault()
              void insertImages(view, files, options.onImage)
              return true
            }
            const $from = view.state.selection.$from
            if ($from.parent.type.spec.code) {
              const text = data.getData('text/plain')
              if (!text) return false
              view.dispatch(view.state.tr.insertText(text.replace(/\r\n?/g, '\n')).scrollIntoView())
              return true
            }
            const html = data.getData('text/html')
            const text = data.getData('text/plain')
            // Code editors and terminals put styled HTML on the clipboard; the plain
            // text is the real markdown.
            if (text && (!html || (looksLikeCodeEditorHtml(html) && looksLikeMarkdown(text)))) {
              event.preventDefault()
              const slice = markdownToSlice(text, view)
              view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
              return true
            }
            return false
          },
          handleDrop: (view, event) => {
            const files = Array.from(event.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/') && f.size > 0)
            if (!files.length || !options.onImage) return false
            event.preventDefault()
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
            void insertImages(view, files, options.onImage, pos?.pos)
            return true
          }
        }
      })
    ]
  }
})

async function insertImages(view: EditorView, files: File[], save: (f: File) => Promise<string | null>, at?: number) {
  for (const file of files) {
    const src = await save(file)
    if (!src) continue
    const { schema } = view.state
    const img = schema.nodes.image.create({ src, alt: file.name.replace(/\.[^.]+$/, '') })
    const para = schema.nodes.paragraph.create(null, img)
    const tr = view.state.tr
    if (at !== undefined) {
      const $pos = tr.doc.resolve(at)
      const insertAt = $pos.depth > 0 ? $pos.after(1) : at
      tr.insert(insertAt, para)
      at = insertAt + para.nodeSize
    } else {
      const { $from } = tr.selection
      if ($from.parent.type.name === 'paragraph' && $from.parent.content.size === 0) tr.replaceSelectionWith(img)
      else tr.insert($from.after(1), para)
    }
    view.dispatch(tr.scrollIntoView())
  }
}
