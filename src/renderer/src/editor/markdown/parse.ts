import MarkdownIt from 'markdown-it'
import type { Schema, Node as PMNode, Mark } from '@tiptap/pm/model'
import { splitFrontmatter } from './frontmatter'

type MarkdownItInstance = InstanceType<typeof MarkdownIt>
type Token = ReturnType<MarkdownItInstance['parse']>[number]

/**
 * What we remember about the file a doc was parsed from. Top-level nodes keep their
 * object identity across ProseMirror transactions until they're edited, so on save an
 * untouched block is written back byte-for-byte from `texts` and only edited blocks
 * are re-serialized. Keeps git diffs to what you actually changed.
 */
export interface SourceInfo {
  bom: boolean
  eol: '\n' | '\r\n'
  frontmatter: string | null
  lead: string
  trail: string
  /** top-level node → its source group (and position within a multi-node group) */
  index: WeakMap<PMNode, { idx: number; part: number }>
  texts: (string | null)[]
  /** number of nodes each group produced */
  sizes: number[]
  /** gaps[i] is the original text between block i and i+1 (null if unknown) */
  gaps: (string | null)[]
  /** body offset where group i's source starts (-1 if unknown) */
  starts: number[]
}

export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
const CALLOUT_RE = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i
const TASK_RE = /^\[([ xX])\](?:[ \t]+|$)/
const DETAILS_OPEN_RE = /^\s*<details(\s[^>]*)?>/i
const SUMMARY_RE = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i
const DETAILS_CLOSE_RE = /<\/details>/i
const BR_RE = /^<br\s*\/?>$/i

export function createMarkdownIt(): MarkdownItInstance {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false })
  // Only link real URLs — fuzzy mode turns README.md and foo.app into links.
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false })
  // Accept any URL a markdown file might contain (file paths, vscode://, etc.).
  md.validateLink = () => true
  return md
}

const sharedMd = createMarkdownIt()

interface Frame {
  type: string
  attrs: Record<string, unknown>
  children: PMNode[]
  /** for lists: per-child whether it is a task item */
  isToggle?: boolean
  tight?: boolean
  dropFirstEmpty?: boolean
  startLine?: number
}

export interface ParseResult {
  doc: PMNode
  source: SourceInfo
}

