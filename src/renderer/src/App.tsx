import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, FileEntry, FsChange, IndexSnapshot, MenuCommand, Prefs } from '@shared/types'
import { api, baseOf, dirOf, joinPath, stemOf } from './api'
import { Sidebar } from './components/Sidebar'
import { Topbar } from './components/Topbar'
import { Tabbar } from './components/Tabbar'
import { PageView, type PageHandle, type PageMeta } from './components/PageView'
import { CodeView } from './components/CodeView'
import { SearchModal } from './components/SearchModal'
import { FolderOpenIcon, LogoMark } from './components/icons'

/** One tab: the page it shows plus its own back/forward history. */
interface Tab {
  id: number
  path: string | null
  /** remounts the page view when it changes */
  docId: number
  back: string[]
  fwd: string[]
}

export interface OpenOptions {
  history?: boolean
  find?: string
  /** open in a new tab (⌘-click); `background` leaves the current tab focused */
  newTab?: boolean
  background?: boolean
}

let docCounter = 0
let tabCounter = 0
const makeTab = (path: string | null): Tab => ({ id: ++tabCounter, path, docId: ++docCounter, back: [], fwd: [] })
/** Pages created this session; left empty, they're cleaned up when you navigate away. */
const createdPages = new Set<string>()
const within = (p: string, root: string) => p === root || p.startsWith(root + '/')
const isMarkdownPath = (p: string) => /\.(md|markdown)$/i.test(p)

