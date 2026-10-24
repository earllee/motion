import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { PopoverMenu, type MenuItemDef } from '@/components/Menu'
import { rectOf, type AnchorRect } from '@/components/Popover'
import { PlusIcon, DragIcon, TrashIcon, ArrowUpIcon, ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon } from '@/components/icons'

interface CellCtx {
  tablePos: number
  table: PMNode
  row: number
  col: number
}

function cellContext(editor: Editor): CellCtx | null {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'table') {
      const rowDepth = d + 1
      const cellDepth = d + 2
      if ($from.depth < cellDepth) return null
      return { tablePos: $from.before(d), table: node, row: $from.index(d), col: $from.index(rowDepth) }
    }
  }
  return null
}

function focusCell(editor: Editor, tablePos: number, row: number, col: number) {
  const table = editor.state.doc.nodeAt(tablePos)
  if (!table) return
  let pos = tablePos + 1
  for (let r = 0; r < Math.min(row, table.childCount - 1); r++) pos += table.child(r).nodeSize
  const rowNode = table.child(Math.min(row, table.childCount - 1))
  pos += 1
  for (let c = 0; c < Math.min(col, rowNode.childCount - 1); c++) pos += rowNode.child(c).nodeSize
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 2))))
}

interface Hover {
  tablePos: number
  bottom: { left: number; top: number; width: number }
  right: { left: number; top: number; height: number }
}

