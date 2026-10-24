import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView, NodeView, ViewMutationRecord } from '@tiptap/pm/view'
import { Selection, TextSelection } from '@tiptap/pm/state'
import { assetUrl, dirOf, resolvePath } from '@/api'

export const CALLOUT_ICONS: Record<string, string> = {
  note: '💡',
  tip: '✅',
  important: '📌',
  warning: '⚠️',
  caution: '🚨'
}

export const CALLOUT_LABELS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution'
}

const TRIANGLE =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M4 2.2v7.6a.4.4 0 0 0 .65.31l4.75-3.8a.4.4 0 0 0 0-.62L4.65 1.89A.4.4 0 0 0 4 2.2Z"/></svg>'

/** Toggle open state is view-only (Notion keeps it per user, not in the doc). */
const toggleState = new WeakMap<object, boolean>()

export class ToggleView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private button: HTMLElement
  private open: boolean

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined
  ) {
    this.dom = document.createElement('div')
    this.dom.className = 'toggle'
    this.button = document.createElement('div')
    this.button.className = 'toggle-button'
    this.button.contentEditable = 'false'
    this.button.innerHTML = TRIANGLE
    this.button.setAttribute('role', 'button')
    this.button.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.setOpen(!this.open)
    })
    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'toggle-content'
    // the "Empty toggle" prompt is a pseudo-element: a click on it starts the first child
    this.contentDOM.addEventListener('mousedown', (e) => {
      const summary = this.contentDOM.firstElementChild
      if (e.target !== this.contentDOM || !this.open || this.node.childCount > 1) return
      if (summary && e.clientY < summary.getBoundingClientRect().bottom) return
      const pos = this.getPos()
      if (pos === undefined) return
      e.preventDefault()
      const at = pos + this.node.nodeSize - 1
      const tr = this.view.state.tr.insert(at, this.view.state.schema.nodes.paragraph.create())
      tr.setSelection(TextSelection.create(tr.doc, at + 1))
      this.view.dispatch(tr.scrollIntoView())
      this.view.focus()
    })
    this.dom.append(this.button, this.contentDOM)
    this.open = node.attrs.open || toggleState.get(node) || false
    this.sync()
  }

  setOpen(open: boolean) {
    this.open = open
    toggleState.set(this.node, open)
    this.sync()
    if (open) return
    // collapsing with the caret inside hidden children: move it to the summary
    const pos = this.getPos()
    if (pos === undefined) return
    const { from } = this.view.state.selection
    const summaryEnd = pos + 1 + this.node.child(0).nodeSize - 1
    if (from > summaryEnd && from < pos + this.node.nodeSize) {
      this.view.dispatch(this.view.state.tr.setSelection(Selection.near(this.view.state.doc.resolve(summaryEnd))))
    }
  }

  private sync() {
    this.dom.classList.toggle('is-open', this.open)
    this.dom.classList.toggle('is-childless', this.node.childCount <= 1)
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    toggleState.set(node, this.open)
    this.sync()
    return true
  }

  ignoreMutation(m: ViewMutationRecord) {
    return m.type === 'attributes' && m.target === this.dom
  }
}

export class CalloutView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private icon: HTMLElement

  constructor(
    private node: PMNode,
    private onIconClick: (pos: number, rect: DOMRect) => void,
    private getPos: () => number | undefined
  ) {
    this.dom = document.createElement('div')
    this.dom.className = 'callout'
    this.icon = document.createElement('div')
    this.icon.className = 'callout-icon'
    this.icon.contentEditable = 'false'
    this.icon.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const pos = this.getPos()
      if (pos !== undefined) this.onIconClick(pos, this.icon.getBoundingClientRect())
    })
    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'callout-content'
    this.dom.append(this.icon, this.contentDOM)
    this.sync()
  }

  private sync() {
    const kind = String(this.node.attrs.kind || 'note')
    this.dom.dataset.kind = kind
    this.icon.textContent = CALLOUT_ICONS[kind] ?? '💡'
    this.icon.title = CALLOUT_LABELS[kind] ?? 'Note'
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.sync()
    return true
  }

  ignoreMutation(m: ViewMutationRecord) {
    return m.type === 'attributes' && m.target === this.dom
  }
}

/** Resolves relative image paths against the open file's folder. */
export class ImageView implements NodeView {
  dom: HTMLElement
  private img: HTMLImageElement

  constructor(
    private node: PMNode,
    private docPath: () => string | null
  ) {
    this.img = document.createElement('img')
    this.dom = this.img
    this.img.draggable = false
    this.img.addEventListener('error', () => this.img.classList.add('broken'))
    this.sync()
  }

  private sync() {
    const src = String(this.node.attrs.src || '')
    this.img.alt = this.node.attrs.alt || ''
    if (this.node.attrs.title) this.img.title = this.node.attrs.title
    this.img.src = resolveImageSrc(src, this.docPath())
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    const changed = node.attrs.src !== this.node.attrs.src
    this.node = node
    if (changed) this.sync()
    return true
  }
}

export function resolveImageSrc(src: string, docPath: string | null): string {
  if (!src || /^(https?:|data:|blob:|motion-asset:)/i.test(src)) return src
  if (!docPath) return src
  let path = src
  try {
    path = decodeURI(src)
  } catch {
    /* keep raw */
  }
  path = path.replace(/^file:\/\//, '')
  const abs = path.startsWith('/') ? path : resolvePath(dirOf(docPath), path)
  return assetUrl(abs)
}

/** Tables get a horizontally scrolling wrapper, like Notion's simple tables. */
export class TableView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private table: HTMLTableElement

  constructor(private node: PMNode) {
    this.dom = document.createElement('div')
    this.dom.className = 'table-wrapper'
    this.table = document.createElement('table')
    this.contentDOM = document.createElement('tbody')
    this.table.appendChild(this.contentDOM)
    this.dom.appendChild(this.table)
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    return true
  }

  ignoreMutation(m: ViewMutationRecord) {
    return m.type === 'attributes' && (m.target === this.table || m.target === this.dom)
  }
}
