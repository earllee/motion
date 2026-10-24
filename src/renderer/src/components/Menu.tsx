import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Popover, rectOf, type AnchorRect } from './Popover'
import { ChevronRight, CheckIcon } from './icons'

export interface MenuItemDef {
  id: string
  label: string
  icon?: ReactNode
  hint?: string
  danger?: boolean
  checked?: boolean
  disabled?: boolean
  section?: string
  keywords?: string[]
  submenu?: MenuItemDef[]
  onSelect?: () => void
  /** render a custom row (e.g. a switch) */
  render?: () => ReactNode
}

interface MenuProps {
  items: MenuItemDef[]
  onClose: () => void
  searchable?: boolean
  placeholder?: string
  width?: number
  header?: ReactNode
  footer?: ReactNode
}

export function matches(item: MenuItemDef, q: string): boolean {
  if (!q) return true
  const hay = [item.label, ...(item.keywords || [])].join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t))
}

/** Notion-style menu list: sections, icons, hints, keyboard navigation, submenus. */
export function MenuList({ items, onClose, searchable, placeholder = 'Search actions…', width, header, footer }: MenuProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [sub, setSub] = useState<{ id: string; rect: AnchorRect } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const flat = useMemo(() => {
    if (!query) return items
    // searching flattens submenus so "turn into h2" works directly
    const out: MenuItemDef[] = []
    for (const it of items) {
      if (it.submenu) {
        for (const s of it.submenu) if (matches(s, query) || matches(it, query)) out.push({ ...s, section: it.label })
      } else if (matches(it, query)) out.push(it)
    }
    return out
  }, [items, query])

  const selectable = flat.filter((i) => !i.disabled && !i.render)

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    if (searchable) inputRef.current?.focus()
  }, [searchable])

  const choose = (item: MenuItemDef, el?: HTMLElement | null) => {
    if (item.disabled) return
    if (item.submenu) {
      if (el) setSub({ id: item.id, rect: rectOf(el) })
      return
    }
    onClose()
    item.onSelect?.()
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (sub) return
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        e.preventDefault()
        setActive((a) => (a + 1) % Math.max(1, selectable.length))
      } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        e.preventDefault()
        setActive((a) => (a - 1 + selectable.length) % Math.max(1, selectable.length))
      } else if (e.key === 'Enter' || (e.key === 'ArrowRight' && selectable[active]?.submenu)) {
        e.preventDefault()
        e.stopPropagation()
        const item = selectable[active]
        if (item) choose(item, listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(item.id)}"]`))
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.menu-item.active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  let lastSection: string | undefined
  const subItems = sub ? items.find((i) => i.id === sub.id)?.submenu : null

  return (
    <div className="menu" style={{ width }} ref={listRef}>
      {header}
      {searchable && (
        <div className="menu-search">
          <input
            ref={inputRef}
            value={query}
            placeholder={placeholder}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
      )}
      {flat.length === 0 && <div className="menu-empty">No results</div>}
      {flat.map((item, i) => {
        const showSection = item.section && item.section !== lastSection
        lastSection = item.section
        const idx = selectable.indexOf(item)
        return (
          <div key={item.id + i}>
            {showSection && (i > 0 ? <div className="menu-sep" /> : null)}
            {showSection && <div className="menu-section">{item.section}</div>}
            {item.render ? (
              item.render()
            ) : (
              <button
                data-id={item.id}
                className={`menu-item${idx === active ? ' active' : ''}${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`}
                onMouseEnter={(e) => {
                  setActive(idx)
                  if (item.submenu) setSub({ id: item.id, rect: rectOf(e.currentTarget) })
                  else if (sub) setSub(null)
                }}
                onClick={(e) => choose(item, e.currentTarget)}
              >
                {item.icon && <span className="menu-icon">{item.icon}</span>}
                <span className="menu-label">{item.label}</span>
                {item.hint && <span className="menu-hint">{item.hint}</span>}
                {item.checked && (
                  <span className="menu-check">
                    <CheckIcon size={16} />
                  </span>
                )}
                {item.submenu && (
                  <span className="menu-hint">
                    <ChevronRight size={14} />
                  </span>
                )}
              </button>
            )}
          </div>
        )
      })}
      {footer}
      {sub && subItems && (
        <Popover anchor={sub.rect} placement="right-start" offsetPx={2} onClose={() => setSub(null)} ignore={(t) => !!listRef.current?.contains(t)}>
          <MenuList
            items={subItems}
            onClose={() => {
              setSub(null)
              onClose()
            }}
          />
        </Popover>
      )}
    </div>
  )
}

export function PopoverMenu(props: MenuProps & { anchor: AnchorRect; placement?: import('@floating-ui/dom').Placement }) {
  const { anchor, placement, ...rest } = props
  return (
    <Popover anchor={anchor} placement={placement} onClose={rest.onClose}>
      <MenuList {...rest} />
    </Popover>
  )
}
