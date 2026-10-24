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
  screen
} from 'electron'
import { promises as fsp, existsSync, statSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join, dirname, basename, extname, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import type { AppState, FsChange, MenuCommand, Prefs, WriteOptions, WriteResult } from '@shared/types'
import { Workspace } from './workspace'
import { buildMenu } from './menu'

const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  font: 'default',
  smallText: false,
  fullWidth: false,
  sidebarOpen: true,
  sidebarWidth: 248,
  spellcheck: true,
  showAllFiles: true
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

// Allow a separate profile for tests/dev: MOTION_USER_DATA=/tmp/x
if (process.env.MOTION_USER_DATA) app.setPath('userData', process.env.MOTION_USER_DATA)

const statePath = () => join(app.getPath('userData'), 'state.json')
const boundsPath = () => join(app.getPath('userData'), 'window.json')

function loadState(): AppState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    const loaded = { ...DEFAULT_STATE, ...raw, prefs: { ...DEFAULT_PREFS, ...(raw.prefs || {}) } }
    if (!loaded.seenSince) loaded.seenSince = Date.now()
    return loaded
  } catch {
    return { ...DEFAULT_STATE, seenSince: Date.now() }
  }
}

let state = loadState()
let saveTimer: NodeJS.Timeout | null = null
function persistState() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(statePath(), JSON.stringify(state, null, 2))
    } catch {
      /* ignore */
    }
  }, 200)
}

let win: BrowserWindow | null = null
let workspace: Workspace | null = null
let pendingOpen: string | null = null

