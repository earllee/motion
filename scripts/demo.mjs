// Record the README demo video and a still for the social preview. Dev-only.
// usage: npm run build && node scripts/demo.mjs [outDir=docs/media]   (needs ffmpeg)
// Frames come from a DevTools screencast; Playwright's recordVideo hangs the Electron launch.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const OUT = process.argv[2] || 'docs/media'
const W = 1280
const H = 800

// a small, believable repo for the demo
const root = join(mkdtempSync(join(tmpdir(), 'motion-demo-')), 'acme-api')
const files = {
  'CLAUDE.md': '# CLAUDE.md\n\nRun `npm test` before every commit. Plans live in `plans/`.\n',
  'README.md': '# acme-api\n\nThe public API for Acme.\n',
  'plans/rate-limiting.md': `---
status: in-progress
owner: alex
---

# Add rate limiting

Per-key limits on the public API, so one noisy client can't slow everyone down.

## Steps

- [x] Pick an algorithm (token bucket)
- [ ] Add Redis-backed limiter middleware
- [ ] Return \`429\` with a \`Retry-After\` header
- [ ] Load test at 2x peak

## Limits

| Plan | Requests / min | Burst |
| --- | ---: | ---: |
| Free | 60 | 10 |
| Pro | 600 | 100 |
`,
  'plans/search-v2.md': '# Search v2\n\nMove search to Postgres full-text.\n',
  'specs/auth.md': '# Auth spec\n\nAPI keys, scoped per project.\n',
  'notes/2026-10-22.md': '# Standup\n\n- Rate limiting plan drafted.\n'
}
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}
execFileSync('git', ['init', '-q', root]) // so Motion roots the workspace at acme-api/
const plan = join(root, 'plans/rate-limiting.md')

mkdirSync(OUT, { recursive: true })
const frameDir = mkdtempSync(join(tmpdir(), 'motion-frames-'))
const app = await electron.launch({
  args: ['out/main/index.js', plan],
  env: { ...process.env, MOTION_USER_DATA: mkdtempSync(join(tmpdir(), 'motion-ud-')) },
  colorScheme: 'light'
})
const win = await app.firstWindow()
await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [W, H])
await win.waitForSelector('.ProseMirror')
await win.waitForTimeout(500)

const frames = []
const cdp = await win.context().newCDPSession(win)
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = join(frameDir, `${String(frames.length).padStart(5, '0')}.jpg`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  frames.push({ file, t: metadata.timestamp })
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 })
const wait = (ms) => win.waitForTimeout(ms)
const type = (text) => win.keyboard.type(text, { delay: 55 })
// menu accelerators don't see synthetic keys, so send the command the menu would
const menu = (cmd) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu', c), cmd)
await wait(1800)

// hover a block to show the handles
await win.locator('.ProseMirror h2', { hasText: 'Steps' }).hover()
await wait(1000)

// slash menu → callout, typed under the intro paragraph
// clicking past the end of the line puts the caret at its end
const intro = win.locator('.ProseMirror p', { hasText: 'noisy client' })
const box = await intro.boundingBox()
await intro.click({ position: { x: box.width - 4, y: box.height / 2 } })
await wait(300)
await win.keyboard.press('Enter')
await type('/call')
await wait(900)
await win.keyboard.press('Enter')
await type('Ship behind a feature flag first.')
await wait(1800) // let autosave land before the "agent" edits the file

// an agent edits the file on disk; the open page updates live
const disk = readFileSync(plan, 'utf8')
writeFileSync(
  plan,
  disk
    .replace('- [ ] Add Redis-backed limiter middleware', '- [x] Add Redis-backed limiter middleware')
    .replace('- [ ] Return `429`', '- [x] Return `429`')
)
await wait(2600)

// ⌘/ shows the plain markdown underneath
await menu('toggle-source')
await wait(3000)
await menu('toggle-source')
await wait(1200)

await cdp.send('Page.stopScreencast')
await win.screenshot({ path: join(OUT, 'screenshot.png') })
await app.close()

// frames arrive only when the page repaints, so hold each one until the next
const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 1) - f.t).toFixed(3)}`)
writeFileSync(join(frameDir, 'list.txt'), list.join('\n') + `\nfile '${frames.at(-1).file}'\n`)
const ff = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args])
ff('-f', 'concat', '-safe', '0', '-i', join(frameDir, 'list.txt'), '-vf', `fps=30,scale=${W}:-2:flags=lanczos`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', join(OUT, 'demo.mp4'))
ff('-i', join(OUT, 'demo.mp4'), '-vf', 'fps=12,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
  join(OUT, 'demo.gif'))
console.log(`wrote demo.mp4, demo.gif and screenshot.png to ${OUT} (${frames.length} frames)`)
