import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Editor } from '@tiptap/core'
import { EditorContent } from '@tiptap/react'
import { EditorState, Plugin, PluginKey, TextSelection, Selection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { FileEntry, FsChange, Prefs, WriteResult } from '@shared/types'
import { api, baseOf, dirOf, joinPath, resolvePath, stemOf } from '@/api'
import { parseMarkdown, type SourceInfo } from '@/editor/markdown/parse'
import { serializeMarkdown } from '@/editor/markdown/serialize'
import { splitFrontmatter, wrapFrontmatter } from '@/editor/markdown/frontmatter'
import { editorExtensions } from '@/editor/extensions'
import { BlockHandle } from '@/editor/BlockHandle'
import { SlashMenu, MentionMenu } from '@/editor/SlashMenu'
import { BubbleToolbar, LinkEditor, LinkHoverCard, CalloutKindMenu, calloutMenuStore, openLinkEditor } from '@/editor/Toolbar'
import { TableControls } from '@/editor/TableControls'
import { Outline } from '@/editor/Outline'
import { slashHooks } from '@/editor/extensions/slash'
import { refreshWikilinks, linkHoverStore } from '@/editor/extensions/links'
import { linkEditStore } from '@/editor/Toolbar'
import { slashStore } from '@/editor/extensions/slash'
import { mentionStore } from '@/editor/extensions/pageMention'
import { dropLineStore, blockDrag } from '@/editor/extensions/blockDrop'
import { acceptChange, changesOf, computeReview, matchFormat, rebase, rejectChange, type Change } from '@/editor/review'
import { suggestionMarks, suggestKey, suggestPlugin, type Suggestion } from '@/editor/suggestView'
import { ensureBase, openBases, pendingSuggestions } from '@/suggestions'

/** Menus and hover cards live in module-level stores; a new page must start with none open. */
function resetEditorStores() {
  linkHoverStore.set(null)
  linkEditStore.set(null)
  calloutMenuStore.set(null)
  dropLineStore.set(null)
  blockDrag.current = null
  slashStore.set((s) => ({ ...s, open: false, command: null }))
  mentionStore.set((s) => ({ ...s, open: false, command: null }))
}
import { setFindQuery, findStep, findInfo } from '@/editor/extensions/find'
import { Properties } from './Properties'
import { SourceEditor } from './SourceEditor'
import { rectOf } from './Popover'
import { CloseIcon, ArrowUpIcon, ArrowDownIcon, MarkdownIcon, AlertIcon, CheckIcon, SuggestIcon } from './icons'

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'reloaded' | 'error'

export interface PageMeta {
  title: string
  status: SaveStatus
  mtime: number | null
}

export interface PageHandle {
  flush(): void
  /** save anything pending and wait for in-flight writes */
  settle(): Promise<void>
  editor(): Editor | null
  markdown(): string
  words(): number
  addProperties(): void
}

interface Props {
  path: string
  docId: number
  files: FileEntry[]
  prefs: Prefs
  sourceMode: boolean
  fsChange: FsChange | null
  findOpen: boolean
  findQuery?: string
  onCloseFind(): void
  onNavigate(path: string, opts?: import('@/App').OpenOptions): void
  onRenamed(from: string, to: string): void
  onMeta(meta: PageMeta): void
  toast(msg: string): void
}

const scrollMemory = new Map<string, number>()

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'untitled'

function headingSlug(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\- ]+/g, '')
    .replace(/\s/g, '-')
}

/** Puts a DOM slot right after the title H1, where frontmatter properties render. */
function propertiesSlotPlugin(slot: HTMLElement, enabled: () => boolean) {
  return new Plugin({
    key: new PluginKey('propertiesSlot'),
    props: {
      decorations(state) {
        if (!enabled()) return null
        const first = state.doc.firstChild
        if (!first || first.type.name !== 'heading' || first.attrs.level !== 1) return null
        return DecorationSet.create(state.doc, [
          Decoration.widget(first.nodeSize, () => slot, {
            side: -1,
            key: 'properties-slot',
            ignoreSelection: true,
            stopEvent: () => true
          })
        ])
      }
    }
  })
}

