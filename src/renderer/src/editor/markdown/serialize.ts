import type { Node as PMNode, Mark } from '@tiptap/pm/model'
import type { SourceInfo } from './parse'

/**
 * ProseMirror doc → markdown. Untouched top-level blocks are copied verbatim from the
 * source (see SourceInfo); everything else goes through the serializer below, which
 * aims for the GitHub-flavored style Claude Code writes: `-` bullets, `**bold**`,
 * `*italic*`, fenced code, pipe tables, `> [!NOTE]` callouts, `<details>` toggles.
 */
export function serializeMarkdown(
  doc: PMNode,
  source?: SourceInfo | null,
  frontmatter: string | null = source?.frontmatter ?? null
): string {
  const children: PMNode[] = []
  doc.forEach((n) => children.push(n))
  const items: { node: PMNode; last: PMNode; text: string; idx: number | undefined }[] = []
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    const hit = source?.index.get(node)
    if (hit && hit.part === 0 && source!.texts[hit.idx] != null) {
      // the whole group must be intact, in order, to reuse its text
      const size = source!.sizes[hit.idx]
      let ok = true
      for (let p = 1; p < size; p++) {
        const h = children[i + p] && source!.index.get(children[i + p])
        if (!h || h.idx !== hit.idx || h.part !== p) ok = false
      }
      if (ok) {
        items.push({ node, last: children[i + size - 1], text: source!.texts[hit.idx]!, idx: hit.idx })
        i += size - 1
        continue
      }
    }
    const prev = items.length ? items[items.length - 1].last : null
    const text = serializeBlock(node, prev)
    if (text !== null) items.push({ node, last: node, text, idx: undefined })
  }

  // Two lists that weren't adjacent in the source (a block between them was deleted)
  // would merge into one; re-serialize the second so its marker alternates.
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]
    const it = items[i]
    const adjacentInSource = prev.idx !== undefined && it.idx === prev.idx + 1
    if (it.idx !== undefined && !adjacentInSource && wouldMerge(prev.last, it.node)) {
      const text = serializeBlock(it.node, prev.last)
      if (text !== null) items[i] = { ...it, text, idx: undefined }
    }
  }
  // A leading `---` could be mistaken for frontmatter; `***` is the same rule.
  if (!frontmatter && items.length && items[0].idx === undefined && items[0].node.type.name === 'horizontalRule') {
    items[0] = { ...items[0], text: '***' }
  }

  let body = ''
  if (items.length) {
    body += items[0].idx === 0 && source ? source.lead : ''
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (i > 0) {
        const prev = items[i - 1]
        const gap =
          source && prev.idx !== undefined && it.idx === prev.idx + 1 ? source.gaps[prev.idx] : null
        body += gap ?? blockSeparator(prev.last, it.node)
      }
      body += it.text
    }
    const last = items[items.length - 1]
    if (source && last.idx !== undefined && last.idx === source.texts.length - 1) body += source.trail
    // keep a missing final newline only if the original file had content without one
    else body += source && source.trail === '' && source.texts.length > 0 ? '' : '\n'
  }

  if (!items.length && source && source.texts.length === 0) body = source.lead

  let out = (frontmatter ?? '') + body
  if (source?.eol === '\r\n') out = out.replace(/\n/g, '\r\n')
  if (source?.bom) out = '\ufeff' + out
  return out
}

/** Serialize a slice of blocks (used for copy-as-markdown). */
export function serializeFragment(nodes: PMNode[]): string {
  const parts: { node: PMNode; text: string }[] = []
  for (const n of nodes) {
    const prev = parts.length ? parts[parts.length - 1].node : null
    const text = serializeBlock(n, prev)
    if (text !== null) parts.push({ node: n, text })
  }
  let out = ''
  parts.forEach((p, i) => {
    if (i > 0) out += blockSeparator(parts[i - 1].node, p.node)
    out += p.text
  })
  return out
}

const BULLETISH = new Set(['bulletList', 'taskList'])

function wouldMerge(a: PMNode, b: PMNode): boolean {
  if (BULLETISH.has(a.type.name) && BULLETISH.has(b.type.name)) return (a.attrs.marker || '-') === (b.attrs.marker || '-')
  if (a.type.name === 'orderedList' && b.type.name === 'orderedList') return (a.attrs.delim || '.') === (b.attrs.delim || '.')
  return false
}

