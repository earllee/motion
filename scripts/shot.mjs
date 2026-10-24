// Launch the built app against a folder and screenshot it. Dev-only helper.
// usage: node scripts/shot.mjs <folder> <file-to-open-rel> <out.png> [--dark] [--actions=js-file]
import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const [folder, rel, out, ...rest] = process.argv.slice(2)
const dark = rest.includes('--dark')
const actionsArg = rest.find((a) => a.startsWith('--actions='))
const userData = process.env.MOTION_USER_DATA || mkdtempSync(join(tmpdir(), 'motion-ud-'))

const app = await electron.launch({
  args: ['out/main/index.js', rel ? join(folder, rel) : folder],
  env: { ...process.env, MOTION_USER_DATA: userData },
  colorScheme: dark ? 'dark' : 'light'
})
const win = await app.firstWindow()
const logs = []
win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
await win.waitForTimeout(1500)
if (actionsArg) {
  const mod = await import(resolve(actionsArg.slice('--actions='.length)))
  await mod.default(win, app)
}
await win.screenshot({ path: out })
console.log(logs.filter((l) => !l.includes('Electron Security Warning')).join('\n'))
await app.close()
