import { useEffect, useState } from 'react'
import type { Prefs } from '@shared/types'
import { baseOf } from '@/api'
import { PageIcon, MoreIcon, StarIcon, StarFilledIcon, MarkdownIcon, CopyIcon, FolderOpenIcon, ExternalIcon, SearchIcon } from './icons'
import { Popover, rectOf, type AnchorRect } from './Popover'
import type { SaveStatus } from './PageView'

function ago(ms: number | null): string {
  if (!ms) return ''
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

interface Props {
  root: string
  path: string | null
  title: string
  status: SaveStatus
  mtime: number | null
  sidebarOpen: boolean
  prefs: Prefs
  sourceMode: boolean
  favorite: boolean
  canBack: boolean
  canForward: boolean
  onBack(): void
  onForward(): void
  onOpenSidebar(): void
  onCrumb(rel: string): void
  onToggleSource(): void
  onToggleFavorite(): void
  onPrefs(patch: Partial<Prefs>): void
  onSearch(): void
  words(): number
  onAddProperties(): void
}

export function Topbar(p: Props) {
  const [menu, setMenu] = useState<AnchorRect | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30000)
    return () => clearInterval(t)
  }, [])

  const rel = p.path ? p.path.slice(p.root.length + 1) : ''
  const parts = rel ? rel.split('/') : []
  const dirs = parts.slice(0, -1)

  const status =
    p.status === 'saving'
      ? 'Saving…'
      : p.status === 'unsaved'
        ? 'Editing…'
        : p.status === 'reloaded'
          ? 'Updated from disk'
          : p.status === 'error'
            ? 'Not saved'
            : p.mtime
              ? `Edited ${ago(p.mtime)}`
              : ''

  return (
    <header className="topbar">
      <nav className="crumbs">
        <button className="crumb dim" onClick={() => p.onCrumb('')}>
          <span>{baseOf(p.root)}</span>
        </button>
        {dirs.map((d, i) => (
          <span key={i} style={{ display: 'contents' }}>
            <span className="crumb-sep">/</span>
            <button className="crumb dim" onClick={() => p.onCrumb(dirs.slice(0, i + 1).join('/'))}>
              <span>{d}</span>
            </button>
          </span>
        ))}
        {p.path && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb" title={rel}>
              <PageIcon size={16} />
              <span>{p.title}</span>
            </span>
          </>
        )}
      </nav>
      <div className="topbar-right">
        {p.path && (
          <span className={`topbar-status is-${p.status}`}>
            <span className="status-dot" />
            {status}
          </span>
        )}
        {p.path && (
          <>
            <button className={`topbar-button${p.sourceMode ? ' active' : ''}`} onClick={p.onToggleSource} title="Markdown source (⌘/)">
              <MarkdownIcon size={18} />
            </button>
            <button className="topbar-button" onClick={p.onToggleFavorite} title={p.favorite ? 'Remove from Favorites' : 'Add to Favorites'}>
              {p.favorite ? <StarFilledIcon size={18} /> : <StarIcon size={18} />}
            </button>
            <button className="topbar-button" onClick={(e) => setMenu(rectOf(e.currentTarget))} title="Style, export, and more">
              <MoreIcon size={18} />
            </button>
          </>
        )}
        {!p.path && (
          <button className="topbar-button" onClick={p.onSearch}>
            <SearchIcon size={18} />
          </button>
        )}
      </div>
      {menu && p.path && <PageMenu {...p} path={p.path} anchor={menu} onClose={() => setMenu(null)} />}
    </header>
  )
}

function Switch({ on }: { on: boolean }) {
  return <span className={`switch${on ? ' on' : ''}`} />
}

function PageMenu(p: Props & { path: string; anchor: AnchorRect; onClose(): void }) {
  const words = p.words()
  const fonts: { id: Prefs['font']; label: string; family: string }[] = [
    { id: 'default', label: 'Default', family: 'var(--font-sans)' },
    { id: 'serif', label: 'Serif', family: 'var(--font-serif)' },
    { id: 'mono', label: 'Mono', family: 'var(--font-mono-page)' }
  ]
  const item = (label: string, icon: React.ReactNode, onClick: () => void, right?: React.ReactNode, hint?: string) => (
    <button
      className="menu-item"
      onClick={() => {
        onClick()
        if (!right) p.onClose()
      }}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
      {right}
    </button>
  )
  return (
    <Popover anchor={p.anchor} placement="bottom-end" onClose={p.onClose}>
      <div className="menu" style={{ width: 260 }}>
        <div className="menu-section">Style</div>
        <div className="style-picker">
          {fonts.map((f) => (
            <button key={f.id} className={`style-option${p.prefs.font === f.id ? ' on' : ''}`} onClick={() => p.onPrefs({ font: f.id })}>
              <span className="ag" style={{ fontFamily: f.family }}>
                Ag
              </span>
              {f.label}
            </button>
          ))}
        </div>
        {item('Small text', <span style={{ fontSize: 12, fontWeight: 600 }}>Aa</span>, () => p.onPrefs({ smallText: !p.prefs.smallText }), <Switch on={p.prefs.smallText} />)}
        {item('Full width', <span style={{ fontSize: 14 }}>↔</span>, () => p.onPrefs({ fullWidth: !p.prefs.fullWidth }), <Switch on={p.prefs.fullWidth} />)}
        <div className="menu-sep" />
        {item('Markdown source', <MarkdownIcon size={18} />, p.onToggleSource, undefined, '⌘/')}
        {item('Add properties', <span style={{ fontSize: 13 }}>☰</span>, p.onAddProperties)}
        {item('Copy path', <CopyIcon size={18} />, () => void window.motion.copyText(p.path), undefined, '⇧⌘C')}
        {item('Reveal in Finder', <FolderOpenIcon size={18} />, () => void window.motion.reveal(p.path))}
        {item('Open in default app', <ExternalIcon size={18} />, () => void window.motion.openPath(p.path))}
        <div className="menu-sep" />
        <div className="menu-meta">
          Word count: {words.toLocaleString()}
          <br />
          {p.path.slice(p.root.length + 1)}
        </div>
      </div>
    </Popover>
  )
}