function defaultPage(files: FileEntry[]): string | null {
  const f = files.find((x) => /^(readme|index|claude)\.md$/i.test(x.rel)) ?? files[0]
  return f ? f.path : null
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [index, setIndex] = useState<IndexSnapshot | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [meta, setMeta] = useState<PageMeta>({ title: '', status: 'saved', mtime: null })
  const [fsChange, setFsChange] = useState<FsChange | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
  const [find, setFind] = useState<{ open: boolean; query?: string }>({ open: false })
  const [toast, setToastMsg] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const closedTabs = useRef<string[]>([])
  const lastBackground = useRef<{ opener: number; tab: number } | null>(null)
  const pageRef = useRef<PageHandle>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeRef = useRef(activeId)
  activeRef.current = activeId

  const active = tabs.find((t) => t.id === activeId) ?? null
  const current = active?.path ? { path: active.path, id: active.docId } : null
  const currentRef = useRef(current)
  currentRef.current = current

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastMsg(null), 2600)
  }, [])

  const patchState = useCallback((patch: Partial<AppState>) => {
    setState((s) => (s ? { ...s, ...patch, prefs: { ...s.prefs, ...(patch.prefs || {}) } } : s))
    void api.setState(patch)
  }, [])

  const setPrefs = useCallback(
    (patch: Partial<Prefs>) => {
      const s = stateRef.current
      if (!s) return
      patchState({ prefs: { ...s.prefs, ...patch } })
    },
    [patchState]
  )

  const expandTo = useCallback(
    (path: string) => {
      const s = stateRef.current
      if (!s?.root || !path.startsWith(s.root + '/')) return
      const parts = path.slice(s.root.length + 1).split('/').slice(0, -1)
      const next = new Set(s.expanded)
      let acc = ''
      let changed = false
      for (const p of parts) {
        acc = acc ? acc + '/' + p : p
        if (!next.has(acc)) {
          next.add(acc)
          changed = true
        }
      }
      if (changed) patchState({ expanded: [...next] })
    },
    [patchState]
  )

  /** A page created this session and never written to is removed once you leave it. */
  const leavePage = useCallback((path: string | null | undefined) => {
    if (!path || !createdPages.has(path)) return
    if (tabsRef.current.filter((t) => t.path === path).length > 1) return
    createdPages.delete(path)
    void api.read(path).then(({ content }) => {
      if (content.trim() === '') void api.trash(path)
    })
  }, [])

  const noteRecent = useCallback(
    (path: string) => {
      const s = stateRef.current
      if (s) patchState({ lastFile: path, recentFiles: [path, ...s.recentFiles.filter((f) => f !== path)].slice(0, 30) })
    },
    [patchState]
  )

  const resetPageUi = () => {
    setSourceMode(false)
    setFind({ open: false })
  }

  const activate = useCallback(
    (id: number) => {
      if (id === activeRef.current) return
      pageRef.current?.flush()
      setActiveId(id)
      resetPageUi()
      const t = tabsRef.current.find((x) => x.id === id)
      if (t?.path) {
        expandTo(t.path)
        noteRecent(t.path)
      }
    },
    [expandTo, noteRecent]
  )

  const openFile = useCallback(
    (path: string, opts: OpenOptions = {}) => {
      const cur = tabsRef.current.find((t) => t.id === activeRef.current)
      if (opts.newTab || !cur) {
        const tab = makeTab(path)
        let at = cur ? tabsRef.current.indexOf(cur) + 1 : tabsRef.current.length
        // consecutive background tabs line up after each other, like Chrome
        const prev = lastBackground.current
        if (opts.background && cur && prev && prev.opener === cur.id) {
          const i = tabsRef.current.findIndex((t) => t.id === prev.tab)
          if (i >= 0) at = i + 1
        }
        lastBackground.current = opts.background && cur ? { opener: cur.id, tab: tab.id } : null
        setTabs((ts) => [...ts.slice(0, at), tab, ...ts.slice(at)])
        if (!opts.background || !cur) {
          pageRef.current?.flush()
          setActiveId(tab.id)
          resetPageUi()
          if (opts.find) setFind({ open: true, query: opts.find })
          expandTo(path)
          noteRecent(path)
        }
        return
      }
      if (cur.path === path) {
        if (opts.find) setFind({ open: true, query: opts.find })
        return
      }
      pageRef.current?.flush()
      leavePage(cur.path)
      setTabs((ts) =>
        ts.map((t) =>
          t.id !== cur.id
            ? t
            : {
                ...t,
                path,
                docId: ++docCounter,
                back: opts.history !== false && t.path ? [...t.back, t.path] : t.back,
                fwd: opts.history !== false ? [] : t.fwd
              }
        )
      )
      resetPageUi()
      if (opts.find) setFind({ open: true, query: opts.find })
      expandTo(path)
      noteRecent(path)
    },
    [expandTo, leavePage, noteRecent]
  )

  const step = useCallback(
    (dir: -1 | 1) => {
      const cur = tabsRef.current.find((t) => t.id === activeRef.current)
      if (!cur) return
      const stack = dir === -1 ? cur.back : cur.fwd
      const target = stack[stack.length - 1]
      if (!target) return
      pageRef.current?.flush()
      leavePage(cur.path)
      setTabs((ts) =>
        ts.map((t) => {
          if (t.id !== cur.id) return t
          const back = dir === -1 ? t.back.slice(0, -1) : t.path ? [...t.back, t.path] : t.back
          const fwd = dir === 1 ? t.fwd.slice(0, -1) : t.path ? [...t.fwd, t.path] : t.fwd
          return { ...t, path: target, docId: ++docCounter, back, fwd }
        })
      )
      resetPageUi()
      expandTo(target)
      noteRecent(target)
    },
    [expandTo, leavePage, noteRecent]
  )

  const newTab = useCallback(() => {
    pageRef.current?.flush()
    const tab = makeTab(null)
    const cur = tabsRef.current.findIndex((t) => t.id === activeRef.current)
    setTabs((ts) => [...ts.slice(0, cur + 1), tab, ...ts.slice(cur + 1)])
    setActiveId(tab.id)
    resetPageUi()
    if (stateRef.current?.root) setSearchOpen(true)
  }, [])

  const closeTab = useCallback(
    (id: number) => {
      const ts = tabsRef.current
      const i = ts.findIndex((t) => t.id === id)
      if (i < 0) return
      const tab = ts[i]
      if (ts.length === 1 && !tab.path) {
        api.closeWindow()
        return
      }
      if (id === activeRef.current) pageRef.current?.flush()
      if (tab.path) {
        closedTabs.current.push(tab.path)
        leavePage(tab.path)
      }
      let rest = ts.filter((t) => t.id !== id)
      if (!rest.length) rest = [makeTab(null)]
      setTabs(rest)
      if (id === activeRef.current) {
        const next = rest[Math.min(i, rest.length - 1)]
        setActiveId(next.id)
        resetPageUi()
        if (next.path) expandTo(next.path)
      }
    },
    [expandTo, leavePage]
  )

  const moveTab = useCallback((id: number, toIndex: number) => {
    setTabs((ts) => {
      const from = ts.findIndex((t) => t.id === id)
      if (from < 0) return ts
      const copy = [...ts]
      const [t] = copy.splice(from, 1)
      copy.splice(from < toIndex ? toIndex - 1 : toIndex, 0, t)
      return copy
    })
  }, [])

  const setRoot = useCallback(
    async (root: string | null) => {
      pageRef.current?.flush()
      const snap = await api.setRoot(root)
      setIndex(snap)
      const s = await api.getState()
      setState(s)
      closedTabs.current = []
      const tab = makeTab(snap ? defaultPage(snap.files) : null)
      setTabs([tab])
      setActiveId(tab.id)
      resetPageUi()
    },
    []
  )

  const newPage = useCallback(
    async (dir: string, opts: OpenOptions = {}) => {
      try {
        const p = await api.createPage(dir)
        createdPages.add(p)
        openFile(p, opts)
      } catch (e) {
        showToast((e as Error).message)
      }
    },
    [openFile, showToast]
  )

  const onRenamed = useCallback(
    (from: string, to: string) => {
      const remap = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p)
      if (createdPages.delete(from)) createdPages.add(to)
      // the page view keeps running across a rename, so docId stays put
      setTabs((ts) => ts.map((t) => ({ ...t, path: t.path ? remap(t.path) : null, back: t.back.map(remap), fwd: t.fwd.map(remap) })))
      closedTabs.current = closedTabs.current.map(remap)
      const s = stateRef.current
      if (s)
        patchState({
          recentFiles: s.recentFiles.map(remap),
          favorites: s.favorites.map(remap),
          lastFile: s.lastFile ? remap(s.lastFile) : null
        })
    },
    [patchState]
  )

  const rename = useCallback(
    async (from: string, to: string) => {
      try {
        if (currentRef.current && within(currentRef.current.path, from)) await pageRef.current?.settle()
        const done = await api.rename(from, to)
        onRenamed(from, done)
      } catch (e) {
        showToast((e as Error).message)
      }
    },
    [onRenamed, showToast]
  )

  const trash = useCallback(
    async (path: string) => {
      if (!(await api.confirmTrash(path))) return
      if (currentRef.current && within(currentRef.current.path, path)) await pageRef.current?.settle()
      await api.trash(path)
      const s = stateRef.current
      if (s)
        patchState({
          favorites: s.favorites.filter((f) => !within(f, path)),
          recentFiles: s.recentFiles.filter((f) => !within(f, path))
        })
      // tabs showing the trashed page fall back to their previous page (or go empty)
      setTabs((ts) =>
        ts.map((t) => {
          if (!t.path || !within(t.path, path)) return t
          const back = t.back.filter((p) => !within(p, path))
          const prev = back.pop() ?? null
          return { ...t, path: prev, back, fwd: [], docId: ++docCounter }
        })
      )
      showToast(`Moved “${baseOf(path)}” to the Trash`)
    },
    [patchState, showToast]
  )

  // ---- boot: restore tabs
  useEffect(() => {
    void (async () => {
      const s = await api.getState()
      setState(s)
      const snap = await api.getIndex()
      setIndex(snap)
      if (!snap) return
      const known = new Set(snap.files.map((f) => f.path))
      let restored = (s.tabs ?? []).filter((p) => known.has(p)).map((p) => makeTab(p))
      let activeIndex = Math.min(Math.max(0, s.activeTab ?? 0), Math.max(0, restored.length - 1))
      if (!restored.length) {
        const first = s.lastFile && known.has(s.lastFile) ? s.lastFile : defaultPage(snap.files)
        restored = [makeTab(first)]
        activeIndex = 0
      }
      setTabs(restored)
      setActiveId(restored[activeIndex].id)
      const p = restored[activeIndex].path
      if (p) expandTo(p)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // persist open tabs
  useEffect(() => {
    if (!state || !tabs.length) return
    const paths = tabs.map((t) => t.path).filter((p): p is string => !!p)
    const activePath = tabs.find((t) => t.id === activeId)?.path
    const activeTab = activePath ? Math.max(0, paths.indexOf(activePath)) : 0
    if (JSON.stringify(paths) !== JSON.stringify(state.tabs) || activeTab !== state.activeTab) patchState({ tabs: paths, activeTab })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeId])

  // ---- main-process events
  useEffect(() => {
    const offFs = api.onFsChange((change) => {
      setIndex(change.snapshot)
      setFsChange(change)
    })
    const offOpen = api.onOpenPath(async (p) => {
      const s = await api.getState()
      setState(s)
      const snap = await api.getIndex()
      setIndex(snap)
      // a file (from Finder, `open -a Motion`, the Dock); folders open as the workspace
      if (p !== snap?.root && /\.[a-z0-9]+$/i.test(p)) {
        // already open in a tab? switch to it
        const existing = tabsRef.current.find((t) => t.path === p)
        if (existing) activate(existing.id)
        else openFile(p, { newTab: !!currentRef.current })
      } else if (snap?.files.length && !(currentRef.current && within(currentRef.current.path, p))) {
        const tab = makeTab(defaultPage(snap.files))
        setTabs([tab])
        setActiveId(tab.id)
      }
    })
    const offFull = api.onFullscreen(setFullscreen)
    return () => {
      offFs()
      offOpen()
      offFull()
    }
  }, [openFile, activate])

  const commands = useRef<(cmd: MenuCommand) => void>(() => {})
  commands.current = (cmd: MenuCommand) => {
    const s = stateRef.current
    const cur = currentRef.current
    const ts = tabsRef.current
    const ai = ts.findIndex((t) => t.id === activeRef.current)
    if (cmd.startsWith('tab-')) {
      const n = Number(cmd.slice(4))
      const t = n === 9 ? ts[ts.length - 1] : ts[n - 1]
      if (t) activate(t.id)
      return
    }
    switch (cmd) {
      case 'new-page':
        if (s?.root) void newPage(cur ? dirOf(cur.path) : s.root)
        break
      case 'new-tab':
        newTab()
        break
      case 'close-tab':
        if (activeRef.current !== null) closeTab(activeRef.current)
        break
      case 'reopen-tab': {
        const p = closedTabs.current.pop()
        if (p) openFile(p, { newTab: true })
        break
      }
      case 'next-tab':
        if (ts.length > 1) activate(ts[(ai + 1) % ts.length].id)
        break
      case 'prev-tab':
        if (ts.length > 1) activate(ts[(ai - 1 + ts.length) % ts.length].id)
        break
      case 'open-folder':
        void api.openFolderDialog().then((r) => {
          if (r) void setRoot(r)
        })
        break
      case 'open-file':
        void api.openFileDialog()
        break
      case 'search':
        if (s?.root) setSearchOpen(true)
        break
      case 'toggle-sidebar':
        if (s) setPrefs({ sidebarOpen: !s.prefs.sidebarOpen })
        break
      case 'toggle-source':
        if (cur && isMarkdownPath(cur.path)) setSourceMode((m) => !m)
        break
      case 'toggle-full-width':
        if (s) setPrefs({ fullWidth: !s.prefs.fullWidth })
        break
      case 'toggle-small-text':
        if (s) setPrefs({ smallText: !s.prefs.smallText })
        break
      case 'font-default':
      case 'font-serif':
      case 'font-mono':
        setPrefs({ font: cmd.slice(5) as Prefs['font'] })
        break
      case 'theme-system':
      case 'theme-light':
      case 'theme-dark':
        setState((x) => (x ? { ...x, prefs: { ...x.prefs, theme: cmd.slice(6) as Prefs['theme'] } } : x))
        break
      case 'back':
        step(-1)
        break
      case 'forward':
        step(1)
        break
      case 'reveal':
        if (cur) void api.reveal(cur.path)
        break
      case 'copy-path':
        if (cur) {
          void api.copyText(cur.path)
          showToast('Copied path')
        }
        break
      case 'reload-file':
        if (cur && active) {
          pageRef.current?.flush()
          setTabs((xs) => xs.map((t) => (t.id === active.id ? { ...t, docId: ++docCounter } : t)))
        }
        break
      case 'find':
        if (cur && !sourceMode) setFind({ open: true })
        break
    }
  }
  useEffect(() => api.onMenu((cmd) => commands.current(cmd)), [])

  const expanded = useMemo(() => new Set(state?.expanded ?? []), [state?.expanded])
  const titles = useMemo(
    () =>
      new Map([
        ...(index?.files ?? []).map((f): [string, string] => [f.path, f.title || stemOf(f.path)]),
        ...(index?.others ?? []).map((f): [string, string] => [f.path, f.name])
      ]),
    [index]
  )
  const showAll = state?.prefs.showAllFiles ?? true
  const sidebarFiles = useMemo(
    () => (!index ? [] : showAll ? [...index.files, ...(index.others ?? [])] : index.files),
    [index, showAll]
  )

  // "seen" = the version of each file you last had open; anything newer, not saved by us, gets a dot
  const currentPath = current?.path ?? null
  useEffect(() => {
    const s = stateRef.current
    if (!s || !index || !currentPath) return
    const f = index.files.find((x) => x.path === currentPath) ?? index.others?.find((x) => x.path === currentPath)
    if (f && s.seen?.[f.path] !== f.mtime) patchState({ seen: { ...(s.seen ?? {}), [f.path]: f.mtime } })
  }, [index, currentPath, patchState])
  const unseen = useMemo(() => {
    const out = new Set<string>()
    if (!state || !index) return out
    for (const f of sidebarFiles) {
      if (f.byMotion || f.path === currentPath) continue
      if (f.mtime > (state.seen?.[f.path] ?? state.seenSince ?? Infinity) + 1) out.add(f.path)
    }
    return out
  }, [sidebarFiles, state, index, currentPath])

  useEffect(() => {
    document.title = current ? meta.title || 'Motion' : 'Motion'
  }, [current, meta.title])

  if (!state) return <div className="app" />

  if (!state.root || !index) {
    return (
      <div className="app">
        <div className="main">
          <div className={`tabbar no-sidebar${fullscreen ? ' fullscreen' : ''}`} />
          <Welcome
            recent={state.recentRoots}
            onOpen={(r) => void setRoot(r)}
            onPick={() =>
              void api.openFolderDialog().then((r) => {
                if (r) void setRoot(r)
              })
            }
          />
        </div>
      </div>
    )
  }

  const prefs = state.prefs
  const tabViews = tabs.map((t) => ({
    id: t.id,
    path: t.path,
    title: !t.path ? 'New tab' : t.id === activeId && meta.title ? meta.title : titles.get(t.path) ?? stemOf(t.path)
  }))

  return (
    <div className="app">
        <Sidebar
          root={state.root}
          files={sidebarFiles}
          unseen={unseen}
          showAllFiles={showAll}
          onToggleAllFiles={() => setPrefs({ showAllFiles: !showAll })}
          current={current?.path ?? null}
          expanded={expanded}
          favorites={state.favorites}
          recentRoots={state.recentRoots}
          width={prefs.sidebarWidth}
          open={prefs.sidebarOpen}
          onOpen={(p, opts) => openFile(p, opts)}
          onToggle={(rel) => {
            const next = new Set(expanded)
            if (next.has(rel)) next.delete(rel)
            else next.add(rel)
            patchState({ expanded: [...next] })
          }}
          onNewPage={(dir) => void newPage(dir)}
          onNewFolder={(dir) =>
            void api.createFolder(dir).then((p) => {
              createdPages.add(p)
              openFile(p)
            })
          }
          onSearch={() => setSearchOpen(true)}
          onOpenFolder={(r) => {
            if (r) void setRoot(r)
            else
              void api.openFolderDialog().then((x) => {
                if (x) void setRoot(x)
              })
          }}
          onCollapse={() => setPrefs({ sidebarOpen: false })}
          onResize={(w) => setState((s) => (s ? { ...s, prefs: { ...s.prefs, sidebarWidth: w } } : s))}
          onRename={(from, to) => void rename(from, to)}
          onTrash={(p) => void trash(p)}
          onDuplicate={(p) => void api.duplicate(p).then((np) => openFile(np))}
          onToggleFavorite={(p) =>
            patchState({ favorites: state.favorites.includes(p) ? state.favorites.filter((f) => f !== p) : [...state.favorites, p] })
          }
          onMove={(from, toDir) => {
            const to = joinPath(toDir, baseOf(from))
            if (to !== from && dirOf(from) !== toDir) void rename(from, to)
          }}
          fullscreen={fullscreen}
        />
        <SidebarWidthPersist width={prefs.sidebarWidth} />
        <main className="main">
        <Tabbar
          tabs={tabViews}
          activeId={activeId}
          fullscreen={fullscreen}
          sidebarOpen={prefs.sidebarOpen}
          canBack={!!active?.back.length}
          canForward={!!active?.fwd.length}
          onToggleSidebar={() => setPrefs({ sidebarOpen: !prefs.sidebarOpen })}
          onBack={() => step(-1)}
          onForward={() => step(1)}
          onSelect={activate}
          onClose={closeTab}
          onNew={newTab}
          onMove={moveTab}
          onDropPath={(p, i) => {
            const tab = makeTab(p)
            setTabs((ts) => [...ts.slice(0, i), tab, ...ts.slice(i)])
            pageRef.current?.flush()
            setActiveId(tab.id)
            resetPageUi()
          }}
          onMenu={(id) => {
            const t = tabsRef.current.find((tt) => tt.id === id)
            void api
              .showContextMenu([
                { id: 'close', label: 'Close Tab' },
                { id: 'others', label: 'Close Other Tabs', enabled: tabsRef.current.length > 1 },
                { id: 'right', label: 'Close Tabs to the Right' },
                { id: 'sep', label: '', type: 'separator' },
                { id: 'dup', label: 'Duplicate Tab', enabled: !!t?.path },
                { id: 'reveal', label: 'Reveal in Finder', enabled: !!t?.path }
              ])
              .then((pick) => {
                const ts = tabsRef.current
                const i = ts.findIndex((tt) => tt.id === id)
                if (pick === 'close') closeTab(id)
                else if (pick === 'others') {
                  for (const o of ts) if (o.id !== id) closeTab(o.id)
                  activate(id)
                } else if (pick === 'right') for (const o of ts.slice(i + 1)) closeTab(o.id)
                else if (pick === 'dup' && t?.path) {
                  const tab = makeTab(t.path)
                  setTabs((xs) => [...xs.slice(0, i + 1), tab, ...xs.slice(i + 1)])
                } else if (pick === 'reveal' && t?.path) void api.reveal(t.path)
              })
          }}
        />
          <Topbar
            root={state.root}
            path={current?.path ?? null}
            title={meta.title}
            status={meta.status}
            mtime={meta.mtime}
            sidebarOpen={prefs.sidebarOpen}
            prefs={prefs}
            sourceMode={sourceMode}
            favorite={!!current && state.favorites.includes(current.path)}
            canBack={!!active?.back.length}
            canForward={!!active?.fwd.length}
            onBack={() => step(-1)}
            onForward={() => step(1)}
            onOpenSidebar={() => setPrefs({ sidebarOpen: true })}
            onCrumb={(rel) => {
              if (!rel) return
              const next = new Set(expanded)
              let acc = ''
              for (const part of rel.split('/')) {
                acc = acc ? acc + '/' + part : part
                next.add(acc)
              }
              patchState({ expanded: [...next], prefs: { ...prefs, sidebarOpen: true } })
            }}
            onToggleSource={() => setSourceMode((m) => !m)}
            onToggleFavorite={() =>
              current &&
              patchState({
                favorites: state.favorites.includes(current.path)
                  ? state.favorites.filter((f) => f !== current.path)
                  : [...state.favorites, current.path]
              })
            }
            onPrefs={setPrefs}
            onSearch={() => setSearchOpen(true)}
            words={() => pageRef.current?.words() ?? 0}
            onAddProperties={() => pageRef.current?.addProperties()}
          />
          <div className="scroller">
            {current && current.path && !isMarkdownPath(current.path) ? (
              <CodeView key={current.id} ref={pageRef} path={current.path} prefs={prefs} fsChange={fsChange} onMeta={setMeta} toast={showToast} />
            ) : current ? (
              <PageView
                key={current.id}
                ref={pageRef}
                path={current.path}
                docId={current.id}
                files={index.files}
                prefs={prefs}
                sourceMode={sourceMode}
                fsChange={fsChange}
                findOpen={find.open}
                findQuery={find.query}
                onCloseFind={() => setFind({ open: false })}
                onNavigate={(p, opts) => openFile(p, opts)}
                onRenamed={onRenamed}
                onMeta={setMeta}
                toast={showToast}
              />
            ) : (
              <div className="empty-page">
                {index.files.length ? 'Select a page in the sidebar, or press ⌘P to search.' : 'No markdown files here yet — press ⌘N to create one.'}
              </div>
            )}
          </div>
        </main>
      {searchOpen && (
        <SearchModal
          files={sidebarFiles}
          recent={state.recentFiles}
          onClose={() => setSearchOpen(false)}
          onOpen={(p, _line, q, newTabRequested) => {
            setSearchOpen(false)
            openFile(p, { find: q && q.trim().length > 1 ? q.trim() : undefined, newTab: newTabRequested })
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

/** Persist sidebar width after resizing settles. */
function SidebarWidthPersist({ width }: { width: number }) {
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(() => void api.getState().then((s) => api.setState({ prefs: { ...s.prefs, sidebarWidth: width } })), 300)
    return () => clearTimeout(t)
  }, [width])
  return null
}

function Welcome({ recent, onOpen, onPick }: { recent: string[]; onOpen(r: string): void; onPick(): void }) {
  return (
    <div className="welcome">
      <LogoMark size={56} />
      <h1>Motion</h1>
      <p>A Notion-style editor for the markdown files in a folder. Everything saves straight to the .md files on disk.</p>
      <button className="primary-button" onClick={onPick}>
        Open folder…
      </button>
      {recent.length > 0 && (
        <div className="recent-roots">
          <div className="label">Recent</div>
          {recent.map((r) => (
            <button key={r} onClick={() => onOpen(r)}>
              <span className="name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <FolderOpenIcon size={16} /> {baseOf(r)}
              </span>
              <span className="path">{r.replace(/^\/Users\/[^/]+/, '~')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