export function parseMarkdown(input: string, schema: Schema, md: MarkdownItInstance = sharedMd): ParseResult {
  let text = input
  const bom = text.charCodeAt(0) === 0xfeff
  if (bom) text = text.slice(1)
  const eol: '\n' | '\r\n' = /\r\n/.test(text) ? '\r\n' : '\n'
  text = text.replace(/\r\n?/g, '\n')

  const { frontmatter, body } = splitFrontmatter(text)
  const lines = body.split('\n')
  const tokens = md.parse(body, {})
  const conv = new Converter(schema, md)

  // Each entry is one top-level token group and the node(s) it produced. A mixed
  // task/bullet list yields several nodes from one group.
  const top: { nodes: PMNode[]; start: number; end: number }[] = []
  const root: Frame = { type: 'doc', attrs: {}, children: [] }
  conv.stack = [root]
  let groupStart = -1
  let groupEnd = -1
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.level === 0 && t.map) {
      if (groupStart < 0) groupStart = t.map[0]
      groupEnd = Math.max(groupEnd, t.map[1])
    }
    const before = root.children.length
    conv.token(tokens, i)
    if (conv.stack.length !== 1) continue
    const added = root.children.slice(before)
    if (added.length) top.push({ nodes: added, start: groupStart, end: groupEnd })
    groupStart = -1
    groupEnd = -1
  }
  conv.closeAll()
  // Nodes closed implicitly at EOF (an unterminated <details>) have no clean range.
  const tracked = new Set(top.flatMap((x) => x.nodes))
  for (const n of root.children) if (!tracked.has(n)) top.push({ nodes: [n], start: -1, end: -1 })
  const order = new Map(root.children.map((n, i) => [n, i]))
  top.sort((a, b) => order.get(a.nodes[0])! - order.get(b.nodes[0])!)

  // Non-blank text between blocks that markdown-it swallowed (link reference
  // definitions and the like) becomes a raw block so nothing is lost.
  const groups: { nodes: PMNode[]; start: number; end: number }[] = []
  let cursor = 0
  const pushGapRaw = (from: number, to: number) => {
    const chunk = lines.slice(from, to)
    if (!chunk.some((l) => l.trim() !== '')) return
    let a = 0
    let b = chunk.length
    while (a < b && chunk[a].trim() === '') a++
    while (b > a && chunk[b - 1].trim() === '') b--
    const raw = chunk.slice(a, b).join('\n')
    groups.push({
      nodes: [schema.nodes.rawBlock.create({ kind: 'markdown' }, raw ? schema.text(raw) : null)],
      start: from + a,
      end: from + b
    })
  }
  for (const item of top) {
    if (item.start >= 0 && item.start >= cursor) {
      pushGapRaw(cursor, item.start)
      let end = item.end
      while (end > item.start && (lines[end - 1] ?? '').trim() === '') end--
      groups.push({ nodes: item.nodes, start: item.start, end })
      cursor = Math.max(cursor, item.end)
    } else {
      groups.push({ nodes: item.nodes, start: -1, end: -1 })
    }
  }
  pushGapRaw(cursor, lines.length)

  const allNodes = groups.flatMap((g) => g.nodes)
  const doc =
    allNodes.length > 0
      ? schema.nodes.doc.create(null, allNodes)
      : schema.nodes.doc.create(null, schema.nodes.paragraph.create())

  const offsets: number[] = [0]
  for (let i = 0; i < lines.length; i++) offsets.push(offsets[i] + lines[i].length + 1)
  const at = (line: number) => Math.min(offsets[line] ?? body.length, body.length)
  const endAt = (line: number) => Math.max(0, Math.min((offsets[line] ?? body.length + 1) - 1, body.length))

  const index = new WeakMap<PMNode, { idx: number; part: number }>()
  const texts: (string | null)[] = []
  const sizes: number[] = []
  const gaps: (string | null)[] = []
  const starts: number[] = []
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    sizes.push(g.nodes.length)
    starts.push(g.start >= 0 ? at(g.start) : -1)
    if (g.start >= 0) {
      g.nodes.forEach((n, part) => index.set(n, { idx: i, part }))
      texts.push(body.slice(at(g.start), endAt(g.end)))
    } else texts.push(null)
    const next = groups[i + 1]
    gaps.push(next && g.start >= 0 && next.start >= 0 ? body.slice(endAt(g.end), at(next.start)) : null)
  }
  const first = groups[0]
  const last = groups[groups.length - 1]
  const lead = first && first.start >= 0 ? body.slice(0, at(first.start)) : groups.length === 0 ? body : ''
  const trail = last && last.start >= 0 ? body.slice(endAt(last.end)) : groups.length === 0 ? '' : body.endsWith('\n') ? '\n' : ''

  return { doc, source: { bom, eol, frontmatter, lead, trail, index, texts, sizes, gaps, starts } }
}

/** Is there a matching `</details>` block before the enclosing container closes? */
function hasDetailsClose(tokens: Token[], i: number): boolean {
  const level = tokens[i].level
  let depth = 0
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]
    if (t.level < level) return false
    if (t.type !== 'html_block' || t.level !== level) continue
    if (DETAILS_OPEN_RE.test(t.content) && !DETAILS_CLOSE_RE.test(t.content)) depth++
    else if (/^\s*<\/details>/i.test(t.content)) {
      if (depth === 0) return true
      depth--
    }
  }
  return false
}

class Converter {
  stack: Frame[] = []
  inHeading = false
  constructor(
    private schema: Schema,
    private md: MarkdownItInstance
  ) {}

  get top(): Frame {
    return this.stack[this.stack.length - 1]
  }

  push(type: string, attrs: Record<string, unknown> = {}, extra: Partial<Frame> = {}) {
    this.stack.push({ type, attrs, children: [], ...extra })
  }

