import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { Fragment } from '@tiptap/pm/model'
import { PlusIcon, DragIcon, TrashIcon, DuplicateIcon, TurnIntoIcon, ArrowUpIcon, ArrowDownIcon, CopyIcon, CalloutIcon } from '@/components/icons'
import { PopoverMenu, type MenuItemDef } from '@/components/Menu'
import { Tooltip, rectOf, type AnchorRect } from '@/components/Popover'
import {
  blockAt,
  deleteBlock,
  duplicateBlock,
  kindOf,
  moveBlock,
  turnInto,
  insertParagraphAfter,
  type BlockInfo,
  type BlockKind
} from './blocks'
import { serializeFragment } from './markdown/serialize'
import { api } from '@/api'
import { TURN_INTO } from './turnInto'
import { CALLOUT_ICONS, CALLOUT_LABELS } from './views/domViews'
import { dropLineStore, blockDrag } from './extensions/blockDrop'
import { BlockRangeSelection, turnSelection } from './blockSelection'

/**
 * While a block drag is near (or past) the top/bottom of the page's scroller, scroll it,
 * faster the closer to the edge, so blocks can travel anywhere in a long page.
 */
function startAutoScroll(scroller: HTMLElement | null): () => void {
  if (!scroller) return () => {}
  const EDGE = 80
  const MAX = 22
  let y: number | null = null
  let last = 0
  const tick = () => {
    if (y === null) return
    const now = performance.now()
    // scroll by elapsed time, so the timer and dragover events can both drive it
    const dt = Math.min(64, now - (last || now - 16)) / 16
    last = now
    const r = scroller.getBoundingClientRect()
    const top = Math.max(r.top, 0) + EDGE
    const bottom = Math.min(r.bottom, window.innerHeight) - EDGE
    const speed = y < top ? -Math.min(1, (top - y) / EDGE) : y > bottom ? Math.min(1, (y - bottom) / EDGE) : 0
    if (speed) scroller.scrollTop += Math.sign(speed) * Math.max(1, Math.round(speed * speed * MAX * dt))
  }
  const onOver = (e: DragEvent) => {
    y = e.clientY
    tick()
  }
  document.addEventListener('dragover', onOver)
  // a timer, not rAF: animation frames can stall during a native drag
  const timer = setInterval(tick, 16)
  return () => {
    clearInterval(timer)
    document.removeEventListener('dragover', onOver)
  }
}

// dragging shows only the drop line, so the drag image is an invisible pixel
const emptyDragImage = new Image()
emptyDragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
import { useStore } from '@/store'

interface Hover {
  pos: number
  top: number
  left: number
  rect: DOMRect
}

