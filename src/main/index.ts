import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net,
  nativeTheme,
  clipboard,
  Menu,
  screen,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { promises as fsp, existsSync, statSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join, dirname, basename, extname, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { WINDOW_KEYS, type AppState, type FsChange, type MenuCommand, type Prefs, type WindowState, type WriteOptions, type WriteResult } from '@shared/types'
import { Workspace } from './workspace'
import { buildMenu } from './menu'
import { checkForUpdates, initUpdater, installUpdate, updateReady } from './updater'

const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  font: 'default',
  smallText: false,
  fullWidth: false,
  sidebarOpen: true,
  sidebarWidth: 248,
  spellcheck: true,
  showAllFiles: true,
  showIgnored: false
}

const DEFAULT_STATE: AppState = {
  root: null,
  recentRoots: [],
  recentFiles: [],
  lastFile: null,
  expanded: [],
  favorites: [],
  tabs: [],
  activeTab: 0,
  seen: {},
  seenSince: 0,
  prefs: DEFAULT_PREFS
}

/** One window's own state, persisted so every window reopens on relaunch. */
interface WindowSession extends WindowState {
  bounds?: Electron.Rectangle
}

/** On disk: the shared state plus one session per window. The top-level window
 *  fields are only read once, to migrate state saved before there were windows. */
type Persisted = AppState & { windows?: WindowSession[] }

const emptySession = (root: string | null = null): WindowSession => ({ root, tabs: [], activeTab: 0, lastFile: null, expanded: [] })

// Allow a separate profile for tests/dev: MOTION_USER_DATA=/tmp/x
if (process.env.MOTION_USER_DATA) app.setPath('userData', process.env.MOTION_USER_DATA)

const statePath = () => join(app.getPath('userData'), 'state.json')
const boundsPath = () => join(app.getPath('userData'), 'window.json')

function loadState(): Persisted {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    const loaded: Persisted = { ...DEFAULT_STATE, ...raw, prefs: { ...DEFAULT_PREFS, ...(raw.prefs || {}) } }
    if (!loaded.seenSince) loaded.seenSince = Date.now()
    if (!loaded.windows) {
      const { root, tabs, activeTab, lastFile, expanded } = loaded
      loaded.windows = root ? [{ root, tabs, activeTab, lastFile, expanded }] : []
    }
    return loaded
  } catch {
    return { ...DEFAULT_STATE, seenSince: Date.now(), windows: [] }
  }
}

let state = loadState()

interface WindowCtx {
  id: number
  win: BrowserWindow
  session: WindowSession
  workspace: Workspace | null
}
const windows = new Map<number, WindowCtx>()
let quitting = false
/** files opened before the app was ready (Finder sends them as open-file events at launch) */
const pendingOpen: string[] = []

const live = () => [...windows.values()].filter((c) => !c.win.isDestroyed())

let saveTimer: NodeJS.Timeout | null = null
function persistNow() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const sessions = [...windows.values()].map((c) => c.session)
    writeFileSync(statePath(), JSON.stringify({ ...state, ...emptySession(), windows: sessions }, null, 2))
  } catch {
    /* ignore */
  }
}
function persistState() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(persistNow, 200)
}

/** What a window's renderer sees: the shared state with its own window fields on top. */
function viewOf(ctx: WindowCtx): AppState {
  const { windows: _, ...shared } = state
  const { bounds: __, ...own } = ctx.session
  return { ...shared, ...own }
}

function sharedOf(): Partial<AppState> {
  const { windows: _, ...shared } = state
  for (const k of WINDOW_KEYS) delete (shared as Partial<AppState>)[k]
  return shared
}

