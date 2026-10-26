import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, MotionApi, FsChange, MenuCommand } from '@shared/types'

const on = <T>(channel: string, cb: (payload: T) => void) => {
  const handler = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: MotionApi = {
  getState: () => ipcRenderer.invoke('app:getState'),
  setState: (patch) => ipcRenderer.invoke('app:setState', patch),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  setRoot: (root) => ipcRenderer.invoke('ws:setRoot', root),
  getIndex: () => ipcRenderer.invoke('ws:index'),
  read: (p) => ipcRenderer.invoke('fs:read', p),
  write: (p, content, opts) => ipcRenderer.invoke('fs:write', p, content, opts),
  writeSync: (p, content, opts) => ipcRenderer.sendSync('fs:writeSync', p, content, opts),
  createPage: (dir, name, content) => ipcRenderer.invoke('fs:createPage', dir, name, content),
  createFolder: (dir) => ipcRenderer.invoke('fs:createFolder', dir),
  rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
  duplicate: (p) => ipcRenderer.invoke('fs:duplicate', p),
  trash: (p) => ipcRenderer.invoke('fs:trash', p),
  confirmTrash: (p) => ipcRenderer.invoke('fs:confirmTrash', p),
  saveAsset: (docPath, data, ext) => ipcRenderer.invoke('fs:saveAsset', docPath, data, ext),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  search: (q) => ipcRenderer.invoke('ws:search', q),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  showContextMenu: (items) => ipcRenderer.invoke('menu:context', items),
  confirm: (message, detail, ok) => ipcRenderer.invoke('dialog:confirm', message, detail, ok),
  onUpdateReady: (cb) => on<string>('app:update-ready', cb),
  installUpdate: () => ipcRenderer.send('app:install-update'),
  onFsChange: (cb) => on<FsChange>('fs:change', cb),
  onMenu: (cb) => on<MenuCommand>('menu', cb),
  onOpenPath: (cb) => on<string>('app:open-path', cb),
  onSharedState: (cb) => on<Partial<AppState>>('app:shared-state', cb),
  newWindow: () => ipcRenderer.send('window:new'),
  onFullscreen: (cb) => on<boolean>('window:fullscreen', cb),
  closeWindow: () => ipcRenderer.send('window:close'),
  platform: process.platform
}

contextBridge.exposeInMainWorld('motion', api)
