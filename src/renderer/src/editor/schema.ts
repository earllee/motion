import { Node, Extension, mergeAttributes, type AnyExtension, type NodeViewRenderer } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletList, OrderedList, TaskList, TaskItem } from '@tiptap/extension-list'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Image from '@tiptap/extension-image'
import Code from '@tiptap/extension-code'
import { createLowlight, common } from 'lowlight'

const base = createLowlight(common)
// Untagged code stays plain text, like Notion (no auto-detect guessing).
export const lowlight = {
  highlight: base.highlight.bind(base),
  highlightAuto: (value: string) => ({ type: 'root' as const, children: [{ type: 'text' as const, value }], data: {} }),
  listLanguages: base.listLanguages.bind(base),
  registered: base.registered.bind(base)
}

// Schema shared by the editor and the markdown parser/serializer. Every node here
// must round-trip through markdown; anything markdown-it emits that we can't model
// lands in rawBlock / htmlInline so it survives a save untouched.

const tight = {
  tight: {
    default: true,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-tight') !== 'false',
    renderHTML: (attrs: Record<string, unknown>) => ({ 'data-tight': attrs.tight ? 'true' : 'false' })
  }
}

const marker = { marker: { default: null, rendered: false } }

export const MdBulletList = BulletList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...tight, ...marker }
  }
})

export const MdOrderedList = OrderedList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...tight,
      delim: { default: null, rendered: false },
      // numbers come from our own CSS counter (Chromium's list-item counter goes stale when items move)
      start: {
        default: 1,
        parseHTML: (el: HTMLElement) => (el.hasAttribute('start') ? parseInt(el.getAttribute('start') || '', 10) || 1 : 1),
        renderHTML: (attrs: Record<string, unknown>) => {
          const start = Number(attrs.start ?? 1)
          return { start, style: `counter-reset: md-ol ${start - 1}` }
        }
      }
    }
  }
})

export const MdTaskList = TaskList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...tight, ...marker }
  }
})

export const MdTaskItem = TaskItem.extend({}).configure({ nested: true })

export const MdCode = Code.extend({ excludes: '' })

const align = {
  align: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.textAlign || el.getAttribute('align') || null,
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.align ? { style: `text-align: ${attrs.align}` } : {}
  }
}

export const MdTableCell = TableCell.extend({
  content: 'paragraph',
  addAttributes() {
    return { ...this.parent?.(), ...align }
  }
})

export const MdTableHeader = TableHeader.extend({
  content: 'paragraph',
  addAttributes() {
    return { ...this.parent?.(), ...align }
  }
})

export const MdCodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      meta: { default: null, rendered: false }
    }
  }
}).configure({ lowlight, defaultLanguage: null })

export const MdImage = Image.extend({}).configure({ inline: true, allowBase64: true })

/** GitHub alert (`> [!NOTE]`) rendered as a Notion callout. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (el) => el.getAttribute('data-kind') || 'note',
        renderHTML: (attrs) => ({ 'data-kind': attrs.kind })
      }
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }, { tag: 'aside' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout', class: 'callout' }), 0]
  }
})

/** `<details><summary>` rendered as a Notion toggle. The first paragraph is the summary. */
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  addAttributes() {
    return {
      open: {
        default: false,
        parseHTML: (el) => el.hasAttribute('open'),
        renderHTML: () => ({})
      }
    }
  },
  parseHTML() {
    return [
      {
        tag: 'details',
        contentElement: (el: HTMLElement) => {
          // flatten <summary> into the first paragraph
          const wrap = document.createElement('div')
          const summary = el.querySelector(':scope > summary')
          const p = document.createElement('p')
          p.innerHTML = summary?.innerHTML ?? ''
          wrap.appendChild(p)
          for (const child of Array.from(el.childNodes)) {
            if (child !== summary) wrap.appendChild(child.cloneNode(true))
          }
          return wrap
        }
      }
    ]
  },
  renderHTML() {
    return ['div', { 'data-type': 'toggle', class: 'toggle' }, 0]
  }
})

/** Verbatim markdown/HTML we don't model (HTML blocks, link reference definitions, …). */
export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  addAttributes() {
    return { kind: { default: 'html', rendered: false } }
  },
  parseHTML() {
    return [{ tag: 'pre[data-type="raw"]', preserveWhitespace: 'full' }]
  },
  renderHTML({ node }) {
    return ['pre', { 'data-type': 'raw', class: 'raw-block', 'data-kind': node.attrs.kind }, ['code', 0]]
  }
})

/** Inline HTML (`<kbd>`, `<!-- -->`, …) kept verbatim. */
export const HtmlInline = Node.create({
  name: 'htmlInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { html: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'span[data-type="html-inline"]', getAttrs: (el) => ({ html: (el as HTMLElement).textContent }) }]
  },
  renderHTML({ node }) {
    return ['span', { 'data-type': 'html-inline', class: 'html-inline' }, node.attrs.html]
  },
  renderText({ node }) {
    return node.attrs.html
  }
})

export interface NodeViews {
  callout?: NodeViewRenderer
  toggle?: NodeViewRenderer
  image?: NodeViewRenderer
  table?: NodeViewRenderer
  codeBlock?: NodeViewRenderer
}

const withView = <T extends AnyExtension>(ext: T, view?: NodeViewRenderer): T =>
  view ? (ext.extend({ addNodeView: () => view }) as T) : ext

export function baseExtensions(views: NodeViews = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      bulletList: false,
      orderedList: false,
      codeBlock: false,
      code: false,
      underline: false,
      trailingNode: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      dropcursor: { color: 'rgba(35, 131, 226, 0.5)', width: 3 },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        HTMLAttributes: { target: null, rel: null, class: 'md-link' }
      },
      hardBreak: {}
    }),
    MdBulletList,
    MdOrderedList,
    MdTaskList,
    MdTaskItem,
    MdCode,
    withView(MdCodeBlock, views.codeBlock),
    withView(MdImage, views.image),
    withView(Table.configure({ resizable: false, allowTableNodeSelection: true }), views.table),
    TableRow,
    MdTableHeader,
    MdTableCell,
    withView(Callout, views.callout),
    withView(Toggle, views.toggle),
    RawBlock,
    HtmlInline,
    LinkKind
  ]
}

/** Extra attributes on StarterKit's link/hardBreak so autolinks and `<br>` survive. */
export const LinkKind = Extension.create({
  name: 'linkKind',
  addGlobalAttributes() {
    return [
      { types: ['link'], attributes: { mdKind: { default: null, rendered: false } } },
      { types: ['hardBreak'], attributes: { html: { default: null, rendered: false } } }
    ]
  }
})