export const PageView = forwardRef<PageHandle, Props>(function PageView(props, ref) {
  const { path, docId, files, prefs, sourceMode, fsChange, findOpen } = props
  const [editor, setEditor] = useState<Editor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frontmatter, setFrontmatterState] = useState<string | null>(null)
  const [rawStartProps, setRawStartProps] = useState(false)
  const [firstIsH1, setFirstIsH1] = useState(true)
  const [conflict, setConflict] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(false)
  const [rawText, setRawText] = useState<string | null>(null)
  const [pageEl, setPageElState] = useState<HTMLDivElement | null>(null)
  const pageElRef = useRef<HTMLDivElement | null>(null)
  const setPageEl = useCallback((el: HTMLDivElement | null) => {
    pageElRef.current = el
    setPageElState(el)
  }, [])

  const pathRef = useRef(path)
  const sourceRef = useRef<SourceInfo | null>(null)
  const frontmatterRef = useRef<string | null>(null)
  const lastSaved = useRef<string>('')
  const dirty = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const rawRef = useRef<string | null>(null)
  const mtimeRef = useRef<number | null>(null)
  const statusRef = useRef<SaveStatus>('saved')
  /** disk text while a conflict is unresolved; autosave is paused until it is */
  const conflictRef = useRef<string | null>(null)
  const deletedRef = useRef(false)
  /** the file can't round-trip through blocks unchanged, so it's edited as source */
  const forcedRawRef = useRef(false)
  const [forcedRaw, setForcedRaw] = useState(false)
  /** text of a write that's in flight (what the disk will hold once it lands) */
  const inflight = useRef<string | null>(null)
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  const propsSlot = useMemo(() => {
    const el = document.createElement('div')
    el.className = 'properties-slot'
    el.contentEditable = 'false'
    return el
  }, [])
  const propsRef = useRef(props)
  propsRef.current = props
  const filesRef = useRef(files)
  filesRef.current = files
  /** outside edits made while the page is open, shown as suggestions against the text it was opened with */
  const reviewRef = useRef<{ review: ReturnType<typeof computeReview>; changes: Change[] } | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const reviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  pathRef.current = path

  const emitMeta = useCallback((status?: SaveStatus) => {
    if (status) statusRef.current = status
    const ed = editorRef.current
    let title = stemOf(pathRef.current)
    const first = ed?.state.doc.firstChild
    if (first && first.type.name === 'heading' && first.attrs.level === 1 && first.textContent.trim()) title = first.textContent.trim()
    propsRef.current.onMeta({ title, status: statusRef.current, mtime: mtimeRef.current })
  }, [])

  const currentMarkdown = useCallback((): string => {
    if (rawRef.current !== null) return rawRef.current
    const ed = editorRef.current
    if (!ed) return lastSaved.current
    return serializeMarkdown(ed.state.doc, sourceRef.current, frontmatterRef.current)
  }, [])

  const maybeAutoRename = useCallback(async () => {
    const ed = editorRef.current
    const p = pathRef.current
    if (!ed || !/^Untitled( \d+)?\.md$/.test(baseOf(p))) return
    const first = ed.state.doc.firstChild
    if (!first || first.type.name !== 'heading' || !first.textContent.trim()) return
    // wait until the caret leaves the title
    if (ed.state.selection.from <= first.nodeSize) return
    const stem = slugify(first.textContent)
    let target = joinPath(dirOf(p), stem + '.md')
    for (let i = 2; await api.exists(target); i++) target = joinPath(dirOf(p), `${stem}-${i}.md`)
    try {
      const to = await api.rename(p, target)
      pathRef.current = to
      propsRef.current.onRenamed(p, to)
    } catch {
      /* keep the old name */
    }
  }, [])

  const setConflictState = useCallback((disk: string | null) => {
    conflictRef.current = disk
    setConflict(disk)
  }, [])
  const setDeletedState = useCallback((v: boolean) => {
    deletedRef.current = v
    setDeleted(v)
  }, [])

  const doSave = useCallback(
    async (opts: { force?: boolean; create?: boolean } = {}) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = null
      if (!dirty.current) return
      // a conflict or a deleted file pauses autosave (edits stay pending) until resolved
      if ((conflictRef.current !== null || deletedRef.current) && !opts.force && !opts.create) return
      const text = currentMarkdown()
      if (text === lastSaved.current && !opts.create && !opts.force) {
        dirty.current = false
        emitMeta('saved')
        return
      }
      dirty.current = false
      inflight.current = text
      const before = lastSaved.current
      emitMeta('saving')
      let res: WriteResult
      try {
        res = await api.write(pathRef.current, text, { expected: lastSaved.current, ...opts })
      } catch (e) {
        res = { ok: false, reason: 'error', message: (e as Error).message }
      }
      inflight.current = null
      if (res.ok) {
        lastSaved.current = text
        mtimeRef.current = res.mtime
        // your own edits aren't suggestions: fold them into the base
        const base = openBases.get(pathRef.current)
        const ed = editorRef.current
        if (base !== undefined && base !== before && ed) {
          openBases.set(pathRef.current, rebase(base, before, text, ed.schema))
          scheduleReview()
        } else if (base === before) openBases.set(pathRef.current, text)
        emitMeta(dirty.current ? 'unsaved' : 'saved')
        // renames ride the save queue so no write ever targets a path mid-rename
        saveChain.current = saveChain.current.then(maybeAutoRename)
        return
      }
      dirty.current = true
      if (res.reason === 'conflict') {
        setConflictState(res.disk)
        emitMeta('unsaved')
      } else if (res.reason === 'missing') {
        setDeletedState(true)
        emitMeta('unsaved')
      } else {
        emitMeta('error')
        propsRef.current.toast(`Couldn’t save: ${res.message}`)
      }
    },
    [currentMarkdown, emitMeta, maybeAutoRename, setConflictState, setDeletedState]
  )

  /** Saves run one at a time so each write knows exactly what's on disk. */
  const save = useCallback(
    (opts: { force?: boolean; create?: boolean } = {}) => {
      saveChain.current = saveChain.current.then(() => doSave(opts))
      return saveChain.current
    },
    [doSave]
  )

  const markDirty = useCallback(() => {
    dirty.current = true
    if (statusRef.current !== 'unsaved') emitMeta('unsaved')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (conflictRef.current !== null || deletedRef.current) return
    saveTimer.current = setTimeout(() => void save(), 350)
  }, [emitMeta, save])

  /** Last-chance synchronous save (navigating away, closing the window). */
  const flushSync = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (!dirty.current || deletedRef.current) return
    const text = currentMarkdown()
    const onDisk = inflight.current ?? lastSaved.current
    if (text === onDisk) {
      dirty.current = false
      return
    }
    const res = api.writeSync(pathRef.current, text, { expected: conflictRef.current ?? onDisk })
    if (res.ok) {
      lastSaved.current = text
      dirty.current = false
      return
    }
    if (res.reason === 'conflict' || conflictRef.current !== null) {
      // someone else changed the file: keep both versions rather than losing either
      const p = pathRef.current
      const copy = p.replace(/(\.(md|markdown))?$/i, ' (my edits).md')
      const saved = api.writeSync(copy, text, { create: true, force: true })
      if (saved.ok) propsRef.current.toast(`Your edits were saved as ${baseOf(copy)}`)
      dirty.current = false
    }
  }, [currentMarkdown])

  /**
   * Parse markdown into the editor, replacing its state (and undo history). If the doc
   * wouldn't serialize back to exactly this text, the file is edited as source instead.
   */
  const loadInto = useCallback((ed: Editor, text: string, keepSelection = false) => {
    const { frontmatter: fm } = splitFrontmatter(text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n'))
    let { doc, source } = parseMarkdown(text, ed.schema)
    const fresh = text.trim() === '' || (fm && doc.childCount === 1 && doc.firstChild!.type.name === 'paragraph' && doc.firstChild!.content.size === 0)
    if (!fresh && serializeMarkdown(doc, source) !== text) {
      forcedRawRef.current = true
      setForcedRaw(true)
      rawRef.current = text
      setRawText(text)
      return
    }
    // a brand-new page starts with an empty title block
    if (fresh) doc = ed.schema.nodes.doc.create(null, ed.schema.nodes.heading.create({ level: 1 }))
    sourceRef.current = source
    frontmatterRef.current = source.frontmatter
    setFrontmatterState(source.frontmatter)
    const prevSel = ed.state.selection
    let selection: Selection | undefined
    if (keepSelection) {
      const pos = Math.min(prevSel.from, doc.content.size)
      selection = Selection.near(doc.resolve(pos))
    }
    const state = EditorState.create({ schema: ed.schema, doc, plugins: ed.state.plugins, selection })
    ed.view.updateState(state)
    const first = doc.firstChild
    setFirstIsH1(!!first && first.type.name === 'heading' && first.attrs.level === 1)
  }, [])

  /** Diff the page against the text it was opened with and redraw the suggestions. */
  const refreshReview = useCallback(() => {
    if (reviewTimer.current) clearTimeout(reviewTimer.current)
    reviewTimer.current = null
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    const base = openBases.get(pathRef.current)
    const saved = lastSaved.current
    const cur = currentMarkdown()
    // what you've typed but not saved yet isn't a suggestion either
    const against = base === undefined ? undefined : base === saved ? cur : cur === saved ? base : rebase(base, saved, cur, ed.schema)
    const r = against === undefined || against === cur ? null : computeReview(against, cur, ed.schema)
    const changes = r ? changesOf(r) : []
    reviewRef.current = r && changes.length ? { review: r, changes } : null
    pendingSuggestions.set(pathRef.current, changes.length)
    const marks = r && changes.length ? suggestionMarks(ed.state.doc, r, changes, ed.schema) : null
    setSuggestions(marks?.items ?? [])
    const show = marks?.set && rawRef.current === null && conflictRef.current === null
    ed.view.dispatch(ed.state.tr.setMeta(suggestKey, show ? marks.set : DecorationSet.empty).setMeta('addToHistory', false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMarkdown])

  const scheduleReview = useCallback(() => {
    if (!openBases.has(pathRef.current)) return
    if (reviewTimer.current) clearTimeout(reviewTimer.current)
    reviewTimer.current = setTimeout(refreshReview, 200)
  }, [refreshReview])

  /** Replace the page's text (rejecting suggestions) and save it. */
  const applyText = useCallback(
    (text: string) => {
      const ed = editorRef.current
      if (rawRef.current !== null) {
        rawRef.current = text
        setRawText(text)
      } else if (ed) loadInto(ed, text, true)
      dirty.current = true
      void save()
      refreshReview()
    },
    [loadInto, save, refreshReview]
  )

  const suggestionActions = useRef({ accept: (_i: number) => {}, reject: (_i: number) => {}, acceptAll: () => {}, rejectAll: () => {} })
  suggestionActions.current = {
    accept: (i) => {
      const r = reviewRef.current
      if (!r?.changes[i]) return
      openBases.set(pathRef.current, acceptChange(r.review, r.changes[i]))
      refreshReview()
    },
    reject: (i) => {
      const r = reviewRef.current
      if (r?.changes[i]) applyText(matchFormat(rejectChange(r.review, r.changes[i]), lastSaved.current))
    },
    acceptAll: () => {
      openBases.set(pathRef.current, currentMarkdown())
      refreshReview()
    },
    rejectAll: () => {
      const base = openBases.get(pathRef.current)
      if (base !== undefined) applyText(base)
    }
  }

  // ---- load
  useEffect(() => {
    let cancelled = false
    let ed: Editor | null = null
    resetEditorStores()
    setEditor(null)
    setError(null)
    setDeletedState(false)
    setConflictState(null)
    forcedRawRef.current = false
    setForcedRaw(false)
    rawRef.current = null
    setRawText(null)
    api
      .read(path)
      .then(({ content, mtime }) => {
        if (cancelled) return
        mtimeRef.current = mtime
        lastSaved.current = content
        ensureBase(path, content)
        ed = new Editor({
          extensions: editorExtensions({
            docPath: () => pathRef.current,
            files: () => filesRef.current,
            saveImage: async (file) => {
              const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')
              const data = await file.arrayBuffer()
              return data.byteLength ? api.saveAsset(pathRef.current, data, ext) : null
            },
            onCalloutIcon: (pos, rect) => calloutMenuStore.set({ pos, anchor: rectOf(rect) }),
            openLink: (href, event) => openHref(href, event),
            openWiki: (name, event) => {
              const target = resolveWiki(name)
              if (target) propsRef.current.onNavigate(target, event.metaKey ? { newTab: true, background: true } : undefined)
              else propsRef.current.toast(`No page named “${name}”`)
            },
            resolveWiki: (name) => resolveWiki(name),
            plugins: [propertiesSlotPlugin(propsSlot, () => !!frontmatterRef.current), suggestPlugin()]
          }),
          editorProps: {
            attributes: { spellcheck: String(propsRef.current.prefs.spellcheck) }
          },
          autofocus: false
        })
        loadInto(ed, content)
        ed.on('update', ({ transaction }) => {
          if (!transaction.docChanged) return
          const first = ed!.state.doc.firstChild
          setFirstIsH1(!!first && first.type.name === 'heading' && first.attrs.level === 1)
          markDirty()
          scheduleReview()
        })
        ed.on('selectionUpdate', () => {
          // a pending Untitled rename fires once the caret leaves the title
          if (!dirty.current && /^Untitled( \d+)?\.md$/.test(baseOf(pathRef.current)))
            saveChain.current = saveChain.current.then(maybeAutoRename)
        })
        editorRef.current = ed
        setEditor(ed)
        emitMeta('saved')
        // edits made while this page was in a background tab
        refreshReview()
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message || e))
      })
    return () => {
      cancelled = true
      if (reviewTimer.current) clearTimeout(reviewTimer.current)
      reviewRef.current = null
      setSuggestions([])
      resetEditorStores()
      flushSync()
      const scroller = pageElRef.current?.parentElement
      if (scroller) scrollMemory.set(pathRef.current, scroller.scrollTop)
      editorRef.current = null
      ed?.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId])

  // restore scroll / focus after mount
  useEffect(() => {
    if (!editor || !pageEl) return
    const scroller = pageEl.parentElement
    const saved = scrollMemory.get(path)
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = saved ?? 0
      const doc = editor.state.doc
      const first = doc.firstChild
      // new/empty pages: caret in the title
      if (doc.childCount === 1 && first && first.content.size === 0) editor.commands.focus('start')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pageEl])

  // keep path-dependent things fresh across renames
  useEffect(() => {
    emitMeta()
  }, [path, emitMeta])

  // wikilink targets depend on the file index
  useEffect(() => {
    if (editor && !editor.isDestroyed) refreshWikilinks(editor.view)
  }, [files, editor])

  // ---- external changes (Claude Code editing the file)
  useEffect(() => {
    if (!fsChange) return
    const p = pathRef.current
    if (fsChange.removed.includes(p)) {
      void api.exists(p).then((ok) => {
        if (ok) return
        // follow a rename: a new file with exactly our content
        const added = fsChange.added.filter((a) => /\.(md|markdown)$/i.test(a))
        void Promise.all(added.map((a) => api.read(a).then((r) => ({ a, same: r.content === lastSaved.current })))).then(
          (matches) => {
            const same = matches.filter((m) => m.same)
            if (same.length === 1) {
              pathRef.current = same[0].a
              propsRef.current.onRenamed(p, same[0].a)
            } else setDeletedState(true)
          }
        )
      })
      return
    }
    if (!fsChange.changed.includes(p) && !fsChange.added.includes(p)) return
    void api.read(p).then(({ content, mtime }) => {
      if (deletedRef.current) setDeletedState(false)
      if (content === lastSaved.current || content === inflight.current) return
      mtimeRef.current = mtime
      if (dirty.current || conflictRef.current !== null) {
        if (saveTimer.current) clearTimeout(saveTimer.current)
        setConflictState(content)
        return
      }
      lastSaved.current = content
      if (rawRef.current !== null) {
        rawRef.current = content
        setRawText(content)
      } else if (editorRef.current) {
        loadInto(editorRef.current, content, true)
      }
      refreshReview()
      emitMeta('reloaded')
      setTimeout(() => statusRef.current === 'reloaded' && emitMeta('saved'), 2500)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fsChange])

  // ---- source mode
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || forcedRawRef.current) return
    if (sourceMode && rawRef.current === null) {
      if (saveTimer.current) void save()
      const text = currentMarkdown()
      rawRef.current = text
      setRawText(text)
    } else if (!sourceMode && rawRef.current !== null) {
      const text = rawRef.current
      rawRef.current = null
      setRawText(null)
      loadInto(ed, text)
      if (!forcedRawRef.current) requestAnimationFrame(() => ed.commands.focus())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode, editor])

  useEffect(() => {
    const before = () => flushSync()
    window.addEventListener('beforeunload', before)
    return () => window.removeEventListener('beforeunload', before)
  }, [flushSync])

  function resolveWiki(name: string): string | null {
    const all = filesRef.current
    const dir = dirOf(pathRef.current)
    const clean = name.replace(/\.md$/i, '').trim()
    if (clean.includes('/')) {
      const abs = resolvePath(dir, clean + '.md')
      return all.find((f) => f.path === abs)?.path ?? all.find((f) => f.rel === clean + '.md')?.path ?? null
    }
    const matches = all.filter((f) => stemOf(f.path).toLowerCase() === clean.toLowerCase())
    if (!matches.length) return null
    return (matches.find((f) => dirOf(f.path) === dir) ?? matches[0]).path
  }

  function openHref(href: string, event?: MouseEvent) {
    if (!href) return
    if (/^(https?:|mailto:|vscode:|slack:|notion:)/i.test(href)) {
      void api.openExternal(href)
      return
    }
    if (href.startsWith('#')) {
      scrollToHeading(href.slice(1))
      return
    }
    let target = href
    try {
      target = decodeURIComponent(href)
    } catch {
      /* keep */
    }
    target = target.replace(/^file:\/\//, '')
    const [file, anchor] = target.split('#')
    const abs = file.startsWith('/') ? file : resolvePath(dirOf(pathRef.current), file)
    void api.exists(abs).then((ok) => {
      if (!ok) {
        propsRef.current.toast(`Can’t find ${file}`)
        return
      }
      if (/\.(md|markdown)$/i.test(abs)) {
        propsRef.current.onNavigate(abs, event?.metaKey ? { newTab: true, background: true } : undefined)
        if (anchor) setTimeout(() => scrollToHeading(anchor), 300)
      } else void api.openPath(abs)
    })
  }

  function scrollToHeading(slug: string) {
    const ed = editorRef.current
    if (!ed) return
    let found = -1
    ed.state.doc.descendants((n, pos) => {
      if (found >= 0) return false
      if (n.type.name === 'heading' && headingSlug(n.textContent) === slug.toLowerCase()) found = pos
      return true
    })
    if (found < 0) return
    ed.commands.setTextSelection(found + 1)
    const dom = ed.view.nodeDOM(found) as HTMLElement | null
    dom?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  useImperativeHandle(
    ref,
    () => ({
      flush: flushSync,
      settle: async () => {
        await save()
        await saveChain.current
      },
      editor: () => editorRef.current,
      markdown: currentMarkdown,
      words: () => {
        const text = rawRef.current ?? editorRef.current?.state.doc.textBetween(0, editorRef.current.state.doc.content.size, ' ', ' ') ?? ''
        return (text.match(/\S+/g) || []).length
      },
      addProperties: () => {
        if (frontmatterRef.current) return
        setRawStartProps(true)
        setFrontmatter(wrapFrontmatter('title: \n'))
      }
    }),
    [flushSync, currentMarkdown, save]
  )

  function setFrontmatter(next: string | null) {
    if (next === frontmatterRef.current) return
    frontmatterRef.current = next
    setFrontmatterState(next)
    const ed = editorRef.current
    // empty transaction: just re-render decorations so the slot appears/disappears
    if (ed && !ed.isDestroyed) ed.view.dispatch(ed.state.tr.setMeta('addToHistory', false))
    markDirty()
  }

  // ---- slash menu image picking
  useEffect(() => {
    slashHooks.pickImage = (ed) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return
        const ext = (file.name.split('.').pop() || 'png').toLowerCase()
        const src = await api.saveAsset(pathRef.current, await file.arrayBuffer(), ext)
        const node = ed.schema.nodes.image.create({ src, alt: file.name.replace(/\.[^.]+$/, '') })
        ed.chain().focus().insertContent({ type: 'paragraph', content: [node.toJSON()] }).run()
      }
      input.click()
    }
  }, [])

  // ⌘K → link editor
  useEffect(() => {
    if (!editor) return
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && editor.isFocused) {
        e.preventDefault()
        openLinkEditor(editor)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [editor])

  const clickBelow = () => {
    const ed = editorRef.current
    if (!ed) return
    const last = ed.state.doc.lastChild
    if (last && last.type.name === 'paragraph' && last.content.size === 0) {
      ed.commands.focus('end')
      return
    }
    const end = ed.state.doc.content.size
    const tr = ed.state.tr.insert(end, ed.schema.nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, end + 1))
    ed.view.dispatch(tr.scrollIntoView())
    ed.view.focus()
  }

  const pageClass = [
    'page',
    prefs.fullWidth ? 'full-width' : '',
    prefs.font !== 'default' ? `font-${prefs.font}` : '',
    prefs.smallText ? 'small-text' : '',
    suggestions.length && rawText === null ? 'has-suggestions' : ''
  ]
    .filter(Boolean)
    .join(' ')

  if (error) {
    return (
      <div className={pageClass}>
        <div className="page-header" />
        <Banner tone="error" title="Couldn’t open this file" detail={error} />
      </div>
    )
  }

  return (
    <div className={pageClass} ref={setPageEl}>
      <div className="page-header">
        {deleted && (
          <Banner tone="error" title="Deleted or moved on disk" detail="Edits aren’t being saved.">
            <button
              onClick={() => {
                setDeletedState(false)
                dirty.current = true
                void save({ create: true, force: true })
              }}
            >
              Restore file
            </button>
          </Banner>
        )}
        {suggestions.length > 0 && conflict === null && !deleted && (
          <div className="suggest-bar" role="status">
            <SuggestIcon size={16} />
            <span className="suggest-bar-text">
              <b>{suggestions.length === 1 ? '1 suggestion' : `${suggestions.length} suggestions`}</b>
              <span> · edited outside Motion while open</span>
            </span>
            <button onClick={() => suggestionActions.current.rejectAll()}>Reject all</button>
            <button className="primary" onClick={() => suggestionActions.current.acceptAll()}>
              Accept all
            </button>
          </div>
        )}
        {forcedRaw && (
          <Banner tone="info" title="Opened as markdown source" detail="Some of this file can’t be shown as blocks without changing it." />
        )}
        {conflict !== null && (
          <Banner tone="warning" title="Changed on disk" detail="Autosave is paused until you pick a version.">
            <button
              onClick={() => {
                const ed = editorRef.current
                if (saveTimer.current) clearTimeout(saveTimer.current)
                lastSaved.current = conflict
                dirty.current = false
                if (rawRef.current !== null) {
                  rawRef.current = conflict
                  setRawText(conflict)
                } else if (ed) loadInto(ed, conflict, true)
                setConflictState(null)
                emitMeta('saved')
              }}
            >
              Use disk version
            </button>
            <button
              className="primary"
              onClick={() => {
                setConflictState(null)
                dirty.current = true
                void save({ force: true })
              }}
            >
              Keep mine
            </button>
          </Banner>
        )}
        {rawText === null && editor && !firstIsH1 && (
          <FileTitle
            path={path}
            onRename={async (name) => {
              const target = joinPath(dirOf(pathRef.current), name + '.md')
              if (target === pathRef.current) return
              try {
                const from = pathRef.current
                const to = await api.rename(from, target)
                pathRef.current = to
                props.onRenamed(from, to)
              } catch (e) {
                props.toast((e as Error).message)
              }
            }}
            onEnter={() => editor.commands.focus('start')}
          />
        )}
        {rawText === null && frontmatter && (!firstIsH1 || !editor) && (
          <Properties frontmatter={frontmatter} onChange={setFrontmatter} startRaw={rawStartProps} key={'outer' + rawStartProps} />
        )}
      </div>

      {rawText !== null ? (
        <>
          <div className="source-badge">
            <MarkdownIcon size={14} /> Markdown source — ⌘/ to return
          </div>
          <SourceEditor
            value={rawText}
            onChange={(v) => {
              rawRef.current = v
              markDirty()
              scheduleReview()
            }}
          />
        </>
      ) : (
        editor && (
          <div className="editor-wrap">
            <BlockHandle editor={editor} container={pageEl} />
            <EditorContent editor={editor} />
            <BubbleToolbar editor={editor} />
            <SlashMenu />
            <MentionMenu />
            <LinkEditor editor={editor} files={files} docPath={path} />
            <LinkHoverCard editor={editor} onOpen={openHref} />
            <CalloutKindMenu editor={editor} />
            <TableControls editor={editor} container={pageEl} />
            {!suggestions.length && <Outline editor={editor} scroller={pageEl?.parentElement ?? null} />}
            {frontmatter &&
              firstIsH1 &&
              createPortal(
                <Properties frontmatter={frontmatter} onChange={setFrontmatter} startRaw={rawStartProps} key={'inner' + rawStartProps} />,
                propsSlot
              )}
          </div>
        )
      )}
      {rawText === null && editor && <div className="page-bottom" onMouseDown={(e) => (e.preventDefault(), clickBelow())} />}
      {suggestions.length > 0 && conflict === null && !deleted && editor && rawText === null && (
        <SuggestionCards
          items={suggestions}
          editor={editor}
          page={pageEl}
          onAccept={(i) => suggestionActions.current.accept(i)}
          onReject={(i) => suggestionActions.current.reject(i)}
        />
      )}
      {findOpen && editor && rawText === null && <FindBar editor={editor} initial={props.findQuery} onClose={props.onCloseFind} />}
    </div>
  )
})

