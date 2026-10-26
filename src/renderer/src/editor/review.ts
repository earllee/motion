import type { Schema, Node as PMNode } from '@tiptap/pm/model'
import { parseMarkdown } from './markdown/parse'
import { splitFrontmatter } from './markdown/frontmatter'

/**
 * Reviewing outside edits. A file under review has a base: its text before the first
 * outside change you haven't reviewed. Both texts are cut into top-level blocks and
 * diffed block by block; each run of differing blocks is one change you can keep
 * (fold it into the base) or undo (put the base's blocks back in the file).
 */

/** One top-level block of source, and the top-level nodes it parses to. */
export interface Segment {
  /** exact source, including the blank lines after it */
  text: string
  /** what's compared: the source without surrounding whitespace */
  key: string
  /** node range in the parsed doc; -1 for the frontmatter segment */
  from: number
  to: number
}

export interface Segmented {
  segs: Segment[]
  doc: PMNode
}

/** A run of blocks that differ: base segments [b0, b1) became current segments [c0, c1). */
export interface Hunk {
  b0: number
  b1: number
  c0: number
  c1: number
}

export interface Review {
  base: Segmented
  cur: Segmented
  hunks: Hunk[]
}

export const normalize = (t: string) => t.replace(/^﻿/, '').replace(/\r\n?/g, '\n')

/** Segment 0 is always the frontmatter (empty if there is none), so indices line up. */
export function segment(text: string, schema: Schema): Segmented {
  const norm = normalize(text)
  const { body } = splitFrontmatter(norm)
  const head = norm.slice(0, norm.length - body.length)
  const { doc, source } = parseMarkdown(norm, schema)
  const segs: Segment[] = [{ text: head, key: '\u0000' + head.trim(), from: -1, to: -1 }]
  const starts: number[] = []
  let node = 0
  source.sizes.forEach((n, i) => {
    // a group without a known source range (unterminated <details>) joins the one before it
    if (source.starts[i] >= 0 || segs.length === 1) {
      segs.push({ text: '', key: '', from: node, to: node + n })
      starts.push(Math.max(0, source.starts[i]))
    } else segs[segs.length - 1].to += n
    node += n
  })
  if (starts.length) starts[0] = 0
  for (let i = 1; i < segs.length; i++) {
    segs[i].text = body.slice(starts[i - 1], i < starts.length ? starts[i] : body.length)
    segs[i].key = segs[i].text.trim()
  }
  return { segs, doc }
}

/** Runs of `a` and `b` that differ, from an LCS over equal items. */
export function diff(a: string[], b: string[]): Hunk[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const n = A.length
  const m = B.length
  if (!n && !m) return []
  if (n * m > 4_000_000) return [{ b0: pre, b1: pre + n, c0: pre, c1: pre + m }]
  const w = m + 1
  const L = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
  const hunks: Hunk[] = []
  let open: Hunk | null = null
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      if (open) hunks.push(open)
      open = null
      i++
      j++
      continue
    }
    open ??= { b0: pre + i, b1: pre + i, c0: pre + j, c1: pre + j }
    if (j < m && (i >= n || L[i * w + j + 1] >= L[(i + 1) * w + j])) open.c1 = pre + ++j
    else open.b1 = pre + ++i
  }
  if (open) hunks.push(open)
  return hunks
}

const keys = (s: Segmented) => s.segs.map((x) => x.key)

export function computeReview(base: string, cur: string, schema: Schema): Review {
  const b = segment(base, schema)
  const c = segment(cur, schema)
  return { base: b, cur: c, hunks: diff(keys(b), keys(c)).flatMap((h) => refine(h, keys(b), keys(c))) }
}

const words = (t: string) => new Set(t.toLowerCase().match(/\w+/g) ?? [])

/** Mostly the same words: an edit of one block rather than a replacement. */
function similar(a: string, b: string): boolean {
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return a.trim() === b.trim()
  let common = 0
  for (const w of A) if (B.has(w)) common++
  return common / Math.max(A.size, B.size) >= 0.5
}

/**
 * Split a run of changed blocks so each edited block is its own change (shown word by
 * word) and added or removed blocks around it are separate ones.
 */
