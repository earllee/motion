import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, SearchHit } from '@shared/types'
import { api } from '@/api'
import { PageIcon, SearchIcon, ReturnIcon, CodeIcon } from './icons'

interface Props {
  files: FileEntry[]
  recent: string[]
  onOpen(path: string, line?: number | null, query?: string, newTab?: boolean): void
  onClose(): void
}

function highlight(text: string, q: string) {
  const terms = q.trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return text
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig')
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))
}

/** ⌘P quick find: recent pages, then fuzzy title/path + full-text matches. */
export function SearchModal({ files, recent, onOpen, onClose }: Props) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    if (!q.trim()) {
      setHits([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void api.search(q).then((r) => {
        if (!cancelled) {
          setHits(r)
          setActive(0)
        }
      })
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q])

  const recentItems = useMemo(() => {
    const byPath = new Map(files.map((f) => [f.path, f]))
    const seen = new Set<string>()
    const out: SearchHit[] = []
    for (const p of recent) {
      const f = byPath.get(p)
      if (f && !seen.has(p)) {
        seen.add(p)
        out.push({ path: f.path, rel: f.rel, title: f.title || f.name.replace(/\.md$/, ''), snippet: null, line: null, score: 0 })
      }
    }
    if (out.length < 8) {
      for (const f of [...files].sort((a, b) => b.mtime - a.mtime)) {
        if (out.length >= 8) break
        if (!seen.has(f.path)) {
          seen.add(f.path)
          out.push({ path: f.path, rel: f.rel, title: f.title || f.name.replace(/\.md$/, ''), snippet: null, line: null, score: 0 })
        }
      }
    }
    return out.slice(0, 12)
  }, [files, recent])

  const items = q.trim() ? hits : recentItems

  useEffect(() => {
    listRef.current?.querySelector('.search-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-modal">
        <div className="search-input-row">
          <SearchIcon size={20} />
          <input
            ref={inputRef}
            value={q}
            placeholder="Search pages and text…"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, items.length - 1))
              } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const it = items[active]
                if (it) onOpen(it.path, it.line, it.snippet ? q : undefined, e.metaKey)
              }
            }}
          />
        </div>
        <div className="search-results" ref={listRef}>
          {!q.trim() && <div className="search-group">Recent</div>}
          {q.trim() && items.length === 0 && <div className="search-group">No results</div>}
          {q.trim() && items.length > 0 && <div className="search-group">Best matches</div>}
          {items.map((it, i) => {
            const slash = it.rel.lastIndexOf('/')
            const dir = slash >= 0 ? it.rel.slice(0, slash) : ''
            const name = it.rel.slice(slash + 1)
            // the file name, unless the title already is it
            const where = it.title === name ? dir : it.rel
            return (
              <div
                key={it.path}
                className={`search-item${i === active ? ' active' : ''}`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={(e) => onOpen(it.path, it.line, it.snippet ? q : undefined, e.metaKey)}
              >
                <span className="si-icon">{/\.(md|markdown)$/i.test(name) ? <PageIcon size={18} /> : <CodeIcon size={16} />}</span>
                <div className="si-body">
                  <div className="si-title">
                    {highlight(it.title, q)}
                    {where && <span style={{ color: 'var(--text-3)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>{where}</span>}
                  </div>
                  {it.snippet && <div className="si-snippet">{highlight(it.snippet, q)}</div>}
                </div>
                <span className="si-enter">
                  <ReturnIcon size={14} />
                </span>
              </div>
            )
          })}
        </div>
        <div className="search-footer">
          <span>
            <kbd>↑↓</kbd>Select
          </span>
          <span>
            <kbd>↵</kbd>Open
          </span>
          <span>
            <kbd>⌘↵</kbd>Open in new tab
          </span>
          <span>
            <kbd>esc</kbd>Close
          </span>
        </div>
      </div>
    </div>
  )
}