  add(node: PMNode | null) {
    if (node) this.top.children.push(node)
  }

  /** Pop the top frame, building its node and appending it to the parent. */
  pop() {
    const f = this.stack.pop()!
    for (const n of this.build(f)) this.top.children.push(n)
  }

  /** Close frames down to (and including) the nearest frame of `type`, auto-closing toggles. */
  close(type: string) {
    while (this.stack.length > 1 && this.top.type !== type && this.top.isToggle) this.pop()
    if (this.stack.length > 1) this.pop()
  }

  closeAll() {
    while (this.stack.length > 1) this.pop()
  }

  build(f: Frame): PMNode[] {
    const { schema } = this
    const nodes = schema.nodes
    switch (f.type) {
      case 'paragraph':
      case 'heading': {
        return [nodes[f.type].create(f.attrs, f.children)]
      }
      case 'blockquote':
      case 'callout': {
        let kids = f.children
        if (f.dropFirstEmpty && kids[0]?.type.name === 'paragraph' && kids[0].content.size === 0) kids = kids.slice(1)
        if (kids.length === 0) kids = [nodes.paragraph.create()]
        return [nodes[f.type].create(f.attrs, kids)]
      }
      case 'listItem':
      case 'taskItem': {
        let kids = f.children
        if (kids.length === 0 || kids[0].type.name !== 'paragraph') kids = [nodes.paragraph.create(), ...kids]
        return [nodes[f.type].create(f.attrs, kids)]
      }
      case 'bulletList': {
        // Split runs of task items into taskLists (TipTap keeps them as separate node types).
        const out: PMNode[] = []
        let run: PMNode[] = []
        let runTask: boolean | null = null
        const flush = () => {
          if (!run.length) return
          out.push(nodes[runTask ? 'taskList' : 'bulletList'].create({ tight: f.tight !== false, marker: f.attrs.marker }, run))
          run = []
        }
        for (const item of f.children) {
          const isTask = item.type.name === 'taskItem'
          if (runTask !== null && isTask !== runTask) flush()
          runTask = isTask
          run.push(item)
        }
        flush()
        return out
      }
      case 'orderedList': {
        // task items inside ordered lists aren't modeled — demote to plain items
        const kids = f.children.map((c) =>
          c.type.name === 'taskItem' ? nodes.listItem.create(null, c.content) : c
        )
        return [nodes.orderedList.create({ ...f.attrs, tight: f.tight !== false }, kids)]
      }
      case 'table': {
        const rows = f.children.filter((r) => r.childCount > 0)
        if (!rows.length) return []
        // normalize column counts so the table is rectangular
        const width = Math.max(...rows.map((r) => r.childCount))
        const fixed = rows.map((r, ri) => {
          if (r.childCount === width) return r
          const cells: PMNode[] = []
          r.forEach((c) => cells.push(c))
          while (cells.length < width)
            cells.push(nodes[ri === 0 ? 'tableHeader' : 'tableCell'].create(null, nodes.paragraph.create()))
          return nodes.tableRow.create(null, cells)
        })
        return [nodes.table.create(null, fixed)]
      }
      case 'tableRow':
        return [nodes.tableRow.create(null, f.children)]
      case 'tableHeader':
      case 'tableCell':
        return [nodes[f.type].create(f.attrs, nodes.paragraph.create(null, f.children))]
      case 'toggle': {
        let kids = f.children
        if (kids.length === 0 || kids[0].type.name !== 'paragraph') kids = [nodes.paragraph.create(), ...kids]
        return [nodes.toggle.create(f.attrs, kids)]
      }
      default:
        return []
    }
  }