function firstLineCenter(dom: HTMLElement): number {
  const rect = dom.getBoundingClientRect()
  if (dom.matches('hr')) return rect.top + rect.height / 2
  if (dom.matches('.code-block, .table-wrapper, pre, .react-renderer') || dom.querySelector(':scope > .code-block'))
    return rect.top + 16
  const text = dom.matches('p,h1,h2,h3,h4,h5,h6')
    ? dom
    : Array.from(dom.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,h5,h6')).find((el) => !el.closest('.mermaid-preview'))
  if (!text) return rect.top + 15
  const cs = getComputedStyle(text)
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
  const pt = parseFloat(cs.paddingTop) || 0
  return text.getBoundingClientRect().top + pt + lh / 2
}

/** Notion's hover handle: ＋ adds a block below, ⋮⋮ drags or opens the block menu. */
export function BlockHandle({ editor, container }: { editor: Editor; container: HTMLElement | null }) {
  const [hover, setHover] = useState<Hover | null>(null)
  const [visible, setVisible] = useState(false)
  const [menu, setMenu] = useState<{ anchor: AnchorRect; pos: number } | null>(null)
  const [tip, setTip] = useState<{ anchor: AnchorRect; kind: 'plus' | 'drag' } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const stopScroll = useRef<() => void>(() => {})
  const menuOpen = useRef(false)
  menuOpen.current = !!menu
  const dropLine = useStore(dropLineStore)

  const locate = useCallback(
    (clientX: number, clientY: number): Hover | null => {
      if (editor.isDestroyed) return null
      const view = editor.view
      const er = view.dom.getBoundingClientRect()
      if (clientY < er.top - 4 || clientY > er.bottom + 4) return null
      const x = Math.min(Math.max(clientX, er.left + 6), er.right - 6)
      const found = view.posAtCoords({ left: x, top: clientY })
      if (!found) return null
      let info: BlockInfo | null = null
      if (found.inside >= 0) {
        const n = view.state.doc.nodeAt(found.inside)
        if (n && n.isBlock && n.isAtom) info = { pos: found.inside, node: n, depth: 1 }
      }
      if (!info) info = blockAt(view.state.doc, found.pos)
      if (!info) return null
      const dom = view.nodeDOM(info.pos) as HTMLElement | null
      if (!dom || !(dom instanceof HTMLElement)) return null
      const wrap = wrapRef.current?.parentElement
      if (!wrap) return null
      const wr = wrap.getBoundingClientRect()
      const rect = dom.getBoundingClientRect()
      const center = firstLineCenter(dom)
      return { pos: info.pos, top: center - wr.top - 12, left: rect.left - wr.left - 46, rect }
    },
    [editor]
  )

  useEffect(() => {
    if (!container) return
    const move = (e: MouseEvent) => {
      if (menuOpen.current || dragging.current) return
      if ((e.target as HTMLElement).closest?.('.block-handle')) return
      const h = locate(e.clientX, e.clientY)
      if (h) {
        setHover(h)
        setVisible(true)
      } else setVisible(false)
    }
    const leave = () => {
      if (!menuOpen.current && !dragging.current) setVisible(false)
    }
    const typing = () => {
      if (!menuOpen.current) setVisible(false)
    }
    container.addEventListener('mousemove', move)
    container.addEventListener('mouseleave', leave)
    const dom = editor.view.dom
    dom.addEventListener('keydown', typing)
    return () => {
      container.removeEventListener('mousemove', move)
      container.removeEventListener('mouseleave', leave)
      dom.removeEventListener('keydown', typing)
    }
  }, [container, editor, locate])

  // keep the handle glued to its block while the doc changes underneath
  useEffect(() => {
    const update = () => {
      if (!hover || editor.isDestroyed) return
      const node = editor.state.doc.nodeAt(hover.pos)
      if (!node) setVisible(false)
    }
    editor.on('update', update)
    return () => {
      editor.off('update', update)
    }
  }, [editor, hover])

  const line = dropLine && <div className="drop-line" style={{ top: dropLine.top, left: dropLine.left, width: dropLine.width }} />
  if (!hover) return <div ref={wrapRef} style={{ display: 'none' }} />

  const info = (): BlockInfo | null => {
    const node = editor.state.doc.nodeAt(hover.pos)
    if (!node) return null
    return { pos: hover.pos, node, depth: editor.state.doc.resolve(hover.pos).depth + 1 }
  }

  const onPlus = (e: React.MouseEvent) => {
    e.preventDefault()
    const b = info()
    if (!b) return
    const view = editor.view
    const isEmptyPara = b.node.type.name === 'paragraph' && b.node.content.size === 0
    if (isEmptyPara) {
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, b.pos + 1)).insertText('/')
      view.dispatch(tr)
    } else if (e.altKey) {
      const tr = view.state.tr.insert(b.pos, view.state.schema.nodes.paragraph.create(null, view.state.schema.text('/')))
      tr.setSelection(TextSelection.create(tr.doc, b.pos + 2))
      view.dispatch(tr)
    } else {
      view.dispatch(insertParagraphAfter(view.state, b, '/'))
    }
    view.focus()
    setVisible(false)
  }

  const onDragStart = (e: React.DragEvent) => {
    const b = info()
    if (!b) return
    const view = editor.view
    dragging.current = true
    document.body.classList.add('block-dragging')
    setTip(null)
    // dragging a block inside a selected run moves the whole run
    const current = view.state.selection
    const run = current instanceof BlockRangeSelection && b.pos >= current.from && b.pos < current.to ? current : null
    const sel = run ?? NodeSelection.create(view.state.doc, b.pos)
    if (!run) view.dispatch(view.state.tr.setSelection(sel))
    const slice = sel.content()
    const { dom, text } = view.serializeForClipboard(slice)
    e.dataTransfer.clearData()
    e.dataTransfer.setData('text/html', dom.innerHTML)
    e.dataTransfer.setData('text/plain', text)
    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setDragImage(emptyDragImage, 0, 0)
    blockDrag.current = {
      from: sel.from,
      to: sel.to,
      nodes: run ? run.blocks().map((x) => x.node) : [(sel as NodeSelection).node]
    }
    ;(view as unknown as { dragging: unknown }).dragging = { slice, move: true }
    stopScroll.current = startAutoScroll(view.dom.closest<HTMLElement>('.scroller'))
  }

  const onDragEnd = () => {
    stopScroll.current()
    stopScroll.current = () => {}
    blockDrag.current = null
    document.body.classList.remove('block-dragging')
    dropLineStore.set(null)
    dragging.current = false
    setVisible(false)
  }

  const openMenu = (e: React.MouseEvent) => {
    const b = info()
    if (!b) return
    const view = editor.view
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, b.pos)))
    view.focus()
    setTip(null)
    setMenu({ anchor: rectOf(e.currentTarget), pos: b.pos })
  }

  return (
    <>
      {line}
      <div
        ref={wrapRef}
        className={`block-handle${visible || menu ? ' visible' : ''}`}
        style={{ top: hover.top, left: hover.left }}
      >
        <button
          onMouseDown={onPlus}
          onMouseEnter={(e) => setTip({ anchor: rectOf(e.currentTarget), kind: 'plus' })}
          onMouseLeave={() => setTip(null)}
          aria-label="Add block"
        >
          <PlusIcon size={18} />
        </button>
        <button
          className="drag"
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onClick={openMenu}
          onMouseEnter={(e) => setTip({ anchor: rectOf(e.currentTarget), kind: 'drag' })}
          onMouseLeave={() => setTip(null)}
          aria-label="Drag to move, click for options"
        >
          <DragIcon size={18} />
        </button>
      </div>
      {tip && !menu && (
        <Tooltip anchor={tip.anchor}>
          {tip.kind === 'plus' ? (
            <>
              <div>Click to add below</div>
              <div className="sub">Option-click to add above</div>
            </>
          ) : (
            <>
              <div>Drag to move</div>
              <div className="sub">Click to open menu</div>
            </>
          )}
        </Tooltip>
      )}
      {menu && (
        <BlockMenu
          editor={editor}
          pos={menu.pos}
          anchor={menu.anchor}
          onClose={() => {
            setMenu(null)
            setVisible(false)
          }}
        />
      )}
    </>
  )
}

