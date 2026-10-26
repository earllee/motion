import { app, dialog, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Updates come from the GitHub releases (latest-mac.yml next to the zips). A new
 * version downloads in the background and installs when Motion quits; windows are
 * told so they can offer "Restart to update" sooner.
 */
const CHECK_EVERY = 4 * 60 * 60 * 1000

let ready: string | null = null
/** a check started from the menu reports its result in a dialog */
let manual = false

const enabled = () => app.isPackaged && !process.env.MOTION_USER_DATA

export function updateReady(): string | null {
  return ready
}

export function initUpdater(notify: (version: string) => void) {
  if (!enabled()) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    ready = info.version
    notify(info.version)
    if (manual) void restartPrompt(info.version)
    manual = false
  })
  autoUpdater.on('update-not-available', () => {
    if (manual) void dialog.showMessageBox({ message: 'Motion is up to date.', detail: `Version ${app.getVersion()}` })
    manual = false
  })
  autoUpdater.on('error', (err) => {
    if (manual) void dialog.showMessageBox({ type: 'warning', message: 'Couldn’t check for updates', detail: String(err?.message || err) })
    manual = false
  })
  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, 10_000)
  setInterval(check, CHECK_EVERY).unref()
}

async function restartPrompt(version: string) {
  const win = BrowserWindow.getFocusedWindow()
  const opts = {
    message: `Motion ${version} is ready`,
    detail: 'Restart now to update, or it will install the next time you quit.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1
  }
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (r.response === 0) installUpdate()
}

/** Menu: Check for Updates… */
export function checkForUpdates() {
  if (!enabled()) {
    void dialog.showMessageBox({ message: 'Updates are only available in the released app.' })
    return
  }
  if (ready) return void restartPrompt(ready)
  manual = true
  void autoUpdater.checkForUpdates().catch(() => {})
}

export function installUpdate() {
  if (ready) autoUpdater.quitAndInstall()
}
