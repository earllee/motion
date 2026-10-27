import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/types'
import { baseOf, dirOf, joinPath } from '@/api'
import {
  PageIcon,
  FolderIcon,
  ChevronRight,
  PlusIcon,
  MoreIcon,
  SearchIcon,
  NewPageIcon,
  StarFilledIcon,
  ClockIcon,
  ChevronDown,
  FolderOpenIcon,
  TrashIcon,
  DuplicateIcon,
  CopyIcon,
  ExternalIcon,
  StarIcon,
  LinkIcon,
  CodeIcon,
  EyeIcon
} from './icons'
import { PopoverMenu, type MenuItemDef } from './Menu'
import type { OpenOptions } from '@/App'

/** ⌘-click or middle-click opens in a background tab. */
/** ⌘/middle-click opens a background tab; a plain click previews the page (double-click keeps it) */
const openOpts = (e: React.MouseEvent): OpenOptions =>
  e.metaKey || e.button === 1 ? { newTab: true, background: true } : { preview: true }
import { rectOf, type AnchorRect } from './Popover'

export interface TreeNode {
  name: string
  rel: string
  path: string
  kind: 'dir' | 'file'
  title: string | null
  children: TreeNode[]
  /** gitignored (a folder: everything in it is) */
  ignored?: boolean
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function buildTree(root: string, files: FileEntry[]): TreeNode {
  const top: TreeNode = { name: baseOf(root), rel: '', path: root, kind: 'dir', title: null, children: [] }
  const dirs = new Map<string, TreeNode>([['', top]])
  for (const f of files) {
    const parts = f.rel.split('/')
    let parent = top
    let acc = ''
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i]
      let d = dirs.get(acc)
      if (!d) {
        d = { name: parts[i], rel: acc, path: joinPath(root, acc), kind: 'dir', title: null, children: [] }
        dirs.set(acc, d)
        parent.children.push(d)
      }
      parent = d
    }
    parent.children.push({ name: f.name, rel: f.rel, path: f.path, kind: 'file', title: f.title, children: [], ignored: f.ignored })
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : collator.compare(a.name, b.name)))
    n.children.forEach(sort)
    if (n.kind === 'dir' && n !== top) n.ignored = n.children.length > 0 && n.children.every((c) => c.ignored)
  }
  sort(top)
  return top
}

const asNode = (f: FileEntry): TreeNode => ({ name: f.name, rel: f.rel, path: f.path, kind: 'file', title: f.title, children: [] })

