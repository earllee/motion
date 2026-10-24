// Smoke-test the packaged app: open a folder, edit a page, confirm it saved. Dev-only.
// usage: node scripts/smoke-packaged.mjs <dir containing fixture/ with scratch.md>
import { _electron as electron } from 'playwright'
import { readFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const SP = process.argv[2]
const app = await electron.launch({
  executablePath: 'release/mac-arm64/Motion.app/Contents/MacOS/Motion',
  args: [SP + '/fixture'],
  env: { ...process.env, MOTION_USER_DATA: mkdtempSync(join(tmpdir(), 'motion-pkg-')) }
})
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
await win.waitForSelector('.ProseMirror', { timeout: 20000 })
await win.locator('.tree-row', { hasText: 'scratch' }).last().click()
await win.waitForTimeout(800)
await win.locator('.ProseMirror > p').first().click()
await win.waitForTimeout(150)
await win.keyboard.press('Meta+ArrowRight')
await win.keyboard.type(' (packaged)')
await win.waitForTimeout(1000)
console.log('saved:', JSON.stringify(readFileSync(SP + '/fixture/scratch.md', 'utf8').split('\n')[2]))
console.log('errors:', errors)
await win.screenshot({ path: SP + '/pkg.png' })
await app.close()