protocol.registerSchemesAsPrivileged([
  { scheme: 'motion-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

async function setRoot(root: string | null) {
  workspace?.dispose()
  workspace = null
  state.root = root
  if (root) {
    state.recentRoots = [root, ...state.recentRoots.filter((r) => r !== root)].slice(0, 10)
    workspace = new Workspace(root, (change: FsChange) => send('fs:change', change))
    await workspace.init()
    app.addRecentDocument(root)
  }
  persistState()
  return workspace?.snapshot() ?? null
}

/** Pick a workspace root for a path opened from Finder/CLI. */
function rootFor(p: string): string {
  let dir = dirname(p)
  for (let d = dir; d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
  }
  return dir
}

async function openPath(p: string) {
  const abs = resolve(p)
  if (!existsSync(abs)) return
  const isDir = statSync(abs).isDirectory()
  if (isDir) {
    if (state.root !== abs) await setRoot(abs)
    send('app:open-path', abs)
    return
  }
  if (!state.root || !abs.startsWith(state.root + sep)) await setRoot(rootFor(abs))
  send('app:open-path', abs)
}

function loadBounds(): Electron.Rectangle | null {
  try {
    const b = JSON.parse(readFileSync(boundsPath(), 'utf8'))
    const area = screen.getDisplayMatching(b).workArea
    if (b.x >= area.x - 50 && b.y >= area.y - 50 && b.width > 400 && b.height > 300) return b
  } catch {
    /* none */
  }
  return null
}

function createWindow() {
  const bounds = loadBounds()
  win = new BrowserWindow({
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

  win.once('ready-to-show', () => win?.show())
  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    try {
      writeFileSync(boundsPath(), JSON.stringify(win.getBounds()))
    } catch {
      /* ignore */
    }
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('closed', () => {
    win = null
  })
  win.on('enter-full-screen', () => send('window:fullscreen', true))
  win.on('leave-full-screen', () => send('window:fullscreen', false))

  // Links never navigate the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:|^mailto:/.test(url)) void shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function menuCommand(cmd: MenuCommand) {
  if (cmd === 'theme-system' || cmd === 'theme-light' || cmd === 'theme-dark') {
    const theme = cmd.slice(6) as Prefs['theme']
    state.prefs = { ...state.prefs, theme }
    nativeTheme.themeSource = theme
    persistState()
  }
  send('menu', cmd)
}

function registerIpc() {
  ipcMain.handle('app:getState', () => state)
  ipcMain.handle('app:setState', (_e, patch: Partial<AppState>) => {
    state = { ...state, ...patch, prefs: { ...state.prefs, ...(patch.prefs || {}) } }
    if (patch.prefs?.theme) nativeTheme.themeSource = patch.prefs.theme
    persistState()
    return state
  })

  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: state.root ?? app.getPath('home')
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:openFile', async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      defaultPath: state.root ?? app.getPath('home')
    })
    if (r.canceled) return null
    await openPath(r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('ws:setRoot', (_e, root: string | null) => setRoot(root))
  ipcMain.handle('ws:index', () => workspace?.snapshot() ?? null)
  ipcMain.handle('ws:search', (_e, q: string) => workspace?.search(q) ?? [])

  ipcMain.handle('fs:read', async (_e, p: string) => {
    const [content, st] = await Promise.all([fsp.readFile(p, 'utf8'), fsp.stat(p)])
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
  ipcMain.handle('fs:write', async (_e, p: string, content: string, opts: WriteOptions = {}): Promise<WriteResult> => {
    const refused = checkWrite(p, opts, readOrNull(p))
    if (refused) return refused
    // synchronous on purpose: the check and the write can't interleave with fs:writeSync
    try {
      if (opts.create) mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content, 'utf8')
      const st = statSync(p)
      workspace?.noteWrite(p, content, st.mtimeMs, st.size)
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
      workspace?.noteWrite(p, content, st.mtimeMs, st.size)
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
    workspace?.noteWrite(p, content, st.mtimeMs, st.size)
    await workspace?.refresh()
    return p
  })
  ipcMain.handle('fs:createFolder', async (_e, dir: string) => {
    let p = join(dir, 'Untitled folder')
    for (let i = 1; existsSync(p); i++) p = join(dir, `Untitled folder ${i}`)
    await fsp.mkdir(p, { recursive: true })
    const page = join(p, 'Untitled.md')
    await fsp.writeFile(page, '')
    await workspace?.refresh()
    return page
  })
  ipcMain.handle('fs:rename', async (_e, from: string, to: string) => {
    if (from === to) return to
    if (existsSync(to) && from.toLowerCase() !== to.toLowerCase()) throw new Error('A file with that name already exists')
    await fsp.mkdir(dirname(to), { recursive: true })
    await fsp.rename(from, to)
    state.recentFiles = state.recentFiles.map((f) => (f === from ? to : f.startsWith(from + sep) ? to + f.slice(from.length) : f))
    state.favorites = state.favorites.map((f) => (f === from ? to : f))
    if (state.lastFile === from) state.lastFile = to
    persistState()
    await workspace?.refresh()
    return to
  })
  ipcMain.handle('fs:duplicate', async (_e, p: string) => {
    const ext = extname(p)
    const target = unique(dirname(p), basename(p, ext) + ' copy', ext)
    await fsp.copyFile(p, target)
    await workspace?.refresh()
    return target
  })
  ipcMain.handle('fs:confirmTrash', async (_e, p: string) => {
    const isDir = existsSync(p) && statSync(p).isDirectory()
    const r = await dialog.showMessageBox(win!, {
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
    await workspace?.refresh()
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

  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
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
  if (app.isReady() && win) void openPath(p)
  else pendingOpen = p
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const p = argv.slice(1).find((a) => !a.startsWith('-') && existsSync(a) && a !== process.execPath)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    if (p) void openPath(p)
  })

  app.whenReady().then(async () => {
    nativeTheme.themeSource = state.prefs.theme
    protocol.handle('motion-asset', (req) => {
      const url = new URL(req.url)
      const p = decodeURIComponent(url.pathname)
      return net.fetch(pathToFileURL(p).toString())
    })
    registerIpc()
    Menu.setApplicationMenu(buildMenu(menuCommand))

    const argPath = process.argv
      .slice(app.isPackaged ? 1 : 2)
      .find((a) => !a.startsWith('-') && existsSync(a))
    const initial = pendingOpen ?? argPath ?? null
    if (initial) {
      const abs = resolve(initial)
      if (statSync(abs).isDirectory()) await setRoot(abs)
      else {
        if (!state.root || !abs.startsWith(state.root + sep)) await setRoot(rootFor(abs))
        state.lastFile = abs
      }
    } else if (state.root && existsSync(state.root)) {
      await setRoot(state.root)
    } else {
      state.root = null
    }
    createWindow()
    pendingOpen = null

    app.on('activate', () => {
      if (!win) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    workspace?.dispose()
    app.quit()
  })
}