  token(tokens: Token[], i: number) {
    const t = tokens[i]
    const { schema } = this
    const nodes = schema.nodes
    switch (t.type) {
      case 'paragraph_open': {
        const parent = this.top
        if ((parent.type === 'listItem' || parent.type === 'taskItem') && !t.hidden) {
          // a visible paragraph inside an item means the list is loose
          const list = this.stack[this.stack.length - 2]
          if (list) list.tight = false
        }
        this.push('paragraph')
        return
      }
      case 'paragraph_close':
        return this.close('paragraph')
      case 'heading_open':
        this.inHeading = true
        return this.push('heading', { level: Number(t.tag.slice(1)) })
      case 'heading_close':
        this.inHeading = false
        return this.close('heading')
      case 'blockquote_open': {
        const inline = tokens[i + 2]
        if (tokens[i + 1]?.type === 'paragraph_open' && inline?.type === 'inline') {
          const m = CALLOUT_RE.exec(inline.content)
          if (m) {
            const rest = inline.content.slice(m[0].length)
            inline.children = rest ? this.parseInline(rest) : []
            inline.content = rest
            return this.push('callout', { kind: m[1].toLowerCase() }, { dropFirstEmpty: true })
          }
        }
        return this.push('blockquote')
      }
      case 'blockquote_close':
        return this.close(this.nearest(['blockquote', 'callout']))
      case 'bullet_list_open':
        return this.push('bulletList', { marker: t.markup || '-' }, { tight: true })
      case 'bullet_list_close':
        return this.close('bulletList')
      case 'ordered_list_open': {
        const start = Number(t.attrGet('start') ?? 1)
        return this.push(
          'orderedList',
          { start: Number.isFinite(start) ? start : 1, delim: t.markup === ')' ? ')' : '.' },
          { tight: true }
        )
      }
      case 'ordered_list_close':
        return this.close('orderedList')
      case 'list_item_open': {
        const inline = tokens[i + 2]
        if (this.top.type === 'bulletList' && tokens[i + 1]?.type === 'paragraph_open' && inline?.type === 'inline') {
          const m = TASK_RE.exec(inline.content)
          if (m) {
            const rest = inline.content.slice(m[0].length)
            inline.children = rest ? this.parseInline(rest) : []
            inline.content = rest
            return this.push('taskItem', { checked: m[1] !== ' ' })
          }
        }
        return this.push('listItem')
      }
      case 'list_item_close':
        return this.close(this.nearest(['listItem', 'taskItem']))
      case 'table_open':
        return this.push('table')
      case 'table_close':
        return this.close('table')
      case 'thead_open':
      case 'thead_close':
      case 'tbody_open':
      case 'tbody_close':
        return
      case 'tr_open':
        return this.push('tableRow')
      case 'tr_close':
        return this.close('tableRow')
      case 'th_open':
      case 'td_open': {
        const style = String(t.attrGet('style') || '')
        const m = /text-align:\s*(left|right|center)/.exec(style)
        return this.push(t.type === 'th_open' ? 'tableHeader' : 'tableCell', { align: m ? m[1] : null })
      }
      case 'th_close':
        return this.close('tableHeader')
      case 'td_close':
        return this.close('tableCell')
      case 'inline':
        for (const n of this.inline(t.children || [])) this.add(n)
        return
      case 'fence': {
        const info = (t.info || '').trim()
        const sp = info.search(/\s/)
        const language = sp < 0 ? info : info.slice(0, sp)
        const meta = sp < 0 ? null : info.slice(sp + 1).trim() || null
        const content = t.content.replace(/\n$/, '')
        return this.add(nodes.codeBlock.create({ language: language || null, meta }, content ? schema.text(content) : null))
      }
      case 'code_block': {
        const content = t.content.replace(/\n$/, '')
        return this.add(nodes.codeBlock.create({ language: null }, content ? schema.text(content) : null))
      }
      case 'hr':
        return this.add(nodes.horizontalRule.create())
      case 'html_block':
        return this.htmlBlock(t, tokens, i)
      default:
        return
    }
  }

  nearest(types: string[]): string {
    for (let i = this.stack.length - 1; i > 0; i--) {
      if (types.includes(this.stack[i].type)) return this.stack[i].type
    }
    return types[0]
  }