function blockSeparator(a: PMNode, b: PMNode): string {
  // Adjacent tight lists stay tight; serializeList alternates markers when they must stay separate.
  const lists = BULLETISH.has(a.type.name) && BULLETISH.has(b.type.name)
  const ordered = a.type.name === 'orderedList' && b.type.name === 'orderedList'
  if ((lists || ordered) && a.attrs.tight && b.attrs.tight) return '\n'
  return '\n\n'
}

const CONTINUES_TIGHT = new Set([
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'blockquote',
  'callout',
  'horizontalRule',
  'rawBlock',
  'table',
  'toggle',
  'heading'
])

function serializeChildren(parent: PMNode, from = 0): string {
  const parts: { node: PMNode; text: string }[] = []
  parent.forEach((child, _off, i) => {
    if (i < from) return
    const text = serializeBlock(child, parts.length ? parts[parts.length - 1].node : null)
    if (text !== null) parts.push({ node: child, text })
  })
  let out = ''
  parts.forEach((p, i) => {
    if (i > 0) out += blockSeparator(parts[i - 1].node, p.node)
    out += p.text
  })
  return out
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, i) => (line === '' ? (i === 0 ? first.trimEnd() : rest.trimEnd()) : (i === 0 ? first : rest) + line))
    .join('\n')
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l === '' ? '>' : '> ' + l))
    .join('\n')
}

export function serializeBlock(node: PMNode, prev: PMNode | null = null): string | null {
  switch (node.type.name) {
    case 'paragraph': {
      const s = serializeInline(node, {})
      return s === '' ? null : s
    }
    case 'heading': {
      // an empty heading is just a Notion placeholder; markdown has nothing to say
      let s = serializeInline(node, { noNewlines: true })
      // a trailing ` ##` would be read as the closing sequence
      s = s.replace(/(^|[ \t])(#+)$/, '$1\\$2')
      return s ? '#'.repeat(node.attrs.level || 1) + ' ' + s : null
    }
    case 'blockquote':
      return quote(serializeChildren(node) || '')
    case 'callout': {
      const kind = String(node.attrs.kind || 'note').toUpperCase()
      const inner = serializeChildren(node)
      return quote(`[!${kind}]` + (inner ? '\n' + inner : ''))
    }
    case 'bulletList':
    case 'taskList':
    case 'orderedList':
      return serializeList(node, prev)
    case 'codeBlock': {
      const content = node.textContent
      let longest = 0
      for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
      const fence = '`'.repeat(Math.max(3, longest + 1))
      const info = [node.attrs.language, node.attrs.meta].filter(Boolean).join(' ')
      return `${fence}${info}\n${content}${content ? '\n' : ''}${fence}`
    }
    case 'horizontalRule':
      return '---'
    case 'rawBlock': {
      const t = node.textContent
      return t === '' ? null : t
    }
    case 'table':
      return serializeTable(node)
    case 'toggle': {
      const summary = node.firstChild ? serializeInline(node.firstChild, { noNewlines: true }) : ''
      const inner = serializeChildren(node, 1)
      const open = node.attrs.open ? ' open' : ''
      return `<details${open}>\n<summary>${summary}</summary>\n` + (inner ? `\n${inner}\n\n` : '') + '</details>'
    }
    case 'image':
    case 'hardBreak':
    case 'text':
      return serializeInline(node.type.schema.nodes.paragraph.create(null, node), {})
    default:
      return node.textContent || null
  }
}

function bulletMarker(list: PMNode): string {
  return (list.attrs.marker as string) || '-'
}

function serializeList(list: PMNode, prev: PMNode | null): string {
  const tight = list.attrs.tight !== false
  const ordered = list.type.name === 'orderedList'
  const start = ordered ? Number(list.attrs.start ?? 1) : 1
  // Two adjacent lists of the same type only stay separate if their markers differ.
  let bullet = bulletMarker(list)
  if (!ordered && prev && prev.type === list.type && bulletMarker(prev) === bullet) bullet = bullet === '-' ? '*' : '-'
  let delim = (list.attrs.delim as string) || '.'
  if (ordered && prev && prev.type === list.type && ((prev.attrs.delim as string) || '.') === delim)
    delim = delim === '.' ? ')' : '.'
  const out: string[] = []
  list.forEach((item, _off, i) => {
    let marker: string
    let indent: string
    if (ordered) {
      marker = `${start + i}${delim} `
      indent = ' '.repeat(marker.length)
    } else {
      marker = item.type.name === 'taskItem' ? `${bullet} [${item.attrs.checked ? 'x' : ' '}] ` : `${bullet} `
      indent = '  '
    }
    out.push(prefixLines(serializeItemBody(item, tight), marker, indent))
  })
  return out.join(tight ? '\n' : '\n\n')
}

function serializeItemBody(item: PMNode, tight: boolean): string {
  const first = item.firstChild
  const isTask = item.type.name === 'taskItem'
  let out = first && first.type.name === 'paragraph' ? serializeInline(first, { listItemStart: !isTask }) : ''
  const startIdx = first && first.type.name === 'paragraph' ? 1 : 0
  let prev: PMNode | null = first && startIdx === 1 ? first : null
  item.forEach((child, _off, i) => {
    if (i < startIdx) return
    const text = serializeBlock(child, prev && prev !== first ? prev : null)
    if (text === null) return
    if (prev) {
      if (prev === first && tight && CONTINUES_TIGHT.has(child.type.name)) out += '\n'
      // a fence delimits itself, so a tight item keeps it flush with its neighbors
      else if (tight && (child.type.name === 'codeBlock' || prev.type.name === 'codeBlock')) out += '\n'
      else out += blockSeparator(prev, child)
    }
    out += text
    prev = child
  })
  return out
}

function serializeTable(table: PMNode): string {
  const rows: string[][] = []
  const aligns: (string | null)[] = []
  table.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell, _o, ci) => {
      const p = cell.firstChild
      cells.push(p ? serializeInline(p, { inTable: true, noNewlines: true }) : '')
      if (aligns[ci] === undefined || aligns[ci] === null) aligns[ci] = cell.attrs.align ?? null
    })
    rows.push(cells)
  })
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const line = (cells: string[]) => {
    const full = [...cells]
    while (full.length < width) full.push('')
    return ('| ' + full.join(' | ') + ' |').replace(/\|  \|/g, '|  |')
  }
  const delim =
    '| ' +
    Array.from({ length: width }, (_, i) => {
      const a = aligns[i]
      return a === 'left' ? ':---' : a === 'right' ? '---:' : a === 'center' ? ':---:' : '---'
    }).join(' | ') +
    ' |'
  return [line(rows[0]), delim, ...rows.slice(1).map(line)].join('\n')
}