/** Tell the other windows that shared state (prefs, favorites, recents…) changed. */
function broadcastShared(except?: WindowCtx) {
  const shared = sharedOf()
  for (const c of live()) if (c !== except) c.win.webContents.send('app:shared-state', shared)
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'motion-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

function send(ctx: WindowCtx, channel: string, payload: unknown) {
  if (!ctx.win.isDestroyed()) ctx.win.webContents.send(channel, payload)
}

function ctxOf(e: IpcMainInvokeEvent | IpcMainEvent): WindowCtx {
  const ctx = windows.get(e.sender.id)
  if (!ctx) throw new Error('No window for this renderer')
  return ctx
}

const within = (p: string, root: string) => p === root || p.startsWith(root + sep)

/** The workspaces that index `p`, so their watchers know a write was ours. */
const workspacesFor = (p: string) =>
  live()
    .map((c) => c.workspace)
    .filter((w): w is Workspace => !!w && within(p, w.root))

async function setRoot(ctx: WindowCtx, root: string | null) {
  ctx.workspace?.dispose()
  ctx.workspace = null
  ctx.session.root = root
  if (root) {
    state.recentRoots = [root, ...state.recentRoots.filter((r) => r !== root)].slice(0, 10)
    ctx.workspace = new Workspace(root, (change: FsChange) => send(ctx, 'fs:change', change), () => state.prefs.showIgnored)
    await ctx.workspace.init()
    for (const p of [ctx.session.lastFile, ...ctx.session.tabs]) if (p && within(p, root)) await ctx.workspace.include(p)
    app.addRecentDocument(root)
    broadcastShared(ctx)
  }
  persistState()
  return ctx.workspace?.snapshot() ?? null
}

/** Pick a workspace root for a path opened from Finder/CLI. */
function rootFor(p: string): string {
  let dir = dirname(p)
  for (let d = dir; d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
  }
  return dir
}

function focus(ctx: WindowCtx) {
  if (ctx.win.isMinimized()) ctx.win.restore()
  ctx.win.focus()
}

/**
 * Open a file or folder from Finder, the CLI or Open File…. It goes to the window
 * already showing its folder, else an empty window, else a new one, so a window's
 * workspace never changes underneath its open tabs.
 */
async function openPath(p: string, from?: WindowCtx) {
  const abs = resolve(p)
  if (!existsSync(abs)) return
  const isDir = statSync(abs).isDirectory()
  const owner = live()
    .filter((c) => c.session.root && (isDir ? c.session.root === abs : within(abs, c.session.root)))
    .sort((a, b) => b.session.root!.length - a.session.root!.length)[0] // nested workspaces: the closest wins
  if (owner) {
    if (!isDir) await owner.workspace?.include(abs)
    focus(owner)
    send(owner, 'app:open-path', abs)
    return
  }
  const root = isDir ? abs : rootFor(abs)
  const empty = from && !from.session.root ? from : live().find((c) => !c.session.root)
  if (empty) {
    await setRoot(empty, root)
    if (!isDir) {
      empty.session.lastFile = abs
      await empty.workspace?.include(abs)
    }
    focus(empty)
    send(empty, 'app:open-path', abs)
    return
  }
  await createWindow({ ...emptySession(root), lastFile: isDir ? null : abs })
}

function onScreen(b: Electron.Rectangle | null | undefined): Electron.Rectangle | null {
  if (!b) return null
  const area = screen.getDisplayMatching(b).workArea
  return b.x >= area.x - 50 && b.y >= area.y - 50 && b.width > 400 && b.height > 300 ? b : null
}

/** Bounds saved before there were windows (window.json) seed the first one. */
function legacyBounds(): Electron.Rectangle | null {
  try {
    return onScreen(JSON.parse(readFileSync(boundsPath(), 'utf8')))
  } catch {
    return null
  }
}

/** New windows open offset from the focused one, like Finder's. */
function cascadeBounds(): Electron.Rectangle | null {
  const ref = BrowserWindow.getFocusedWindow() ?? live().at(-1)?.win
  if (!ref) return null
  const b = ref.getBounds()
  return onScreen({ ...b, x: b.x + 28, y: b.y + 28 }) ?? b
}

async function createWindow(session: WindowSession = emptySession()): Promise<WindowCtx> {
  const bounds = onScreen(session.bounds) ?? cascadeBounds() ?? legacyBounds()
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 860,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 560,
    minHeight: 400,
    show: false,
    title: 'Motion',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: state.prefs.spellcheck
    }
  })
  const ctx: WindowCtx = { id: win.webContents.id, win, session: { ...session }, workspace: null }
  windows.set(ctx.id, ctx)
  // the workspace must be indexed before the renderer asks for it
  const root = session.root && existsSync(session.root) ? session.root : null
  await setRoot(ctx, root)

  win.once('ready-to-show', () => win.show())
  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    ctx.session.bounds = win.getBounds()
    persistState()
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('closed', () => {
    ctx.workspace?.dispose()
    ctx.workspace = null
    // a window closed on its own is forgotten; quitting, or closing the last one, keeps it for next launch
    if (!quitting && live().length > 0) windows.delete(ctx.id)
    persistNow()
  })
  // the renderer blocks closing while a page has suggestions; closing accepts them
  win.webContents.on('will-prevent-unload', (e) => {
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      message: 'Accept all suggestions?',
      detail: 'Closing the window accepts the outside edits shown as suggestions. They stay in the files either way.',
      buttons: ['Accept All and Close', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    })
    if (r === 0) e.preventDefault()
    else quitting = false
  })
  win.webContents.on('did-finish-load', () => {
    const version = updateReady()
    if (version) send(ctx, 'app:update-ready', version)
  })
  win.on('enter-full-screen', () => send(ctx, 'window:fullscreen', true))
  win.on('leave-full-screen', () => send(ctx, 'window:fullscreen', false))

  // Links never navigate the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:|^mailto:/.test(url)) void shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return ctx
}