/** Notion-style cards in the right margin, one per suggestion, level with the change. */
function SuggestionCards({
  items,
  editor,
  page,
  onAccept,
  onReject
}: {
  items: Suggestion[]
  editor: Editor
  page: HTMLElement | null
  onAccept(i: number): void
  onReject(i: number): void
}) {
  const [tops, setTops] = useState<number[]>([])
  const cards = useRef<(HTMLDivElement | null)[]>([])
  const layout = useCallback(() => {
    if (!page) return
    const origin = page.getBoundingClientRect().top
    const next: number[] = []
    let floor = 0
    items.forEach((_, i) => {
      const mark = page.querySelector(`.ProseMirror [data-change="${i}"]`)
      const top = Math.max(mark ? mark.getBoundingClientRect().top - origin - 6 : floor, floor)
      next.push(Math.round(top))
      floor = top + (cards.current[i]?.offsetHeight ?? 60) + 8
    })
    setTops((prev) => (prev.length === next.length && prev.every((t, k) => t === next[k]) ? prev : next))
  }, [items, page])
  useLayoutEffect(layout)
  useEffect(() => {
    const ro = new ResizeObserver(() => layout())
    if (page) ro.observe(page)
    editor.on('transaction', layout)
    return () => {
      ro.disconnect()
      editor.off('transaction', layout)
    }
  }, [editor, page, layout])
  const highlight = (i: number, on: boolean) =>
    page?.querySelectorAll(`[data-change="${i}"]`).forEach((el) => el.classList.toggle('is-active', on))
  const quote = (t: string) => `“${t.length > 90 ? t.slice(0, 90).trimEnd() + '…' : t}”`
  return (
    <div className="suggest-cards">
      {items.map((s, i) => (
        <div
          key={i}
          ref={(el) => {
            cards.current[i] = el
          }}
          className="suggest-card"
          style={{ top: tops[i] ?? 0 }}
          onMouseEnter={() => highlight(i, true)}
          onMouseLeave={() => highlight(i, false)}
        >
          <div className="suggest-card-head">
            <span className="suggest-avatar">
              <SuggestIcon size={13} />
            </span>
            <b>Outside edit</b>
            <span className="suggest-card-actions">
              <button title="Accept" onClick={() => onAccept(i)}>
                <CheckIcon size={15} />
              </button>
              <button title="Reject" onClick={() => onReject(i)}>
                <CloseIcon size={15} />
              </button>
            </span>
          </div>
          <div className="suggest-card-body">
            {s.props ? (
              <div>Change properties</div>
            ) : s.added && s.removed ? (
              <>
                <div>Replace: {quote(s.removed)}</div>
                <div className="add">with: {quote(s.added)}</div>
              </>
            ) : s.added ? (
              <div className="add">Add: {quote(s.added)}</div>
            ) : (
              <div>Delete: {quote(s.removed || 'empty block')}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Banner({
  tone,
  title,
  detail,
  children
}: {
  tone: 'warning' | 'error' | 'info'
  title: string
  detail?: string
  children?: React.ReactNode
}) {
  return (
    <div className={`page-banner ${tone}`} role="status">
      <span className="banner-icon">{tone === 'info' ? <MarkdownIcon size={16} /> : <AlertIcon size={16} />}</span>
      <span className="banner-text">
        <b>{title}</b>
        {detail && <span> · {detail}</span>}
      </span>
      {children && <span className="banner-actions">{children}</span>}
    </div>
  )
}

function FileTitle({ path, onRename, onEnter }: { path: string; onRename: (name: string) => void; onEnter: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const stem = stemOf(path)
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current) ref.current.textContent = stem
  }, [stem])
  const commit = () => {
    const name = (ref.current?.textContent || '').trim().replace(/[/\\:]/g, '-')
    if (!name) {
      if (ref.current) ref.current.textContent = stem
      return
    }
    if (name !== stem) onRename(name)
  }
  return (
    <div
      ref={ref}
      className="page-title"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder="Untitled"
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault()
          commit()
          onEnter()
        } else if (e.key === 'Escape') {
          if (ref.current) ref.current.textContent = stem
          ref.current?.blur()
        }
      }}
    />
  )
}

function FindBar({ editor, initial, onClose }: { editor: Editor; initial?: string; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [info, setInfo] = useState({ count: 0, current: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    const sel = editor.state.selection
    if (initial) {
      setQ(initial)
      setFindQuery(editor.view, initial)
      setInfo(findInfo(editor.view))
    } else if (!sel.empty) {
      const text = editor.state.doc.textBetween(sel.from, sel.to, ' ')
      if (text.length < 80) {
        setQ(text)
        setFindQuery(editor.view, text)
        setInfo(findInfo(editor.view))
      }
    }
    return () => {
      if (!editor.isDestroyed) setFindQuery(editor.view, '')
    }
  }, [editor])
  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        value={q}
        placeholder="Find in page"
        onChange={(e) => {
          setQ(e.target.value)
          setFindQuery(editor.view, e.target.value)
          setInfo(findInfo(editor.view))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            findStep(editor.view, e.shiftKey ? -1 : 1)
            setInfo(findInfo(editor.view))
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
            editor.view.focus()
          }
        }}
      />
      <span className="count">{q ? (info.count ? `${info.current + 1}/${info.count}` : 'No results') : ''}</span>
      <button className="icon-button" onClick={() => (findStep(editor.view, -1), setInfo(findInfo(editor.view)))}>
        <ArrowUpIcon size={16} />
      </button>
      <button className="icon-button" onClick={() => (findStep(editor.view, 1), setInfo(findInfo(editor.view)))}>
        <ArrowDownIcon size={16} />
      </button>
      <button className="icon-button" onClick={onClose}>
        <CloseIcon size={16} />
      </button>
    </div>
  )
}