// ---------------------------------------------------------------------------
// Inline

interface InlineCtx {
  inTable?: boolean
  noNewlines?: boolean
  /** the paragraph opens a list item: escape a leading `[ ]` so it doesn't become a task */
  listItemStart?: boolean
}

type Run =
  | { kind: 'text'; text: string; marks: readonly Mark[] }
  | { kind: 'code'; text: string; marks: readonly Mark[] }
  | { kind: 'raw'; text: string; marks: readonly Mark[] }
  | { kind: 'node'; node: PMNode; marks: readonly Mark[] }

const EMPHASIS = new Set(['bold', 'italic', 'strike'])

function hasMark(marks: readonly Mark[], m: Mark): boolean {
  return marks.some((x) => x.eq(m))
}

function buildRuns(parent: PMNode): Run[] {
  const raw: Run[] = []
  parent.forEach((child) => {
    if (child.isText) {
      const code = child.marks.some((m) => m.type.name === 'code')
      const marks = child.marks.filter((m) => m.type.name !== 'code')
      raw.push({ kind: code ? 'code' : 'text', text: child.text!, marks })
    } else raw.push({ kind: 'node', node: child, marks: child.marks })
  })

  // Bare/angle autolinks whose text is the URL go back out as-is.
  const runs: Run[] = []
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]
    const link = r.marks.find((m) => m.type.name === 'link')
    const autoish = link && link.attrs.mdKind == null && !link.attrs.title && /^https?:\/\/\S+$/.test(String(link.attrs.href))
    if (link && (link.attrs.mdKind === 'bare' || link.attrs.mdKind === 'angle' || autoish)) {
      let j = i
      let text = ''
      let simple = true
      const others = r.marks.filter((m) => m !== link)
      while (j < raw.length && raw[j].marks.some((m) => m.eq(link))) {
        const rj = raw[j]
        if (rj.kind !== 'text' || rj.marks.length !== others.length + 1 || !others.every((o) => hasMark(rj.marks, o)))
          simple = false
        else text += rj.text
        j++
      }
      const href = String(link.attrs.href || '')
      // linkify drops trailing punctuation, so such URLs need the explicit [](...) form
      const trailingPunct = /[.,;:!?)\]'"*_~]$/.test(text)
      if (simple && !trailingPunct && (text === href || text === safeDecode(href) || 'mailto:' + text === href)) {
        runs.push({ kind: 'raw', text: link.attrs.mdKind === 'angle' ? `<${text}>` : text, marks: others })
        i = j - 1
        continue
      }
    }
    runs.push(r)
  }

  // Push whitespace at emphasis boundaries outside the delimiters (`** x**` isn't bold).
  const out: Run[] = []
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    if (r.kind !== 'text' || !r.marks.some((m) => EMPHASIS.has(m.type.name))) {
      out.push(r)
      continue
    }
    const prevMarks = out.length ? out[out.length - 1].marks : []
    const nextMarks = runs[i + 1]?.marks ?? []
    const lead = /^\s+/.exec(r.text)?.[0] ?? ''
    const trail = r.text.length > lead.length ? /\s+$/.exec(r.text)?.[0] ?? '' : ''
    const mid = r.text.slice(lead.length, r.text.length - trail.length)
    if (lead) out.push({ kind: 'text', text: lead, marks: r.marks.filter((m) => !EMPHASIS.has(m.type.name) || hasMark(prevMarks, m)) })
    if (mid) out.push({ kind: 'text', text: mid, marks: r.marks })
    if (trail) out.push({ kind: 'text', text: trail, marks: r.marks.filter((m) => !EMPHASIS.has(m.type.name) || hasMark(nextMarks, m)) })
  }
  return out
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