function menuCommand(cmd: MenuCommand) {
  // ⌘⇧L flips whatever is showing, so pressing it again always undoes it
  if (cmd === 'toggle-dark') cmd = nativeTheme.shouldUseDarkColors ? 'theme-light' : 'theme-dark'
  if (cmd === 'new-window') {
    void createWindow()
    return
  }
  if (cmd === 'check-updates') {
    checkForUpdates()
    return
  }
  if (cmd === 'theme-system' || cmd === 'theme-light' || cmd === 'theme-dark') {
    const theme = cmd.slice(6) as Prefs['theme']
    state.prefs = { ...state.prefs, theme }
    nativeTheme.themeSource = theme
    persistState()
    broadcastShared()
  }
  const target = BrowserWindow.getFocusedWindow() ?? live().at(-1)?.win
  if (target && !target.isDestroyed()) target.webContents.send('menu', cmd)
}

function registerIpc() {
  ipcMain.handle('app:getState', (e) => viewOf(ctxOf(e)))
  ipcMain.handle('app:setState', (e, patch: Partial<AppState>) => {
    const ctx = ctxOf(e)
    const own: Partial<WindowState> = {}
    const shared: Partial<AppState> = { ...patch }
    for (const k of WINDOW_KEYS) {
      if (k in patch) Object.assign(own, { [k]: patch[k] })
      delete shared[k]
    }
    ctx.session = { ...ctx.session, ...own }
    if (Object.keys(shared).length) {
      const showedIgnored = state.prefs.showIgnored
      state = { ...state, ...shared, prefs: { ...state.prefs, ...(shared.prefs || {}) } }
      if (shared.prefs?.theme) nativeTheme.themeSource = shared.prefs.theme
      if (state.prefs.showIgnored !== showedIgnored) for (const c of live()) void c.workspace?.rescan()
      broadcastShared(ctx)
    }
    persistState()
    return viewOf(ctx)
  })

  ipcMain.handle('dialog:openFolder', async (e) => {
    const ctx = ctxOf(e)
    const r = await dialog.showOpenDialog(ctx.win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: ctx.session.root ?? app.getPath('home')
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:openFile', async (e) => {
    const ctx = ctxOf(e)
    const r = await dialog.showOpenDialog(ctx.win, {
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      defaultPath: ctx.session.root ?? app.getPath('home')
    })
    if (r.canceled) return null
    await openPath(r.filePaths[0], ctx)
    return r.filePaths[0]
  })

  ipcMain.handle('ws:setRoot', (e, root: string | null) => setRoot(ctxOf(e), root))
  ipcMain.handle('ws:index', (e) => ctxOf(e).workspace?.snapshot() ?? null)
  ipcMain.handle('ws:search', (e, q: string) => ctxOf(e).workspace?.search(q) ?? [])

  ipcMain.handle('fs:read', async (_e, p: string) => {
    const [content, st] = await Promise.all([fsp.readFile(p, 'utf8'), fsp.stat(p)])
    for (const w of workspacesFor(p)) void w.include(p)
    return { content, mtime: st.mtimeMs }
  })
  ipcMain.handle('fs:exists', (_e, p: string) => existsSync(p))
  // Writes are compare-and-swap: the renderer says what it believes is on disk, and we
  // refuse (returning the disk text) if someone else changed the file meanwhile, or if
  // it was deleted/moved — so Claude's edits are never silently overwritten.
  const checkWrite = (p: string, opts: WriteOptions, disk: string | null): WriteResult | null => {
    if (disk === null) return opts.create ? null : { ok: false, reason: 'missing' }
    if (!opts.force && opts.expected !== undefined && disk !== opts.expected) return { ok: false, reason: 'conflict', disk }
    return null
  }
  const readOrNull = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  }
  const noteWrite = (p: string, content: string, mtime: number, size: number) => {
    for (const w of workspacesFor(p)) w.noteWrite(p, content, mtime, size)
  }
  const refresh = async (p: string) => {
    await Promise.all(workspacesFor(p).map((w) => w.refresh()))
  }
  ipcMain.handle('fs:write', async (_e, p: string, content: string, opts: WriteOptions = {}): Promise<WriteResult> => {
    const refused = checkWrite(p, opts, readOrNull(p))
    if (refused) return refused
    // synchronous on purpose: the check and the write can't interleave with fs:writeSync
    try {
      if (opts.create) mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content, 'utf8')
      const st = statSync(p)
      noteWrite(p, content, st.mtimeMs, st.size)
      return { ok: true, mtime: st.mtimeMs }
    } catch (err) {
      return { ok: false, reason: 'error', message: String(err) }
    }
  })
  ipcMain.on('fs:writeSync', (e, p: string, content: string, opts: WriteOptions = {}) => {
    try {
      const refused = checkWrite(p, opts, readOrNull(p))
      if (refused) {
        e.returnValue = refused
        return
      }
      if (opts.create) mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content, 'utf8')
      const st = statSync(p)
      noteWrite(p, content, st.mtimeMs, st.size)
      e.returnValue = { ok: true, mtime: st.mtimeMs }
    } catch (err) {
      e.returnValue = { ok: false, reason: 'error', message: String(err) }
    }
  })

  const unique = (dir: string, stem: string, ext: string) => {
    let name = `${stem}${ext}`
    for (let i = 1; existsSync(join(dir, name)); i++) name = `${stem} ${i}${ext}`
    return join(dir, name)
  }

  ipcMain.handle('fs:createPage', async (_e, dir: string, name?: string, content = '') => {
    await fsp.mkdir(dir, { recursive: true })
    const p = unique(dir, name || 'Untitled', '.md')
    await fsp.writeFile(p, content, { flag: 'wx' })
    const st = await fsp.stat(p)
    noteWrite(p, content, st.mtimeMs, st.size)
    await refresh(p)
    return p
  })
  ipcMain.handle('fs:createFolder', async (_e, dir: string) => {
    let p = join(dir, 'Untitled folder')
    for (let i = 1; existsSync(p); i++) p = join(dir, `Untitled folder ${i}`)
    await fsp.mkdir(p, { recursive: true })
    const page = join(p, 'Untitled.md')
    await fsp.writeFile(page, '')
    await refresh(page)
    return page
  })
  ipcMain.handle('fs:rename', async (_e, from: string, to: string) => {
    if (from === to) return to
    if (existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error('A file with that name already exists')
    await fsp.mkdir(dirname(to), { recursive: true })
    await fsp.rename(from, to)
    state.recentFiles = state.recentFiles.map((f) => (f === from ? to : f.startsWith(from + sep) ? to + f.slice(from.length) : f))
    state.favorites = state.favorites.map((f) => (f === from ? to : f))
    for (const c of windows.values()) if (c.session.lastFile === from) c.session.lastFile = to
    persistState()
    broadcastShared()
    await Promise.all([refresh(from), refresh(to)])
    return to
  })
  ipcMain.handle('fs:duplicate', async (_e, p: string) => {
    const ext = extname(p)
    const target = unique(dirname(p), basename(p, ext) + ' copy', ext)
    await fsp.copyFile(p, target)
    await refresh(target)
    return target
  })
  ipcMain.handle('fs:confirmTrash', async (e, p: string) => {
    const isDir = existsSync(p) && statSync(p).isDirectory()
    const r = await dialog.showMessageBox(ctxOf(e).win, {
      type: 'warning',
      buttons: ['Move to Trash', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Move “${basename(p)}” to the Trash?`,
      detail: isDir ? 'The folder and everything in it will be moved to the Trash.' : 'You can restore it from the Trash in Finder.'
    })
    return r.response === 0
  })
  ipcMain.handle('fs:trash', async (_e, p: string) => {
    await shell.trashItem(p)
    await refresh(p)
    return true
  })
  ipcMain.handle('fs:saveAsset', async (_e, docPath: string, data: ArrayBuffer, ext: string) => {
    const dir = join(dirname(docPath), 'assets')
    await fsp.mkdir(dir, { recursive: true })
    const stem = basename(docPath, extname(docPath)).replace(/[^\w-]+/g, '-').slice(0, 40) || 'image'
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    let name = `${stem}-${stamp}.${ext}`
    for (let i = 1; existsSync(join(dir, name)); i++) name = `${stem}-${stamp}-${i}.${ext}`
    await fsp.writeFile(join(dir, name), Buffer.from(data))
    return `assets/${name}`
  })

  ipcMain.handle('dialog:confirm', async (e, message: string, detail: string, ok: string) => {
    const r = await dialog.showMessageBox(ctxOf(e).win, { type: 'warning', message, detail, buttons: [ok, 'Cancel'], defaultId: 0, cancelId: 1 })
    return r.response === 0
  })

  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('window:new', () => void createWindow())
  ipcMain.on('app:install-update', () => installUpdate())
  ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))

  ipcMain.handle('menu:context', (e, items: { id: string; label: string; enabled?: boolean; type?: 'separator' }[]) => {
    return new Promise<string | null>((resolvePick) => {
      let picked: string | null = null
      const menu = Menu.buildFromTemplate(
        items.map((it) =>
          it.type === 'separator'
            ? { type: 'separator' as const }
            : { label: it.label, enabled: it.enabled !== false, click: () => (picked = it.id) }
        )
      )
      menu.popup({
        window: BrowserWindow.fromWebContents(e.sender) ?? undefined,
        callback: () => setTimeout(() => resolvePick(picked), 0)
      })
    })
  })
}

// Finder "Open With", `open -a Motion file.md`, dock drops
app.on('open-file', (e, p) => {
  e.preventDefault()
  if (app.isReady() && live().length) void openPath(p)
  else pendingOpen.push(p)
})

const argPaths = () =>
  process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && existsSync(a) && a !== process.execPath)

{
  // a second launch hands its files to the running instance, then quits
  app.on('second-instance', (_e, argv, _cwd, data) => {
    const sent = (data as { open?: string[] } | null)?.open ?? []
    const paths = sent.length ? sent : argv.slice(1).filter((a) => !a.startsWith('-') && existsSync(a) && a !== process.execPath)
    if (paths.length) for (const p of paths) void openPath(p)
    else {
      const last = live().at(-1)
      if (last) focus(last)
    }
  })

  app.whenReady().then(async () => {
    // the lock is taken only now: a launch from Finder gets its file as an open-file
    // event before ready, and must pass it along rather than quit without it
    if (!app.requestSingleInstanceLock({ open: [...pendingOpen, ...argPaths()] })) {
      app.quit()
      return
    }
    nativeTheme.themeSource = state.prefs.theme
    protocol.handle('motion-asset', (req) => {
      const url = new URL(req.url)
      const p = decodeURIComponent(url.pathname)
      return net.fetch(pathToFileURL(p).toString())
    })
    registerIpc()
    Menu.setApplicationMenu(buildMenu(menuCommand))

    const initial = [...pendingOpen, ...argPaths()]
    pendingOpen.length = 0

    // reopen every window from last time, then route anything opened at launch
    const sessions = (state.windows ?? []).filter((s) => s.root && existsSync(s.root))
    state.windows = undefined
    for (const s of sessions) await createWindow(s)
    for (const p of initial) await openPath(p)
    if (!live().length) await createWindow()
    initUpdater((version) => {
      for (const c of live()) send(c, 'app:update-ready', version)
    })

    app.on('activate', () => {
      if (!live().length) void createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('window-all-closed', () => {
    persistNow()
    app.quit()
  })
}
