import { promises as fsp, existsSync, watch, type FSWatcher, type Dirent } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, relative, sep, basename, dirname } from 'path'
import type { FileEntry, IndexSnapshot, SearchHit, FsChange } from '@shared/types'

// Never indexed, gitignored or not: too big, or never docs.
const ALWAYS_SKIP = new Set(['node_modules', '.git', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'Pods', 'DerivedData', '.Trash'])
// Outside a git repo there's no .gitignore to go by, so the usual build folders are hidden too.
const BUILD_DIRS = new Set(['out', 'dist', 'build', 'release', 'coverage', 'target'])
const run = promisify(execFile)
// Dot-folders are hidden except the ones that hold docs worth editing.
const VISIBLE_DOT_DIRS = new Set(['.claude', '.github'])
const MD_RE = /\.(md|markdown)$/i
// other text files the sidebar can show and open as source: prose and data, not code
const TEXT_RE = /\.(mdx|mdc|txt|text|log|rst|sql|json|jsonl|csv|tsv)$/i
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock'])
const MAX_TEXT_BYTES = 5 * 1024 * 1024
const MAX_FILES = 20000
const MAX_CACHED_BYTES = 64 * 1024 * 1024

export function isMarkdown(path: string): boolean {
  return MD_RE.test(path)
}

function isOtherText(name: string): boolean {
  return !name.startsWith('.') && !LOCKFILES.has(name) && !MD_RE.test(name) && TEXT_RE.test(name)
}

/** Is `dir` inside a git work tree? (Only then is git asked anything.) */
function inGitRepo(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true
    if (d === dirname(d)) return false
  }
}

/** What git ignores under `root`: ignored folders (as `rel/`) and files, or null if git can't say. */
async function gitIgnored(root: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await run('git', ['-C', root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024
    })
    return new Set(stdout.split('\0').filter(Boolean))
  } catch {
    return null
  }
}