function openDelim(m: Mark): string {
  switch (m.type.name) {
    case 'bold':
      return '**'
    case 'italic':
      return '*'
    case 'strike':
      return '~~'
    case 'link':
      return '['
    default:
      return ''
  }
}

function closeDelim(m: Mark): string {
  switch (m.type.name) {
    case 'bold':
      return '**'
    case 'italic':
      return '*'
    case 'strike':
      return '~~'
    case 'link':
      return `](${linkDest(String(m.attrs.href || ''))}${linkTitle(m.attrs.title)})`
    default:
      return ''
  }
}

function linkDest(href: string): string {
  if (href === '') return '<>'
  if (/[\s<>]/.test(href) || !balancedParens(href)) return '<' + href.replace(/[<>]/g, (c) => '\\' + c) + '>'
  return href
}

function balancedParens(s: string): boolean {
  let depth = 0
  for (const c of s) {
    if (c === '(') depth++
    else if (c === ')' && --depth < 0) return false
  }
  return depth === 0
}

function linkTitle(title: unknown): string {
  if (!title) return ''
  return ` "${String(title).replace(/["\\]/g, (c) => '\\' + c)}"`
}

function codeSpan(text: string, ctx: InlineCtx): string {
  let content = ctx.noNewlines ? text.replace(/\n/g, ' ') : text
  if (ctx.inTable) content = content.replace(/\|/g, '\\|')
  let longest = 0
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  const fence = '`'.repeat(longest + 1)
  const pad =
    content.startsWith('`') ||
    content.endsWith('`') ||
    (content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '')
      ? ' '
      : ''
  return fence + pad + content + pad + fence
}

export function serializeInline(parent: PMNode, ctx: InlineCtx): string {
  const runs = buildRuns(parent)
  let out = ''
  let active: Mark[] = []
  const inLink = () => active.some((m) => m.type.name === 'link')

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const marks = run.marks
    let keep = 0
    while (keep < active.length && hasMark(marks, active[keep])) keep++
    for (let j = active.length - 1; j >= keep; j--) out += closeDelim(active[j])
    active = active.slice(0, keep)

    // Open marks that last longest first so nested marks close cleanly.
    const span = (m: Mark) => {
      let n = 0
      for (let k = i; k < runs.length && hasMark(runs[k].marks, m); k++) n++
      return n
    }
    const toOpen = marks.filter((m) => !hasMark(active, m)).sort((a, b) => span(b) - span(a))
    // `!` right before `[` would turn a link into an image
    if (toOpen.some((m) => m.type.name === 'link') && out.endsWith('!') && !out.endsWith('\\!')) out = out.slice(0, -1) + '\\!'
    for (const m of toOpen) {
      out += openDelim(m)
      active.push(m)
    }

    switch (run.kind) {
      case 'text': {
        const next = runs[i + 1]
        const nextChar = next && (next.kind === 'text' || next.kind === 'raw') ? next.text[0] ?? '' : ''
        out += escapeText(run.text, {
          ...ctx,
          lineStart: out === '' || out.endsWith('\n'),
          prevChar: out[out.length - 1] ?? '',
          nextChar,
          inLink: inLink(),
          itemStart: ctx.listItemStart && out === ''
        })
        break
      }
      case 'code':
        out += codeSpan(run.text, ctx)
        break
      case 'raw':
        out += run.text
        break
      case 'node':
        out += serializeInlineNode(run.node, ctx)
        break
    }
  }
  for (let j = active.length - 1; j >= 0; j--) out += closeDelim(active[j])
  return out
}

