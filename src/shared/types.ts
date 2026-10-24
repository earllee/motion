export interface FileEntry {
  /** absolute path */
  path: string
  /** path relative to the workspace root, `/`-separated */
  rel: string
  name: string
  mtime: number
  size: number
  /** first H1 or frontmatter title, if any */
  title: string | null
  /** the current version on disk was written by Motion */
  byMotion?: boolean
}

export interface IndexSnapshot {
  root: string
  /** markdown pages */
  files: FileEntry[]
  /** other text files (code, sql, txt…), opened as source */
  others: FileEntry[]
}

export type ThemePref = 'system' | 'light' | 'dark'
export type FontPref = 'default' | 'serif' | 'mono'

export interface Prefs {
  theme: ThemePref
  font: FontPref
  smallText: boolean
  fullWidth: boolean
  sidebarOpen: boolean
  sidebarWidth: number
  spellcheck: boolean
  /** list non-markdown text files in the sidebar */
  showAllFiles: boolean
}

export interface AppState {
  root: string | null
  recentRoots: string[]
  recentFiles: string[]
  lastFile: string | null
  expanded: string[]
  favorites: string[]
  /** open tabs (file paths) and which one is active */
  tabs: string[]
  activeTab: number
  /** mtime of each file when it was last seen in Motion (for the "changed" dot) */
  seen: Record<string, number>
  /** files changed before this weren't tracked, so they never get a dot */
  seenSince: number
  prefs: Prefs
}

export interface FsChange {
  root: string
  changed: string[]
  added: string[]
  removed: string[]
  snapshot: IndexSnapshot
}

export interface SearchHit {
  path: string
  rel: string
  title: string
  snippet: string | null
  line: number | null
  score: number
}

export interface WriteOptions {
  /** the content the caller believes is on disk; the write is refused if it differs */
  expected?: string
  /** allow creating the file (and its folder) if it doesn't exist */
  create?: boolean
  /** write even if the disk content differs */
  force?: boolean
}

export type WriteResult =
  | { ok: true; mtime: number }
  | { ok: false; reason: 'conflict'; disk: string }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'error'; message: string }

export interface ReadResult {
  content: string
  mtime: number
}

export type MenuCommand =
  | 'new-page'
  | 'open-folder'
  | 'open-file'
  | 'search'
  | 'toggle-sidebar'
  | 'toggle-source'
  | 'toggle-full-width'
  | 'toggle-small-text'
  | 'font-default'
  | 'font-serif'
  | 'font-mono'
  | 'theme-system'
  | 'theme-light'
  | 'theme-dark'
  | 'back'
  | 'forward'
  | 'reveal'
  | 'copy-path'
  | 'reload-file'
  | 'find'
  | 'new-tab'
  | 'close-tab'
  | 'reopen-tab'
  | 'next-tab'
  | 'prev-tab'
  | `tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

export interface MotionApi {
  getState(): Promise<AppState>
  setState(patch: Partial<AppState>): Promise<AppState>
  openFolderDialog(): Promise<string | null>
  openFileDialog(): Promise<string | null>
  setRoot(root: string | null): Promise<IndexSnapshot | null>
  getIndex(): Promise<IndexSnapshot | null>
  read(path: string): Promise<ReadResult>
  write(path: string, content: string, opts?: WriteOptions): Promise<WriteResult>
  writeSync(path: string, content: string, opts?: WriteOptions): WriteResult
  createPage(dir: string, name?: string, content?: string): Promise<string>
  createFolder(dir: string): Promise<string>
  rename(from: string, to: string): Promise<string>
  duplicate(path: string): Promise<string>
  trash(path: string): Promise<boolean>
  confirmTrash(path: string): Promise<boolean>
  saveAsset(docPath: string, data: ArrayBuffer, ext: string): Promise<string>
  exists(path: string): Promise<boolean>
  search(query: string): Promise<SearchHit[]>
  reveal(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<void>
  copyText(text: string): Promise<void>
  showContextMenu(items: { id: string; label: string; enabled?: boolean; type?: 'separator' }[]): Promise<string | null>
  onFsChange(cb: (change: FsChange) => void): () => void
  onMenu(cb: (cmd: MenuCommand) => void): () => void
  onOpenPath(cb: (path: string) => void): () => void
  onFullscreen(cb: (on: boolean) => void): () => void
  closeWindow(): void
  platform: string
}
