import { useState } from 'react'
import { PlusIcon, CloseIcon, ChevronLeft, ChevronRight, SidebarIcon } from './icons'

export interface TabView {
  id: number
  title: string
  path: string | null
  /** shown in italics; replaced by the next sidebar click */
  preview?: boolean
}

interface Props {
  tabs: TabView[]
  activeId: number | null
  fullscreen: boolean
  sidebarOpen: boolean
  canBack: boolean
  canForward: boolean
  onToggleSidebar(): void
  onBack(): void
  onForward(): void
  onSelect(id: number): void
  onPin(id: number): void
  onClose(id: number): void
  onNew(): void
  onMove(id: number, toIndex: number): void
  onDropPath(path: string, index: number): void
  onMenu(id: number): void
}

/** Notion-desktop style tab strip across the top of the window. */
export function Tabbar(props: Props) {
  const { tabs, activeId, fullscreen, sidebarOpen, onSelect, onPin, onClose, onNew, onMove, onDropPath, onMenu } = props
  const [dropAt, setDropAt] = useState<number | null>(null)

  const indexFromEvent = (e: React.DragEvent, i: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return e.clientX < r.left + r.width / 2 ? i : i + 1
  }
  const accepts = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('application/x-motion-tab') || e.dataTransfer.types.includes('application/x-motion-path')
  const drop = (e: React.DragEvent, index: number) => {
    setDropAt(null)
    const tab = e.dataTransfer.getData('application/x-motion-tab')
    const path = e.dataTransfer.getData('application/x-motion-path')
    if (tab) onMove(Number(tab), index)
    else if (path && /\.(md|markdown)$/i.test(path)) onDropPath(path, index)
  }

  return (
    <div className={`tabbar${fullscreen ? ' fullscreen' : ''}${sidebarOpen ? '' : ' no-sidebar'}`}>
      <div className="tabbar-nav">
        <button className="nav-button" title={sidebarOpen ? 'Close sidebar (⌘\\)' : 'Open sidebar (⌘\\)'} onClick={props.onToggleSidebar}>
          <SidebarIcon size={18} />
        </button>
        <button className="nav-button" title="Back (⌘[)" disabled={!props.canBack} onClick={props.onBack}>
          <ChevronLeft size={18} />
        </button>
        <button className="nav-button" title="Forward (⌘])" disabled={!props.canForward} onClick={props.onForward}>
          <ChevronRight size={18} />
        </button>
      </div>
      <div
        className="tabs"
        onDragOver={(e) => {
          if (!accepts(e)) return
          e.preventDefault()
          if (e.target === e.currentTarget) setDropAt(tabs.length)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null)
        }}
        onDrop={(e) => {
          if (e.target === e.currentTarget) drop(e, tabs.length)
        }}
      >
        {tabs.map((t, i) => {
          const active = t.id === activeId
          return (
            <div
              key={t.id}
              className={`tab${active ? ' active' : ''}${t.preview ? ' preview' : ''}${i === tabs.length - 1 ? ' last' : ''}${dropAt === i ? ' drop-before' : ''}${dropAt === i + 1 && i === tabs.length - 1 ? ' drop-after' : ''}`}
              title={t.path ? (t.preview ? `${t.path}\nPreview — double-click to keep open` : t.path) : 'New tab'}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-motion-tab', String(t.id))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (!accepts(e)) return
                e.preventDefault()
                setDropAt(indexFromEvent(e, i))
              }}
              onDrop={(e) => {
                e.stopPropagation()
                drop(e, indexFromEvent(e, i))
              }}
              onDragEnd={() => setDropAt(null)}
              onMouseDown={(e) => {
                if (e.button === 0) onSelect(t.id)
              }}
              onDoubleClick={() => onPin(t.id)}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(t.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                onMenu(t.id)
              }}
            >
              <span className="tab-title">{t.title}</span>
              <button
                className="tab-close"
                title="Close tab (⌘W)"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.id)
                }}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          )
        })}
        <button className="tab-new" title="New tab (⌘T)" onClick={onNew}>
          <PlusIcon size={17} />
        </button>
        <div className="tabbar-fill" onDoubleClick={onNew} />
      </div>
    </div>
  )
}