function serializeInlineNode(node: PMNode, ctx: InlineCtx): string {
  switch (node.type.name) {
    case 'hardBreak':
      if (ctx.inTable || ctx.noNewlines) return node.attrs.html || '<br>'
      return node.attrs.html ? node.attrs.html : '\\\n'
    case 'image': {
      const alt = String(node.attrs.alt || '').replace(/[[\]\\]/g, (c) => '\\' + c)
      return `![${alt}](${linkDest(String(node.attrs.src || ''))}${linkTitle(node.attrs.title)})`
    }
    case 'htmlInline':
      return String(node.attrs.html || '')
    default:
      return node.textContent
  }
}

interface EscapeCtx extends InlineCtx {
  lineStart: boolean
  prevChar: string
  nextChar: string
  inLink: boolean
  itemStart?: boolean
}

const PUNCT = /[!-/:-@[-`{-~]/
const isSpace = (c: string) => c === '' || /\s/.test(c)
const isAlnum = (c: string) => c !== '' && /[\p{L}\p{N}]/u.test(c)
const ENTITY_RE = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/

function escapeText(input: string, ctx: EscapeCtx): string {
  let s = ctx.noNewlines ? input.replace(/\n/g, ' ') : input
  // trailing spaces before a newline would turn into a hard break
  s = s.replace(/[ \t]+\n/g, '\n')
  let out = ''
  // true until the first non-blank character of each line
  let lineStart = ctx.lineStart
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    const p = k > 0 ? s[k - 1] : ctx.prevChar
    const n = k + 1 < s.length ? s[k + 1] : ctx.nextChar
    if (c === '\n') {
      out += c
      lineStart = true
      continue
    }
    const atLineStart = lineStart
    if (atLineStart && (c === ' ' || c === '\t')) {
      // leading indentation is meaningless in markdown and 4+ spaces makes a code block
      continue
    }
    lineStart = false
    if (atLineStart) {
      const rest = s.slice(k, (s.indexOf('\n', k) + 1 || s.length + 1) - 1)
      if (/^(?:[-=_*+][ \t]*)+$/.test(rest) || /^[-+*>](?:[ \t]|$)/.test(rest) || /^#{1,6}(?:[ \t]|$)/.test(rest)) {
        out += '\\' + c
        continue
      }
      if (/^(?:```|~~~)/.test(rest)) {
        out += '\\' + c
        continue
      }
      const num = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(rest)
      if (num) {
        out += num[1] + '\\' + num[2]
        k += num[0].length - 1
        continue
      }
      if (c === '[' && /^\[[^\]]+\]:/.test(rest)) {
        out += '\\['
        continue
      }
      if (c === '<') {
        out += '\\<'
        continue
      }
    }
    switch (c) {
      case '\\':
        // before punctuation or a line break a lone backslash would mean something
        out += n === '' || n === '\n' || PUNCT.test(n) ? '\\\\' : '\\'
        break
      case '`':
        out += '\\`'
        break
      case '*':
        out += isSpace(p) && isSpace(n) && !atLineStart ? '*' : '\\*'
        break
      case '_':
        out += isAlnum(p) && isAlnum(n) ? '_' : '\\_'
        break
      case '~':
        out += p === '~' || n === '~' ? '\\~' : '~'
        break
      case '[': {
        if (ctx.itemStart && k === 0 && /^\[[ xX]\](?:\s|$)/.test(s)) {
          out += '\\['
          break
        }
        let close = s.indexOf(']', k)
        let escape = false
        while (close >= 0) {
          const after = close + 1 < s.length ? s[close + 1] : ctx.nextChar
          if (after === '(' || after === '[') {
            escape = true
            break
          }
          close = s.indexOf(']', close + 1)
        }
        out += escape || ctx.inLink ? '\\[' : '['
        break
      }
      case ']':
        out += ctx.inLink ? '\\]' : ']'
        break
      case '<':
        out += /[A-Za-z/!?]/.test(n) ? '\\<' : '<'
        break
      case '&':
        out += ENTITY_RE.test(s.slice(k)) ? '\\&' : '&'
        break
      case '|':
        out += ctx.inTable ? '\\|' : '|'
        break
      case '\u00a0':
        out += '&nbsp;'
        break
      default:
        out += c
    }
  }
  return out
}