export function BlockMenu({
  editor,
  pos,
  anchor,
  onClose
}: {
  editor: Editor
  pos: number
  anchor: AnchorRect
  onClose: () => void
}) {
  const node = editor.state.doc.nodeAt(pos)
  if (!node) return null
  const $pos = editor.state.doc.resolve(pos)
  const b: BlockInfo = { pos, node, depth: $pos.depth + 1 }
  const current = kindOf(node, $pos.parent)
  const run = (fn: () => void) => () => {
    fn()
    editor.view.focus()
  }
  const items: MenuItemDef[] = [
    {
      id: 'turn',
      label: 'Turn into',
      icon: <TurnIntoIcon size={18} />,
      keywords: ['convert', 'change'],
      submenu: TURN_INTO.map((t) => ({
        id: 'turn-' + t.kind,
        label: t.label,
        icon: t.icon,
        keywords: t.keywords,
        checked: current === t.kind,
        onSelect: run(() => {
          const sel = editor.state.selection
          // the handle of a block inside a multi-block selection turns the whole selection
          if (sel instanceof BlockRangeSelection && pos >= sel.from && pos < sel.to) return void turnSelection(editor.view, t.kind as BlockKind)
          const fresh = editor.state.doc.nodeAt(pos)
          if (!fresh) return
          const tr = turnInto(editor.state, { pos, node: fresh, depth: b.depth }, t.kind as BlockKind)
          if (tr) editor.view.dispatch(tr.scrollIntoView())
        })
      }))
    }
  ]
  if (node.type.name === 'callout') {
    items.push({
      id: 'callout-kind',
      label: 'Callout type',
      icon: <CalloutIcon size={18} />,
      submenu: Object.keys(CALLOUT_ICONS).map((k) => ({
        id: 'ck-' + k,
        label: CALLOUT_LABELS[k],
        icon: <span>{CALLOUT_ICONS[k]}</span>,
        checked: node.attrs.kind === k,
        onSelect: run(() => editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, kind: k })))
      }))
    })
  }
  items.push(
    {
      id: 'duplicate',
      label: 'Duplicate',
      hint: '⌘D',
      icon: <DuplicateIcon size={18} />,
      keywords: ['copy', 'clone'],
      onSelect: run(() => editor.view.dispatch(duplicateBlock(editor.state, b)))
    },
    {
      id: 'up',
      label: 'Move up',
      hint: '⌘⇧↑',
      icon: <ArrowUpIcon size={18} />,
      onSelect: run(() => {
        const tr = moveBlock(editor.state, b, -1)
        if (tr) editor.view.dispatch(tr)
      })
    },
    {
      id: 'down',
      label: 'Move down',
      hint: '⌘⇧↓',
      icon: <ArrowDownIcon size={18} />,
      onSelect: run(() => {
        const tr = moveBlock(editor.state, b, 1)
        if (tr) editor.view.dispatch(tr)
      })
    },
    {
      id: 'copy-md',
      label: 'Copy as Markdown',
      icon: <CopyIcon size={18} />,
      keywords: ['clipboard', 'markdown'],
      onSelect: () => void api.copyText(serializeFragment([wrapForCopy(editor, b)]))
    },
    {
      id: 'delete',
      label: 'Delete',
      hint: 'Del',
      icon: <TrashIcon size={18} />,
      danger: true,
      keywords: ['remove'],
      onSelect: run(() => editor.view.dispatch(deleteBlock(editor.state, b)))
    }
  )
  return <PopoverMenu anchor={anchor} placement="left-start" items={items} onClose={onClose} searchable width={265} />
}

/** List items need their list to serialize meaningfully. */
function wrapForCopy(editor: Editor, b: BlockInfo) {
  const $pos = editor.state.doc.resolve(b.pos)
  if (b.node.type.name === 'listItem' || b.node.type.name === 'taskItem') return $pos.parent.copy(Fragment.from(b.node))
  return b.node
}