  htmlBlock(t: Token, tokens: Token[], i: number) {
    const { schema } = this
    const content = t.content.replace(/\n+$/, '')
    const open = DETAILS_OPEN_RE.exec(content)
    // only a <details> we can see the end of becomes a toggle; anything else stays raw HTML
    if (open && (DETAILS_CLOSE_RE.test(content) || hasDetailsClose(tokens, i))) {
      const isOpen = /\sopen(\s|=|$)/i.test(open[1] || '')
      let rest = content.slice(open[0].length)
      const sm = SUMMARY_RE.exec(rest)
      const summary = sm ? sm[1].trim() : ''
      if (sm) rest = rest.slice(sm[0].length)
      this.push('toggle', { open: isOpen }, { isToggle: true })
      this.add(schema.nodes.paragraph.create(null, summary ? this.inline(this.parseInline(summary)) : null))
      const close = DETAILS_CLOSE_RE.exec(rest)
      const inner = close ? rest.slice(0, close.index) : rest
      if (inner.trim()) for (const n of this.parseBlocks(inner)) this.add(n)
      if (close) {
        this.pop()
        const after = rest.slice(close.index + close[0].length).trim()
        if (after) this.add(this.raw(after))
      }
      return
    }
    if (/^\s*<\/details>/i.test(content) && this.top.isToggle) {
      this.pop()
      const after = content.replace(/^\s*<\/details>/i, '').trim()
      if (after) this.add(this.raw(after))
      return
    }
    this.add(this.raw(content))
  }

  raw(text: string): PMNode {
    return this.schema.nodes.rawBlock.create({ kind: 'html' }, text ? this.schema.text(text) : null)
  }

  parseInline(src: string): Token[] {
    const toks = this.md.parseInline(src, {})
    return toks[0]?.children || []
  }

  parseBlocks(src: string): PMNode[] {
    const toks = this.md.parse(src, {})
    const sub = new Converter(this.schema, this.md)
    const root: Frame = { type: 'doc', attrs: {}, children: [] }
    sub.stack = [root]
    for (let i = 0; i < toks.length; i++) sub.token(toks, i)
    sub.closeAll()
    return root.children
  }

  inline(children: Token[]): PMNode[] {
    const { schema } = this
    const m = schema.marks
    const out: PMNode[] = []
    let marks: readonly Mark[] = []
    const text = (s: string, ms: readonly Mark[] = marks) => {
      if (s) out.push(schema.text(s, ms))
    }
    for (const t of children) {
      switch (t.type) {
        case 'text':
          text(t.content)
          break
        case 'softbreak':
          text(this.inHeading ? ' ' : '\n')
          break
        case 'hardbreak':
          out.push(schema.nodes.hardBreak.create())
          break
        case 'strong_open':
          marks = m.bold.create().addToSet(marks)
          break
        case 'strong_close':
          marks = m.bold.removeFromSet(marks)
          break
        case 'em_open':
          marks = m.italic.create().addToSet(marks)
          break
        case 'em_close':
          marks = m.italic.removeFromSet(marks)
          break
        case 's_open':
          marks = m.strike.create().addToSet(marks)
          break
        case 's_close':
          marks = m.strike.removeFromSet(marks)
          break
        case 'code_inline':
          text(t.content, m.code.create().addToSet(marks))
          break
        case 'link_open': {
          const kind = t.markup === 'linkify' ? 'bare' : t.markup === 'autolink' ? 'angle' : null
          marks = m.link
            .create({ href: t.attrGet('href') || '', title: t.attrGet('title') || null, mdKind: kind })
            .addToSet(marks)
          break
        }
        case 'link_close':
          marks = m.link.removeFromSet(marks)
          break
        case 'image': {
          const alt = t.content || ''
          out.push(
            schema.nodes.image.create(
              { src: t.attrGet('src') || '', alt: alt || null, title: t.attrGet('title') || null },
              null,
              marks
            )
          )
          break
        }
        case 'html_inline':
          if (BR_RE.test(t.content.trim())) out.push(schema.nodes.hardBreak.create({ html: t.content }))
          else out.push(schema.nodes.htmlInline.create({ html: t.content }, null, marks))
          break
        default:
          if (t.content) text(t.content)
      }
    }
    return out
  }
}