function extractTitle(content: string): string | null {
  let text = content
  let fmTitle: string | null = null
  const fm = /^---(?:yaml|json)?[ \t]*\n([\s\S]*?)\n?(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text)
  if (fm) {
    const t = /^\s*"?(?:title|name)"?\s*:\s*["']?(.+?)["']?\s*,?\s*$/m.exec(fm[1])
    if (t) fmTitle = t[1].trim()
    text = text.slice(fm[0].length)
  }
  const firstLine = text.trimStart().split('\n', 1)[0]
  const h = /^#[ \t]+(.+?)[ \t#]*$/.exec(firstLine)
  return h ? h[1].replace(/[*_`]/g, '').trim() : fmTitle
}

/** One open folder: an index of its markdown files, a content cache for search, and a watcher. */
export class Workspace {
  files = new Map<string, FileEntry>()
  /** non-markdown text files: listed, searched and opened as source */
  others = new Map<string, FileEntry>()
  /** mtime of our last write per path, so the sidebar can tell our saves from outside edits */
  private ownMtimes = new Map<string, number>()
  /** our writes update the index directly, so the next flush must still publish it */
  private unpublished = false
  contents = new Map<string, string>()
  private cachedBytes = 0
  private watcher: FSWatcher | null = null
  private pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  /** content we wrote ourselves, so the watcher can ignore the echo */
  private ownWrites = new Map<string, string>()
  /** files you opened inside a folder the index skips (out/, dist/…): listed and watched anyway */
  private included = new Set<string>()

  /** git-ignored paths under the root (folders end in `/`); null outside a git repo */
  private ignored: Set<string> | null = null
  private git = false

  constructor(
    readonly root: string,
    private onChange: (change: FsChange) => void,
    /** list gitignored files too (dimmed in the sidebar) */
    private showIgnored: () => boolean = () => false
  ) {}

  async init(): Promise<void> {
    this.git = inGitRepo(this.root)
    await this.scan()
    this.startWatching()
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
  }

  snapshot(): IndexSnapshot {
    const mark = (f: FileEntry) => ({ ...f, byMotion: this.ownMtimes.get(f.path) === f.mtime })
    return {
      root: this.root,
      files: [...this.files.values()].sort((a, b) => a.rel.localeCompare(b.rel)).map(mark),
      others: [...this.others.values()].sort((a, b) => a.rel.localeCompare(b.rel)).map(mark)
    }
  }

  private skipDir(name: string): boolean {
    if (ALWAYS_SKIP.has(name) || (!this.git && BUILD_DIRS.has(name))) return true
    return name.startsWith('.') && !VISIBLE_DOT_DIRS.has(name)
  }

  private isIgnored(rel: string, dir: boolean): boolean {
    return !!this.ignored?.has(dir ? rel + '/' : rel)
  }

  /** A watched path that isn't listed: in a skipped folder, or gitignored while those are hidden. */
  private hidden(rel: string): boolean {
    const parts = rel.split('/')
    if (parts.some((part, i) => (i < parts.length - 1 || !MD_RE.test(part)) && this.skipDir(part))) return true
    if (!this.ignored || this.showIgnored()) return false
    if (this.ignored.has(rel)) return true
    for (let i = 1; i < parts.length; i++) if (this.ignored.has(parts.slice(0, i).join('/') + '/')) return true
    return false
  }

  /** Rescan, e.g. after the show-ignored setting changed. */
  async rescan(): Promise<void> {
    this.unpublished = true
    await this.flush()
  }

  private toRel(p: string): string {
    return relative(this.root, p).split(sep).join('/')
  }

  private async scan(): Promise<Map<string, FileEntry>> {
    const found = new Map<string, FileEntry>()
    const others = new Map<string, FileEntry>()
    if (this.git) this.ignored = await gitIgnored(this.root)
    const show = this.showIgnored()
    // `ign`: everything under this folder is gitignored
    const walk = async (dir: string, ign = false) => {
      if (found.size + others.size >= MAX_FILES) return
      let entries: Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      const subdirs: [string, boolean][] = []
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (this.skipDir(e.name)) continue
          const di = ign || this.isIgnored(this.toRel(p), true)
          if (!di || show) subdirs.push([p, di])
          continue
        }
        const fi = ign || this.isIgnored(this.toRel(p), false)
        if (fi && !show) continue
        if ((e.isFile() || e.isSymbolicLink()) && MD_RE.test(e.name)) {
          try {
            const st = await fsp.stat(p)
            if (!st.isFile()) continue
            const prev = this.files.get(p)
            found.set(p, {
              path: p,
              rel: this.toRel(p),
              name: e.name,
              mtime: st.mtimeMs,
              size: st.size,
              title: prev && prev.mtime === st.mtimeMs ? prev.title : null,
              ignored: fi || undefined
            })
          } catch {
            /* vanished */
          }
        } else if ((e.isFile() || e.isSymbolicLink()) && isOtherText(e.name)) {
          try {
            const st = await fsp.stat(p)
            if (!st.isFile() || st.size > MAX_TEXT_BYTES) continue
            others.set(p, { path: p, rel: this.toRel(p), name: e.name, mtime: st.mtimeMs, size: st.size, title: null, ignored: fi || undefined })
          } catch {
            /* vanished */
          }
        }
      }
      await Promise.all(subdirs.map(([d, di]) => walk(d, di)))
    }
    await walk(this.root)
    for (const p of this.included) {
      if (found.has(p) || others.has(p)) continue
      try {
        const st = await fsp.stat(p)
        if (!st.isFile()) continue
        const entry = { path: p, rel: this.toRel(p), name: basename(p), mtime: st.mtimeMs, size: st.size, title: null }
        if (MD_RE.test(p)) found.set(p, entry)
        else if (st.size <= MAX_TEXT_BYTES) others.set(p, entry)
      } catch {
        /* gone */
      }
    }
    // refresh titles + content cache for new/changed files
    // other text files are cached too, so search covers their contents
    await Promise.all(
      [...[...found.values()].map((f) => [f, this.files.get(f.path)] as const), ...[...others.values()].map((f) => [f, this.others.get(f.path)] as const)].map(
        async ([f, prev]) => {
          if (prev && prev.mtime === f.mtime && this.contents.has(f.path)) {
            f.title = prev.title
            return
          }
          await this.load(f)
        }
      )
    )
    for (const p of this.contents.keys()) {
      if (!found.has(p) && !others.has(p)) this.dropContent(p)
    }
    const old = this.files
    this.files = found
    this.others = others
    return old
  }

  private async load(f: FileEntry): Promise<void> {
    try {
      if (f.size > 2 * 1024 * 1024) {
        f.title = null
        return
      }
      const text = await fsp.readFile(f.path, 'utf8')
      f.title = extractTitle(text)
      this.dropContent(f.path)
      if (this.cachedBytes + text.length < MAX_CACHED_BYTES) {
        this.contents.set(f.path, text)
        this.cachedBytes += text.length
      }
    } catch {
      f.title = null
    }
  }

  private dropContent(p: string) {
    const old = this.contents.get(p)
    if (old !== undefined) {
      this.cachedBytes -= old.length
      this.contents.delete(p)
    }
  }

  private startWatching() {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return this.schedule('*')
        const p = join(this.root, filename.toString())
        if (!this.included.has(p) && this.hidden(filename.toString().split(sep).join('/'))) return
        this.schedule(p)
      })
      this.watcher.on('error', () => {
        /* root deleted or permissions changed */
      })
    } catch {
      this.watcher = null
    }
  }

  private schedule(p: string) {
    this.pending.add(p)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 120)
  }

  private async flush() {
    this.timer = null
    this.pending.clear()
    const all = () => [...this.files, ...this.others]
    const before = new Map(all().map(([k, v]) => [k, v.mtime]))
    await this.scan()
    const changed: string[] = []
    const added: string[] = []
    const removed: string[] = []
    // our own saves still move mtimes (Recently edited), they just aren't reported as external edits
    let touched = false
    for (const [p, f] of all()) {
      const m = before.get(p)
      if (m === undefined) added.push(p)
      else if (m !== f.mtime) {
        touched = true
        if (this.ownMtimes.get(p) === f.mtime) continue
        const own = this.ownWrites.get(p)
        if (own !== undefined && this.contents.get(p) === own) continue
        changed.push(p)
      }
    }
    for (const p of before.keys()) if (!this.files.has(p) && !this.others.has(p)) removed.push(p)
    if (touched || this.unpublished || added.length || removed.length) {
      this.unpublished = false
      this.onChange({ root: this.root, changed, added, removed, snapshot: this.snapshot() })
    }
  }

  /** Index and watch a file opened from a skipped folder. */
  async include(p: string): Promise<void> {
    if (this.files.has(p) || this.others.has(p) || this.included.has(p)) return
    if (!p.startsWith(this.root + sep) || !(MD_RE.test(p) || isOtherText(basename(p)))) return
    this.included.add(p)
    await this.flush()
  }

  async refresh(): Promise<void> {
    await this.flush()
  }

  /** Record a write we made so the watcher doesn't report it back as external. */
  noteWrite(p: string, content: string, mtime: number, size: number) {
    this.ownMtimes.set(p, mtime)
    this.unpublished = true
    this.schedule(p)
    if (!MD_RE.test(p)) {
      const o = this.others.get(p)
      if (o) {
        o.mtime = mtime
        o.size = size
      } else if (p.startsWith(this.root + sep) && isOtherText(basename(p))) {
        this.others.set(p, { path: p, rel: this.toRel(p), name: basename(p), mtime, size, title: null })
      }
      this.dropContent(p)
      this.contents.set(p, content)
      this.cachedBytes += content.length
      return
    }
    this.ownWrites.set(p, content)
    const f = this.files.get(p)
    if (f) {
      f.mtime = mtime
      f.size = size
      f.title = extractTitle(content)
    } else if (p.startsWith(this.root + sep) && MD_RE.test(p)) {
      this.files.set(p, { path: p, rel: this.toRel(p), name: basename(p), mtime, size, title: extractTitle(content) })
    }
    this.dropContent(p)
    this.contents.set(p, content)
    this.cachedBytes += content.length
  }

  search(query: string, limit = 60): SearchHit[] {
    const q = query.trim().toLowerCase()
    const files = [...this.files.values(), ...this.others.values()]
    if (!q) return []
    const terms = q.split(/\s+/).filter(Boolean)
    const hits: SearchHit[] = []
    for (const f of files) {
      const title = MD_RE.test(f.name) ? f.title || f.name.replace(MD_RE, '') : f.name
      const hay = (title + ' ' + f.rel).toLowerCase()
      let score = 0
      const nameScore = fuzzyScore(title.toLowerCase(), q)
      const relScore = fuzzyScore(f.rel.toLowerCase(), q)
      score = Math.max(nameScore * 2, relScore)
      if (terms.every((t) => hay.includes(t))) score += 40
      let snippet: string | null = null
      let line: number | null = null
      const content = this.contents.get(f.path)
      if (content) {
        const lower = content.toLowerCase()
        const idx = lower.indexOf(q)
        let matchAt = idx
        if (idx < 0 && terms.length > 1 && terms.every((t) => lower.includes(t))) matchAt = lower.indexOf(terms[0])
        if (matchAt >= 0) {
          const ls = content.lastIndexOf('\n', matchAt) + 1
          const le = content.indexOf('\n', matchAt)
          const raw = content.slice(ls, le < 0 ? undefined : le)
          const col = matchAt - ls
          const start = Math.max(0, col - 60)
          snippet = (start > 0 ? '…' : '') + plain(raw.slice(start, start + 180))
          line = content.slice(0, matchAt).split('\n').length
          let count = 0
          for (let i = lower.indexOf(terms[0]); i >= 0 && count < 20; i = lower.indexOf(terms[0], i + 1)) count++
          score += 10 + Math.min(count, 10) + (idx >= 0 ? 15 : 0)
        }
      }
      if (score > 0) hits.push({ path: f.path, rel: f.rel, title, snippet, line, score })
    }
    hits.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length)
    return hits.slice(0, limit)
  }
}

/** Strip the noisiest markdown syntax from a snippet line. */
function plain(s: string): string {
  return s
    .replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+|>\s*)+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .trim()
}

/** Subsequence match score; contiguous and word-start matches score higher. 0 = no match. */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0
  const direct = text.indexOf(query)
  if (direct >= 0) return 100 - Math.min(direct, 50) + (direct === 0 ? 30 : 0)
  let ti = 0
  let score = 0
  let streak = 0
  for (const qc of query) {
    if (qc === ' ') continue
    const found = text.indexOf(qc, ti)
    if (found < 0) return 0
    const wordStart = found === 0 || /[\s/_\-.]/.test(text[found - 1])
    streak = found === ti ? streak + 1 : 0
    score += 1 + streak * 2 + (wordStart ? 3 : 0)
    ti = found + 1
  }
  return Math.min(60, score)
}