/** "now", "4m", "3h", "2d", "Oct 18" — compact enough for the sidebar */
function shortAgo(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const isMd = (name: string) => /\.(md|markdown)$/i.test(name)
const fileIcon = (name: string, size = 18) => (isMd(name) ? <PageIcon size={size} /> : <CodeIcon size={size - 2} />)

const displayName = (n: { name: string; kind: string }) => (n.kind === 'file' ? n.name.replace(/\.(md|markdown)$/i, '') : n.name)

export interface SidebarProps {
  root: string
  files: FileEntry[]
  /** changed outside Motion since last opened */
  unseen: Set<string>
  showAllFiles: boolean
  onToggleAllFiles(): void
  showIgnored: boolean
  onToggleIgnored(): void
  current: string | null
  expanded: Set<string>
  favorites: string[]
  recentRoots: string[]
  width: number
  open: boolean
  onOpen(path: string, opts?: OpenOptions): void
  onToggle(rel: string, open?: boolean): void
  onNewPage(dir: string): void
  onNewFolder(dir: string): void
  onSearch(): void
  onOpenFolder(root?: string): void
  onCollapse(): void
  onResize(width: number): void
  onRename(from: string, to: string): void
  onTrash(path: string): void
  onDuplicate(path: string): void
  onToggleFavorite(path: string): void
  onMove(from: string, toDir: string): void
  fullscreen?: boolean
}

export function Sidebar(props: SidebarProps) {
  const { root, files, current, expanded, width, open } = props
  const tree = useMemo(() => buildTree(root, files), [root, files])
  const [menu, setMenu] = useState<{ node: TreeNode; anchor: AnchorRect } | null>(null)
  const [wsMenu, setWsMenu] = useState<AnchorRect | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [sections, setSections] = useState({ favorites: true, recent: true, pages: true })
  const [resizing, setResizing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const recent = useMemo(() => [...files].sort((a, b) => b.mtime - a.mtime).slice(0, 5), [files])
  const favs = useMemo(() => props.favorites.map((p) => files.find((f) => f.path === p)).filter(Boolean) as FileEntry[], [props.favorites, files])

  // keep the open page visible in the tree
  useEffect(() => {
    if (!current) return
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`.tree .tree-row[data-path="${CSS.escape(current)}"]`)
      el?.scrollIntoView({ block: 'nearest' })
    })
  }, [current])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    setResizing(true)
    const startX = e.clientX
    const startW = width
    const move = (ev: MouseEvent) => props.onResize(Math.max(200, Math.min(480, startW + ev.clientX - startX)))
    const up = () => {
      setResizing(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const itemMenu = (node: TreeNode): MenuItemDef[] => {
    const isFav = props.favorites.includes(node.path)
    const items: MenuItemDef[] = []
    if (node.kind === 'file') {
      items.push(
        { id: 'fav', label: isFav ? 'Remove from Favorites' : 'Add to Favorites', icon: <StarIcon size={18} />, onSelect: () => props.onToggleFavorite(node.path) },
        { id: 'dup', label: 'Duplicate', icon: <DuplicateIcon size={18} />, onSelect: () => props.onDuplicate(node.path) }
      )
    } else {
      items.push(
        { id: 'new', label: 'New page inside', icon: <NewPageIcon size={18} />, onSelect: () => props.onNewPage(node.path) },
        { id: 'newdir', label: 'New folder inside', icon: <FolderIcon size={18} />, onSelect: () => props.onNewFolder(node.path) }
      )
    }
    items.push(
      { id: 'rename', label: 'Rename', icon: <span style={{ fontSize: 14, fontWeight: 600 }}>Aa</span>, onSelect: () => setRenaming(node.path) },
      { id: 'copypath', label: 'Copy path', icon: <CopyIcon size={18} />, onSelect: () => void window.motion.copyText(node.path) },
      { id: 'copyrel', label: 'Copy relative path', icon: <LinkIcon size={18} />, onSelect: () => void window.motion.copyText(node.rel) },
      { id: 'reveal', label: 'Reveal in Finder', icon: <FolderOpenIcon size={18} />, onSelect: () => void window.motion.reveal(node.path) }
    )
    if (node.kind === 'file')
      items.push({ id: 'openwith', label: 'Open in default app', icon: <ExternalIcon size={18} />, onSelect: () => void window.motion.openPath(node.path) })
    items.push({ id: 'trash', label: 'Move to Trash', icon: <TrashIcon size={18} />, danger: true, onSelect: () => props.onTrash(node.path) })
    return items
  }

  const rowProps = {
    current,
    unseen: props.unseen,
    expanded,
    renaming,
    dropTarget,
    setDropTarget,
    onOpen: props.onOpen,
    onToggle: props.onToggle,
    onMenu: (node: TreeNode, anchor: AnchorRect) => setMenu({ node, anchor }),
    onNewPage: props.onNewPage,
    onRenameDone: (node: TreeNode, name: string | null) => {
      setRenaming(null)
      if (!name) return
      const clean = name.trim().replace(/[/\\:]/g, '-')
      if (!clean) return
      // pages keep .md; other files keep exactly the name typed
      const next = node.kind === 'file' && isMd(node.name) ? (isMd(clean) ? clean : clean + '.md') : clean
      if (next !== node.name) props.onRename(node.path, joinPath(dirOf(node.path), next))
    },
    onMove: props.onMove
  }

  return (
    <aside className={`sidebar${open ? '' : ' collapsed'}`} style={{ width, ['--sidebar-w' as string]: width + 'px' }}>
      <div className={`sidebar-header${props.fullscreen ? ' fullscreen' : ''}`}>
        <button className="workspace-row" onClick={(e) => setWsMenu(rectOf(e.currentTarget))}>
          <span className="workspace-avatar">{tree.name.slice(0, 1).toUpperCase()}</span>
          <span className="workspace-name">{tree.name}</span>
          <ChevronDown size={14} style={{ color: 'var(--icon)', flexShrink: 0 }} />
        </button>
      </div>
      <div className="sidebar-nav">
        <button className="sidebar-item" onClick={props.onSearch}>
          <SearchIcon size={18} />
          Search
          <span className="kbd">⌘P</span>
        </button>
        <button className="sidebar-item" onClick={() => props.onNewPage(current ? dirOf(current) : root)}>
          <NewPageIcon size={18} />
          New page
          <span className="kbd">⌘N</span>
        </button>
      </div>

      <div className="sidebar-scroll" ref={scrollRef}>
        {favs.length > 0 && (
          <div className="sidebar-section">
            <div className="sidebar-section-title" onClick={() => setSections((s) => ({ ...s, favorites: !s.favorites }))}>
              Favorites
            </div>
            {sections.favorites &&
              favs.map((f) => (
                <FlatRow
                  key={f.path}
                  file={f}
                  selected={f.path === current}
                  icon={<StarFilledIcon size={16} />}
                  unseen={props.unseen.has(f.path)}
                  onOpen={props.onOpen}
                  onMenu={(anchor) => setMenu({ node: asNode(f), anchor })}
                />
              ))}
          </div>
        )}
        <div className="sidebar-section">
          <div className="sidebar-section-title" onClick={() => setSections((s) => ({ ...s, recent: !s.recent }))}>
            Recently edited
          </div>
          {sections.recent &&
            recent.map((f) => (
              <FlatRow
                key={f.path}
                file={f}
                selected={f.path === current}
                icon={<ClockIcon size={16} />}
                unseen={props.unseen.has(f.path)}
                onOpen={props.onOpen}
                onMenu={(anchor) => setMenu({ node: asNode(f), anchor })}
                showDir
              />
            ))}
        </div>
        <div className="sidebar-section tree">
          <div
            className={`sidebar-section-title${dropTarget === root ? ' drop-target' : ''}`}
            onClick={() => setSections((s) => ({ ...s, pages: !s.pages }))}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-motion-path')) {
                e.preventDefault()
                setDropTarget(root)
              }
            }}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => {
              const from = e.dataTransfer.getData('application/x-motion-path')
              setDropTarget(null)
              if (from) props.onMove(from, root)
            }}
          >
            Pages
            <span className="actions">
              <button
                className="icon-button small"
                title="New page"
                onClick={(e) => {
                  e.stopPropagation()
                  props.onNewPage(root)
                }}
              >
                <PlusIcon size={14} />
              </button>
            </span>
          </div>
          {sections.pages &&
            (tree.children.length ? (
              tree.children.map((n) => <TreeRow key={n.path} node={n} depth={0} {...rowProps} />)
            ) : (
              <div className="tree-empty" style={{ paddingLeft: 10 }}>
                No files yet
              </div>
            ))}
        </div>
      </div>


      <div className={`sidebar-resizer${resizing ? ' dragging' : ''}`} onMouseDown={startResize} />

      {menu && <PopoverMenu anchor={menu.anchor} items={itemMenu(menu.node)} onClose={() => setMenu(null)} width={240} />}
      {wsMenu && (
        <PopoverMenu
          anchor={wsMenu}
          onClose={() => setWsMenu(null)}
          width={300}
          items={[
            { id: 'open', label: 'Open folder…', icon: <FolderOpenIcon size={18} />, hint: '⌘O', onSelect: () => props.onOpenFolder() },
            { id: 'window', label: 'New window', icon: <PlusIcon size={18} />, hint: '⇧⌘N', onSelect: () => window.motion.newWindow() },
            { id: 'reveal', label: 'Reveal in Finder', icon: <ExternalIcon size={18} />, onSelect: () => void window.motion.reveal(root) },
            { id: 'allfiles', label: 'Show non-Markdown files', icon: <CodeIcon size={16} />, checked: props.showAllFiles, onSelect: props.onToggleAllFiles },
            { id: 'ignored', label: 'Show gitignored files', icon: <EyeIcon size={16} />, checked: props.showIgnored, onSelect: props.onToggleIgnored },
            ...props.recentRoots
              .filter((r) => r !== root)
              .slice(0, 6)
              .map((r) => ({
                id: 'root:' + r,
                label: baseOf(r),
                hint: r.replace(/^\/Users\/[^/]+/, '~').replace(/\/[^/]+$/, ''),
                section: 'Recent folders',
                icon: <FolderIcon size={18} />,
                onSelect: () => props.onOpenFolder(r)
              }))
          ]}
        />
      )}
    </aside>
  )
}

