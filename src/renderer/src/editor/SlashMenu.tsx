import { useEffect, useRef } from 'react'
import { useStore } from '@/store'
import { Popover, rectOf } from '@/components/Popover'
import { slashStore } from './extensions/slash'
import { mentionStore } from './extensions/pageMention'
import { PageIcon } from '@/components/icons'

export function SlashMenu() {
  const s = useStore(slashStore)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.querySelector('.slash-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [s.active, s.open])

  if (!s.open || !s.rect || !s.items.length) return null
  let lastSection = ''
  return (
    <Popover anchor={rectOf(s.rect)} placement="bottom-start" offsetPx={6} closeOnEscape={false}>
      <div className="slash-menu" ref={listRef}>
        {s.items.map((item, i) => {
          const header = !s.query && item.section !== lastSection
          lastSection = item.section
          return (
            <div key={item.id}>
              {header && <div className="menu-section">{s.query ? 'Results' : item.section}</div>}
              <div
                className={`slash-item${i === s.active ? ' active' : ''}`}
                onMouseMove={() => i !== s.active && slashStore.set((x) => ({ ...x, active: i }))}
                onMouseDown={(e) => {
                  e.preventDefault()
                  s.command?.(item)
                }}
              >
                <span className="slash-icon">{item.icon}</span>
                <span className="slash-text">
                  <div className="slash-title">{item.title}</div>
                </span>
                {item.hint && <span className="slash-hint">{item.hint}</span>}
              </div>
            </div>
          )
        })}
        <div className="slash-footer">
          <span>Type '/' on the page</span>
          <span>esc</span>
        </div>
      </div>
    </Popover>
  )
}

export function MentionMenu() {
  const s = useStore(mentionStore)
  if (!s.open || !s.rect || !s.items.length) return null
  return (
    <Popover anchor={rectOf(s.rect)} placement="bottom-start" offsetPx={6} closeOnEscape={false}>
      <div className="slash-menu" style={{ width: 360 }}>
        <div className="menu-section">{s.mode === 'wiki' ? 'Wiki link to page' : 'Link to page'}</div>
        {s.items.map((item, i) => (
          <div
            key={item.file.path}
            className={`slash-item${i === s.active ? ' active' : ''}`}
            onMouseMove={() => i !== s.active && mentionStore.set((x) => ({ ...x, active: i }))}
            onMouseDown={(e) => {
              e.preventDefault()
              s.command?.(item)
            }}
          >
            <span className="slash-icon">
              <PageIcon size={18} />
            </span>
            <span className="slash-text">
              <div className="slash-title">{item.label}</div>
              <div className="slash-hint" style={{ fontFamily: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.file.rel}
              </div>
            </span>
          </div>
        ))}
      </div>
    </Popover>
  )
}