function refine(h: Hunk, b: string[], c: string[]): Hunk[] {
  const n = h.b1 - h.b0
  const m = h.c1 - h.c0
  if (!n || !m || n * m > 2500) return [h]
  const w = m + 1
  const L = new Uint16Array((n + 1) * w)
  const same = (i: number, j: number) => h.b0 + i > 0 && h.c0 + j > 0 && similar(b[h.b0 + i], c[h.c0 + j])
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i * w + j] = same(i, j) ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
  if (!L[0]) return [h]
  const out: Hunk[] = []
  let i = 0
  let j = 0
  let gap: Hunk | null = null
  const flush = () => {
    if (gap) out.push(gap)
    gap = null
  }
  while (i < n || j < m) {
    if (i < n && j < m && same(i, j) && L[i * w + j] === L[(i + 1) * w + j + 1] + 1) {
      flush()
      out.push({ b0: h.b0 + i, b1: h.b0 + i + 1, c0: h.c0 + j, c1: h.c0 + j + 1 })
      i++
      j++
      continue
    }
    gap ??= { b0: h.b0 + i, b1: h.b0 + i, c0: h.c0 + j, c1: h.c0 + j }
    if (j < m && (i >= n || L[i * w + j + 1] >= L[(i + 1) * w + j])) gap.c1 = h.c0 + ++j
    else gap.b1 = h.b0 + ++i
  }
  flush()
  return out
}

interface Part {
  from: Segmented
  idx: number
}

const part = (from: Segmented, a: number, b: number): Part[] => Array.from({ length: Math.max(0, b - a) }, (_, k) => ({ from, idx: a + k }))

/** Join segments back into text. Where pieces from different texts meet, make sure a blank line separates the blocks. */
function assemble(parts: Part[]): string {
  let out = ''
  let prev: Part | null = null
  for (const p of parts) {
    const text = p.from.segs[p.idx].text
    if (!text) continue
    if (prev && prev.idx === 0) {
      if (!out.endsWith('\n')) out += '\n'
    } else if (prev && !(prev.from === p.from && prev.idx + 1 === p.idx)) {
      out += out.endsWith('\n\n') ? '' : out.endsWith('\n') ? '\n' : '\n\n'
    }
    out += text
    prev = p
  }
  return out
}

/** The current text with change `i` put back the way the base had it. */
export function undoHunk(r: Review, i: number): string {
  const h = r.hunks[i]
  const n = r.cur.segs.length
  return assemble([...part(r.cur, 0, h.c0), ...part(r.base, h.b0, h.b1), ...part(r.cur, h.c1, n)])
}

/** The base with change `i` accepted. */
export function keepHunk(r: Review, i: number): string {
  const h = r.hunks[i]
  const n = r.base.segs.length
  return assemble([...part(r.base, 0, h.b0), ...part(r.cur, h.c0, h.c1), ...part(r.base, h.b1, n)])
}

/** Give `text` the BOM and line endings of `like`. */
export function matchFormat(text: string, like: string): string {
  let out = /\r\n/.test(like) ? text.replace(/\n/g, '\r\n') : text
  if (like.charCodeAt(0) === 0xfeff) out = '﻿' + out
  return out
}

/**
 * Your own edits aren't up for review: when you save `next` over `saved`, carry each
 * change you made into the base too, unless it touches blocks that are still under review.
 */
export function rebase(base: string, saved: string, next: string, schema: Schema): string {
  const B = segment(base, schema)
  const S = segment(saved, schema)
  const T = segment(next, schema)
  // which base segment each unchanged saved segment is
  const sToB = new Array<number>(S.segs.length).fill(-1)
  let bi = 0
  let si = 0
  for (const h of [...diff(keys(B), keys(S)), { b0: B.segs.length, b1: 0, c0: S.segs.length, c1: 0 }]) {
    while (si < h.c0) sToB[si++] = bi++
    bi = h.b1
    si = h.c1
  }
  const out: Part[] = part(B, 0, B.segs.length)
  const mine = diff(keys(S), keys(T))
  for (let k = mine.length - 1; k >= 0; k--) {
    const h = mine[k]
    // the edited segments and their neighbours must all be untouched, contiguous base segments
    const lo = Math.max(0, h.b0 - 1)
    const hi = Math.min(S.segs.length - 1, h.b1)
    let ok = true
    for (let s = lo; s <= hi; s++) if (sToB[s] < 0 || (s > lo && sToB[s] !== sToB[s - 1] + 1)) ok = false
    if (!ok) continue
    const from = h.b0 < h.b1 ? sToB[h.b0] : h.b0 > 0 ? sToB[h.b0 - 1] + 1 : 0
    const to = h.b0 < h.b1 ? sToB[h.b1 - 1] + 1 : from
    out.splice(from, to - from, ...part(T, h.c0, h.c1))
  }
  return assemble(out)
}