function FlatRow({
  file,
  selected,
  icon,
  onOpen,
  onMenu,
  showDir,
  unseen
}: {
  file: FileEntry
  selected: boolean
  unseen?: boolean
  icon: React.ReactNode
  onOpen(p: string, opts?: OpenOptions): void
  onMenu(anchor: AnchorRect): void
  showDir?: boolean
}) {
  const dir = file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/')) : ''
  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 8 }}
      onClick={(e) => onOpen(file.path, openOpts(e))}
      onDoubleClick={(e) => !e.metaKey && onOpen(file.path)}
      onAuxClick={(e) => e.button === 1 && onOpen(file.path, openOpts(e))}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu({ left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 })
      }}
      title={file.rel}
    >
      <span className="tree-icon">{icon}</span>
      <span className="tree-label">
        {displayName({ name: file.name, kind: 'file' })}
        {showDir && dir && <span className="tree-dir">{dir}</span>}
      </span>
      {unseen && <span className="unseen-dot" title="Changed outside Motion" />}
      {showDir && <span className="tree-time">{shortAgo(file.mtime)}</span>}
    </div>
  )
}

interface RowProps {
  node: TreeNode
  depth: number
  current: string | null
  unseen: Set<string>
  expanded: Set<string>
  renaming: string | null
  dropTarget: string | null
  setDropTarget(p: string | null): void
  onOpen(path: string, opts?: OpenOptions): void
  onToggle(rel: string, open?: boolean): void
  onMenu(node: TreeNode, anchor: AnchorRect): void
  onNewPage(dir: string): void
  onRenameDone(node: TreeNode, name: string | null): void
  onMove(from: string, toDir: string): void
}

