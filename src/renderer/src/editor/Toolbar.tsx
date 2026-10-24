import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { getMarkRange } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { createStore, useStore } from '@/store'
import { Popover, rectOf, type AnchorRect } from '@/components/Popover'
import { PopoverMenu } from '@/components/Menu'
import { ChevronDown, LinkIcon, PageIcon, CopyIcon, TrashIcon, ExternalIcon, CodeIcon } from '@/components/icons'
import { currentBlock, kindOf, type BlockKind } from './blocks'
import { turnSelection } from './blockSelection'
import { TURN_INTO, KIND_LABEL } from './turnInto'
import { linkHoverStore } from './extensions/links'
import { api, dirOf, relativePath } from '@/api'
import type { FileEntry } from '@shared/types'
import { CALLOUT_ICONS, CALLOUT_LABELS } from './views/domViews'

export interface LinkEditState {
  anchor: AnchorRect
  from: number
  to: number
  href: string
}

export const linkEditStore = createStore<LinkEditState | null>(null)
export const calloutMenuStore = createStore<{ pos: number; anchor: AnchorRect } | null>(null)

/** Open the link editor for the selection, or for the link under the caret. */
export function openLinkEditor(editor: Editor) {
  const { state, view } = editor
  let { from, to } = state.selection
  let href = ''
  const linkType = state.schema.marks.link
  if (from === to) {
    const range = getMarkRange(state.selection.$from, linkType)
    if (!range) return
    from = range.from
    to = range.to
  }
  state.doc.nodesBetween(from, to, (n) => {
    const m = n.marks.find((x) => x.type === linkType)
    if (m && !href) href = m.attrs.href
  })
  const start = view.coordsAtPos(from)
  const end = view.coordsAtPos(to)
  linkEditStore.set({
    anchor: { left: start.left, top: start.top, right: end.right, bottom: end.bottom, width: end.right - start.left, height: end.bottom - start.top },
    from,
    to,
    href
  })
}

function MarkButton({ on, title, onClick, children }: { on: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={`bubble-button${on ? ' on' : ''}`}
      title={title}
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

export function BubbleToolbar({ editor }: { editor: Editor }) {
  const [turnMenu, setTurnMenu] = useState<AnchorRect | null>(null)
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e || e.isDestroyed) return null
      const info = currentBlock(e.state)
      const parent = info ? e.state.doc.resolve(info.pos).parent : null
      return {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        strike: e.isActive('strike'),
        code: e.isActive('code'),
        link: e.isActive('link'),
        kind: info ? kindOf(info.node, parent) : null
      }
    }
  })
  if (!st) return null

  return (
    <>
      <BubbleMenu
        editor={editor}
        options={{ placement: 'top-start', offset: 8, flip: true, shift: { padding: 8 } }}
        shouldShow={({ editor: e, state, from, to }) => {
          if (!e.isEditable || from === to) return false
          if (state.selection instanceof NodeSelection) return false
          if (!(state.selection instanceof TextSelection)) return false
          if (state.selection.$from.parent.type.spec.code) return false
          if (linkEditStore.get()) return false
          const text = state.doc.textBetween(from, to, ' ')
          return text.trim().length > 0
        }}
      >
        <div className="bubble">
          <button
            className="bubble-button"
            onMouseDown={(e) => {
              e.preventDefault()
              setTurnMenu(rectOf(e.currentTarget))
            }}
          >
            {st.kind ? KIND_LABEL[st.kind] : 'Text'}
            <ChevronDown size={12} className="chev" />
          </button>
          <div className="bubble-sep" />
          <button
            className={`bubble-button${st.link ? ' on' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault()
              openLinkEditor(editor)
            }}
          >
            <LinkIcon size={16} />
            Link
          </button>
          <div className="bubble-sep" />
          <MarkButton on={st.bold} title="Bold ⌘B" onClick={() => editor.chain().focus().toggleBold().run()}>
            <b style={{ fontWeight: 700 }}>B</b>
          </MarkButton>
          <MarkButton on={st.italic} title="Italic ⌘I" onClick={() => editor.chain().focus().toggleItalic().run()}>
            <i style={{ fontFamily: 'Georgia, serif', fontSize: 15 }}>i</i>
          </MarkButton>
          <MarkButton on={st.strike} title="Strikethrough ⌘⇧S" onClick={() => editor.chain().focus().toggleStrike().run()}>
            <s>S</s>
          </MarkButton>
          <MarkButton on={st.code} title="Inline code ⌘E" onClick={() => editor.chain().focus().toggleCode().run()}>
            <CodeIcon size={16} />
          </MarkButton>
        </div>
      </BubbleMenu>
      {turnMenu && (
        <PopoverMenu
          anchor={turnMenu}
          onClose={() => setTurnMenu(null)}
          width={220}
          items={TURN_INTO.map((t) => ({
            id: t.kind,
            label: t.label,
            icon: t.icon,
            checked: st.kind === t.kind,
            section: 'Turn into',
            onSelect: () => {
              turnSelection(editor.view, t.kind as BlockKind)
              editor.view.focus()
            }
          }))}
        />
      )}
    </>
  )
}

/** "Paste link or search pages" popover, like Notion's ⌘K. */
export function LinkEditor({ editor, files, docPath }: { editor: Editor; files: FileEntry[]; docPath: string }) {
  const st = useStore(linkEditStore)
  const [value, setValue] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (st) {
      setValue(st.href)
      setActive(0)
      setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [st])

  const results = useMemo(() => {
    const q = value.trim().toLowerCase()
    if (!q || /^(https?:|mailto:|\/|\.\/|\.\.\/|#)/.test(q)) return []
    return files
      .filter((f) => (f.title || f.name).toLowerCase().includes(q) || f.rel.toLowerCase().includes(q))
      .slice(0, 8)
  }, [value, files])

  if (!st) return null
  const close = () => {
    linkEditStore.set(null)
    editor.view.focus()
  }
  const apply = (href: string) => {
    const tr = editor.state.tr
    const type = editor.state.schema.marks.link
    tr.removeMark(st.from, st.to, type)
    if (href) tr.addMark(st.from, st.to, type.create({ href }))
    tr.setSelection(TextSelection.create(tr.doc, st.to))
    editor.view.dispatch(tr)
    close()
  }
  const linkTo = (f: FileEntry) => {
    apply(relativePath(dirOf(docPath), f.path))
  }

  return (
    <Popover anchor={st.anchor} placement="bottom-start" onClose={close}>
      <div className="link-editor">
        <input
          ref={inputRef}
          value={value}
          placeholder="Paste link or search pages"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (results[active]) linkTo(results[active])
              else apply(value.trim())
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            }
          }}
        />
        {results.length > 0 && (
          <div className="results">
            <div className="menu-section" style={{ padding: '6px 6px 4px' }}>
              Link to page
            </div>
            {results.map((f, i) => (
              <button
                key={f.path}
                className={`menu-item${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => linkTo(f)}
              >
                <span className="menu-icon">
                  <PageIcon size={16} />
                </span>
                <span className="menu-label">{f.title || f.name.replace(/\.md$/, '')}</span>
                <span className="result-path">{f.rel}</span>
              </button>
            ))}
          </div>
        )}
        {st.href && (
          <div className="results">
            <button className="menu-item danger" onClick={() => apply('')}>
              <span className="menu-icon">
                <TrashIcon size={16} />
              </span>
              <span className="menu-label">Remove link</span>
            </button>
          </div>
        )}
      </div>
    </Popover>
  )
}

