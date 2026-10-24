import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { computePosition, flip, shift, offset, type Placement } from '@floating-ui/dom'

export interface AnchorRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export function rectOf(el: Element | DOMRect | AnchorRect): AnchorRect {
  const r = el instanceof Element ? el.getBoundingClientRect() : el
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}

interface PopoverProps {
  anchor: AnchorRect
  placement?: Placement
  offsetPx?: number
  onClose?: () => void
  children: ReactNode
  className?: string
  style?: CSSProperties
  /** don't close on outside clicks inside these elements */
  ignore?: (target: Node) => boolean
  closeOnEscape?: boolean
}

/** A floating panel anchored to a rect, rendered in a portal, closing on outside click/Esc. */
export function Popover({
  anchor,
  placement = 'bottom-start',
  offsetPx = 4,
  onClose,
  children,
  className = '',
  style,
  ignore,
  closeOnEscape = true
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const virtual = {
      getBoundingClientRect: () => ({ ...anchor, x: anchor.left, y: anchor.top }) as DOMRect
    }
    let cancelled = false
    void computePosition(virtual, el, {
      placement,
      strategy: 'fixed',
      middleware: [offset(offsetPx), flip({ padding: 8 }), shift({ padding: 8 })]
    }).then(({ x, y }) => {
      if (!cancelled) setPos({ x, y })
    })
    return () => {
      cancelled = true
    }
  }, [anchor.left, anchor.top, anchor.width, anchor.height, placement, offsetPx])

  useEffect(() => {
    if (!onClose) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      // clicks inside a nested popover (submenus) belong to this one too
      if (t instanceof Element && t.closest('.popover')) return
      if (ignore?.(t)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEscape) {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose, ignore, closeOnEscape])

  return createPortal(
    <div
      ref={ref}
      className={`popover ${className}`}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? 'visible' : 'hidden', ...style }}
      onMouseDown={(e) => {
        // keep editor focus/selection while clicking inside menus
        if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault()
      }}
    >
      {children}
    </div>,
    document.body
  )
}

export function Tooltip({ anchor, children }: { anchor: AnchorRect; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const virtual = { getBoundingClientRect: () => ({ ...anchor, x: anchor.left, y: anchor.top }) as DOMRect }
    void computePosition(virtual, el, {
      placement: 'bottom',
      strategy: 'fixed',
      middleware: [offset(6), flip(), shift({ padding: 6 })]
    }).then(({ x, y }) => setPos({ x, y }))
  }, [anchor.left, anchor.top])
  return createPortal(
    <div ref={ref} className="tooltip" style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}>
      {children}
    </div>,
    document.body
  )
}