/** Notion-style table affordances: + bars to grow, row/column handles with menus. */
export function TableControls({ editor, container }: { editor: Editor; container: HTMLElement | null }) {
  const [hover, setHover] = useState<Hover | null>(null)
  const [ctx, setCtx] = useState<CellCtx | null>(null)
  const [handles, setHandles] = useState<{ row: { left: number; top: number }; col: { left: number; top: number } } | null>(null)
  const [menu, setMenu] = useState<{ kind: 'row' | 'col'; anchor: AnchorRect; ctx: CellCtx } | null>(null)

  const wrapRect = () => (editor.view.dom.parentElement?.parentElement ?? editor.view.dom).getBoundingClientRect()

  useEffect(() => {
    if (!container) return
    let last: HTMLElement | null = null
    const move = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest?.('.table-add')) return
      let wrapper = t.closest?.('.table-wrapper') as HTMLElement | null
      if (!wrapper && last && last.isConnected) {
        // keep the bars while the pointer travels to them
        const r = last.getBoundingClientRect()
        if (e.clientX >= r.left && e.clientX <= r.right + 28 && e.clientY >= r.top && e.clientY <= r.bottom + 24) wrapper = last
      }
      if (!wrapper || !editor.view.dom.contains(wrapper)) {
        last = null
        setHover(null)
        return
      }
      last = wrapper
      const table = wrapper.querySelector('table')!
      const tr = table.getBoundingClientRect()
      const wr = wrapper.getBoundingClientRect()
      const base = wrapRect()
      const pos = editor.view.posAtDOM(wrapper, 0) - 1
      const right = Math.min(tr.right, wr.right)
      setHover({
        tablePos: pos,
        bottom: { left: tr.left - base.left, top: tr.bottom - base.top + 2, width: right - tr.left },
        right: { left: right - base.left + 2, top: tr.top - base.top, height: tr.height }
      })
    }
    container.addEventListener('mousemove', move)
    return () => container.removeEventListener('mousemove', move)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, editor])

  useEffect(() => {
    const update = () => {
      if (editor.isDestroyed) return
      const c = cellContext(editor)
      setCtx(c)
      if (!c) {
        setHandles(null)
        return
      }
      const tableDom = (editor.view.nodeDOM(c.tablePos) as HTMLElement | null)?.querySelector('table')
      const rowEl = tableDom?.querySelectorAll('tr')[c.row] as HTMLElement | undefined
      const cellEl = rowEl?.children[c.col] as HTMLElement | undefined
      if (!tableDom || !rowEl || !cellEl) return setHandles(null)
      const base = wrapRect()
      const rr = rowEl.getBoundingClientRect()
      const cr = cellEl.getBoundingClientRect()
      const tr = tableDom.getBoundingClientRect()
      setHandles({
        row: { left: tr.left - base.left - 8, top: rr.top - base.top + rr.height / 2 - 12 },
        col: { left: cr.left - base.left + cr.width / 2 - 12, top: tr.top - base.top - 8 }
      })
    }
    editor.on('selectionUpdate', update)
    editor.on('update', update)
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('update', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  const addRow = () => {
    if (!hover) return
    const table = editor.state.doc.nodeAt(hover.tablePos)
    if (!table) return
    focusCell(editor, hover.tablePos, table.childCount - 1, 0)
    editor.chain().focus().addRowAfter().run()
    focusCell(editor, hover.tablePos, table.childCount, 0)
  }
  const addCol = () => {
    if (!hover) return
    const table = editor.state.doc.nodeAt(hover.tablePos)
    if (!table) return
    const cols = table.firstChild?.childCount ?? 1
    focusCell(editor, hover.tablePos, 0, cols - 1)
    editor.chain().focus().addColumnAfter().run()
  }

  const setAlign = (c: CellCtx, align: string | null) => {
    const table = editor.state.doc.nodeAt(c.tablePos)
    if (!table) return
    const tr = editor.state.tr
    let pos = c.tablePos + 1
    table.forEach((row) => {
      let cellPos = pos + 1
      row.forEach((cell, _o, ci) => {
        if (ci === c.col) tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, align })
        cellPos += cell.nodeSize
      })
      pos += row.nodeSize
    })
    editor.view.dispatch(tr)
  }

  const menuItems = (kind: 'row' | 'col', c: CellCtx): MenuItemDef[] => {
    const run = (fn: () => void) => () => {
      focusCell(editor, c.tablePos, c.row, c.col)
      fn()
      editor.view.focus()
    }
    if (kind === 'row') {
      return [
        { id: 'above', label: 'Insert above', icon: <ArrowUpIcon size={16} />, disabled: c.row === 0, onSelect: run(() => editor.commands.addRowBefore()) },
        { id: 'below', label: 'Insert below', icon: <ArrowDownIcon size={16} />, onSelect: run(() => editor.commands.addRowAfter()) },
        { id: 'del', label: 'Delete row', icon: <TrashIcon size={16} />, danger: true, disabled: c.row === 0 && c.table.childCount === 1, onSelect: run(() => editor.commands.deleteRow()) },
        { id: 'deltable', label: 'Delete table', icon: <TrashIcon size={16} />, danger: true, section: 'Table', onSelect: run(() => editor.commands.deleteTable()) }
      ]
    }
    const align = c.table.firstChild?.child(c.col)?.attrs.align ?? null
    return [
      { id: 'left', label: 'Insert left', icon: <ArrowLeftIcon size={16} />, onSelect: run(() => editor.commands.addColumnBefore()) },
      { id: 'right', label: 'Insert right', icon: <ArrowRightIcon size={16} />, onSelect: run(() => editor.commands.addColumnAfter()) },
      { id: 'del', label: 'Delete column', icon: <TrashIcon size={16} />, danger: true, onSelect: run(() => editor.commands.deleteColumn()) },
      { id: 'al', label: 'Align left', section: 'Alignment', checked: align === 'left', onSelect: () => setAlign(c, align === 'left' ? null : 'left') },
      { id: 'ac', label: 'Align center', section: 'Alignment', checked: align === 'center', onSelect: () => setAlign(c, align === 'center' ? null : 'center') },
      { id: 'ar', label: 'Align right', section: 'Alignment', checked: align === 'right', onSelect: () => setAlign(c, align === 'right' ? null : 'right') }
    ]
  }

  return (
    <>
      {hover && (
        <>
          <button
            className="table-add visible"
            style={{ left: hover.bottom.left, top: hover.bottom.top, width: hover.bottom.width, height: 16 }}
            onMouseDown={(e) => (e.preventDefault(), addRow())}
            title="Add a row"
          >
            <PlusIcon size={12} />
          </button>
          <button
            className="table-add visible"
            style={{ left: hover.right.left, top: hover.right.top, width: 16, height: hover.right.height }}
            onMouseDown={(e) => (e.preventDefault(), addCol())}
            title="Add a column"
          >
            <PlusIcon size={12} />
          </button>
        </>
      )}
      {ctx && handles && (
        <>
          <button
            className="table-add visible handle"
            style={{ left: handles.row.left, top: handles.row.top, width: 16, height: 24 }}
            onMouseDown={(e) => {
              e.preventDefault()
              setMenu({ kind: 'row', anchor: rectOf(e.currentTarget), ctx })
            }}
            title="Row options"
          >
            <DragIcon size={12} />
          </button>
          <button
            className="table-add visible handle"
            style={{ left: handles.col.left, top: handles.col.top, width: 24, height: 16 }}
            onMouseDown={(e) => {
              e.preventDefault()
              setMenu({ kind: 'col', anchor: rectOf(e.currentTarget), ctx })
            }}
            title="Column options"
          >
            <span style={{ transform: 'rotate(90deg)', display: 'flex' }}>
              <DragIcon size={12} />
            </span>
          </button>
        </>
      )}
      {menu && (
        <PopoverMenu anchor={menu.anchor} items={menuItems(menu.kind, menu.ctx)} onClose={() => setMenu(null)} width={220} />
      )}
    </>
  )
}