const TreeRow = memo(function TreeRow(p: RowProps) {
  const { node, depth } = p
  const isDir = node.kind === 'dir'
  const isOpen = isDir && p.expanded.has(node.rel)
  const selected = p.current === node.path
  return (
    <>
      <div
        className={`tree-row${isDir ? ' is-dir' : ''}${isOpen ? ' expanded' : ''}${selected ? ' selected' : ''}${p.dropTarget === node.path ? ' drop-target' : ''}${node.ignored ? ' ignored' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-path={node.path}
        title={node.title ? `${node.title}\n${node.rel}` : node.rel}
        draggable={p.renaming !== node.path}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-motion-path', node.path)
          e.dataTransfer.setData('text/plain', node.path)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          if (!isDir || !e.dataTransfer.types.includes('application/x-motion-path')) return
          e.preventDefault()
          p.setDropTarget(node.path)
        }}
        onDragLeave={() => p.dropTarget === node.path && p.setDropTarget(null)}
        onDrop={(e) => {
          const from = e.dataTransfer.getData('application/x-motion-path')
          p.setDropTarget(null)
          if (from && isDir && from !== node.path && !node.path.startsWith(from + '/')) {
            e.preventDefault()
            p.onMove(from, node.path)
          }
        }}
        onClick={(e) => (isDir ? p.onToggle(node.rel) : p.onOpen(node.path, openOpts(e)))}
        onDoubleClick={(e) => !isDir && !e.metaKey && p.onOpen(node.path)}
        onAuxClick={(e) => !isDir && e.button === 1 && p.onOpen(node.path, openOpts(e))}
        onContextMenu={(e) => {
          e.preventDefault()
          p.onMenu(node, { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 })
        }}
      >
        <span
          className="tree-icon"
          onClick={(e) => {
            if (!isDir) return
            e.stopPropagation()
            p.onToggle(node.rel)
          }}
        >
          {isDir ? (
            <>
              <span className="glyph">
                <FolderIcon size={17} />
              </span>
              <span className="chevron">
                <ChevronRight size={16} />
              </span>
            </>
          ) : (
            fileIcon(node.name)
          )}
        </span>
        <span className="tree-label">
          {p.renaming === node.path ? (
            <RenameInput initial={displayName(node)} onDone={(v) => p.onRenameDone(node, v)} />
          ) : (
            displayName(node)
          )}
        </span>
        {!isDir && p.unseen.has(node.path) && <span className="unseen-dot" title="Changed outside Motion" />}
        <span className="row-actions">
          <button
            className="icon-button small"
            title="More"
            onClick={(e) => {
              e.stopPropagation()
              p.onMenu(node, rectOf(e.currentTarget))
            }}
          >
            <MoreIcon size={14} />
          </button>
          {isDir && (
            <button
              className="icon-button small"
              title="New page inside"
              onClick={(e) => {
                e.stopPropagation()
                p.onNewPage(node.path)
              }}
            >
              <PlusIcon size={14} />
            </button>
          )}
        </span>
      </div>
      {isOpen &&
        (node.children.length ? (
          node.children.map((c) => <TreeRow key={c.path} {...p} node={c} depth={depth + 1} />)
        ) : (
          <div className="tree-empty" style={{ paddingLeft: 8 + (depth + 1) * 14 + 28 }}>
            No pages inside
          </div>
        ))}
    </>
  )
})

function RenameInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <input
      ref={ref}
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish((e.target as HTMLInputElement).value)
        if (e.key === 'Escape') finish(null)
      }}
    />
  )
}