// ---- one suggestion per edit

/**
 * A suggestion: a whole run of changed blocks, or, inside a paragraph or heading edited
 * in place, one run of changed words, as [start, end) offsets into the base and
 * current source of that block.
 */
export interface Change {
  hunk: number
  word?: { b: [number, number]; c: [number, number] }
}

const TOKEN = /\w+|\s+|[^\w\s]/gu
const tokens = (t: string) => t.match(TOKEN) ?? []
const offsets = (t: string[]) => t.reduce((o, x) => (o.push(o[o.length - 1] + x.length), o), [0])

export function changesOf(r: Review): Change[] {
  return r.hunks.flatMap((h, hunk) => wordChanges(r, h)?.map((word) => ({ hunk, word })) ?? [{ hunk }])
}

function wordChanges(r: Review, h: Hunk): Change['word'][] | null {
  if (h.b1 - h.b0 !== 1 || h.c1 - h.c0 !== 1 || h.b0 === 0 || h.c0 === 0) return null
  const bs = r.base.segs[h.b0]
  const cs = r.cur.segs[h.c0]
  if (bs.to - bs.from !== 1 || cs.to - cs.from !== 1) return null
  const old = r.base.doc.child(bs.from)
  const node = r.cur.doc.child(cs.from)
  if (!node.isTextblock || old.type !== node.type || old.attrs.level !== node.attrs.level) return null
  const a = tokens(bs.text)
  const b = tokens(cs.text)
  const oa = offsets(a)
  const ob = offsets(b)
  const blank = (t: string[]) => t.every((x) => !x.trim())
  // edits separated only by whitespace read as one
  const runs: Hunk[] = []
  for (const d of diff(a, b)) {
    const prev = runs[runs.length - 1]
    if (prev && blank(a.slice(prev.b1, d.b0)) && blank(b.slice(prev.c1, d.c0))) {
      prev.b1 = d.b1
      prev.c1 = d.c1
    } else runs.push({ ...d })
  }
  const real = runs.filter((d) => !blank(a.slice(d.b0, d.b1)) || !blank(b.slice(d.c0, d.c1)))
  if (!real.length) return null
  const changed = real.reduce((n, d) => n + Math.max(oa[d.b1] - oa[d.b0], ob[d.c1] - ob[d.c0]), 0)
  // mostly rewritten: show it as a replaced block instead
  if (changed > Math.max(bs.text.trim().length, cs.text.trim().length) * 0.7) return null
  return real.map((d) => ({ b: [oa[d.b0], oa[d.b1]], c: [ob[d.c0], ob[d.c1]] }))
}

const replaceSeg = (s: Segmented, idx: number, text: string) => s.segs.map((x, k) => (k === idx ? text : x.text)).join('')

/** The base with this suggestion accepted. */
export function acceptChange(r: Review, ch: Change): string {
  if (!ch.word) return keepHunk(r, ch.hunk)
  const h = r.hunks[ch.hunk]
  const bt = r.base.segs[h.b0].text
  const ct = r.cur.segs[h.c0].text
  return replaceSeg(r.base, h.b0, bt.slice(0, ch.word.b[0]) + ct.slice(ch.word.c[0], ch.word.c[1]) + bt.slice(ch.word.b[1]))
}

/** The current text with this suggestion rejected. */
export function rejectChange(r: Review, ch: Change): string {
  if (!ch.word) return undoHunk(r, ch.hunk)
  const h = r.hunks[ch.hunk]
  const bt = r.base.segs[h.b0].text
  const ct = r.cur.segs[h.c0].text
  return replaceSeg(r.cur, h.c0, ct.slice(0, ch.word.c[0]) + bt.slice(ch.word.b[0], ch.word.b[1]) + ct.slice(ch.word.c[1]))
}

/** Markdown source as reading text, for deleted words and suggestion cards. */
export const plainMd = (t: string) =>
  t
    .replace(/\]\([^)]*\)/g, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/[*`~[\]]/g, '')
    .replace(/(^|\W)_+|_+(?=\W|$)/g, '$1')