export function LinkHoverCard({ editor, onOpen }: { editor: Editor; onOpen: (href: string) => void }) {
  const hover = useStore(linkHoverStore)
  const editing = useStore(linkEditStore)
  if (!hover || editing) return null
  const close = () => linkHoverStore.set(null)
  return (
    <Popover anchor={rectOf(hover.rect)} placement="bottom-start" offsetPx={4} onClose={close}>
      <div className="link-hover" onMouseLeave={close}>
        <span className="url" title={hover.href}>
          {hover.href}
        </span>
        <button className="icon-button" title="Open" onClick={() => (close(), onOpen(hover.href))}>
          <ExternalIcon size={16} />
        </button>
        <button className="icon-button" title="Copy link" onClick={() => (close(), void api.copyText(hover.href))}>
          <CopyIcon size={16} />
        </button>
        <button
          className="icon-button"
          title="Edit link"
          onClick={() => {
            close()
            editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, hover.from, hover.to)))
            openLinkEditor(editor)
          }}
        >
          <LinkIcon size={16} />
        </button>
        <button
          className="icon-button"
          title="Remove link"
          onClick={() => {
            close()
            editor.view.dispatch(editor.state.tr.removeMark(hover.from, hover.to, editor.state.schema.marks.link))
          }}
        >
          <TrashIcon size={16} />
        </button>
      </div>
    </Popover>
  )
}

export function CalloutKindMenu({ editor }: { editor: Editor }) {
  const st = useStore(calloutMenuStore)
  if (!st) return null
  const node = editor.state.doc.nodeAt(st.pos)
  if (!node || node.type.name !== 'callout') return null
  return (
    <PopoverMenu
      anchor={st.anchor}
      onClose={() => calloutMenuStore.set(null)}
      width={200}
      items={Object.keys(CALLOUT_ICONS).map((k) => ({
        id: k,
        label: CALLOUT_LABELS[k],
        icon: <span style={{ fontSize: 16 }}>{CALLOUT_ICONS[k]}</span>,
        checked: node.attrs.kind === k,
        section: 'Callout type',
        onSelect: () => {
          editor.view.dispatch(editor.state.tr.setNodeMarkup(st.pos, undefined, { ...node.attrs, kind: k }))
          editor.view.focus()
        }
      }))}
    />
  )
}
