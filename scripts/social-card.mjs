// Render the 1280×640 GitHub social preview from the demo screenshot. Dev-only.
// usage: node scripts/demo.mjs && node scripts/social-card.mjs [mediaDir=docs/media]
// Rendered with the project's Electron, so no separate browser download is needed.
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const DIR = process.argv[2] || 'docs/media'
const b64 = (p) => readFileSync(p).toString('base64')
const shot = `data:image/png;base64,${b64(join(DIR, 'screenshot.png'))}`
const icon = `data:image/png;base64,${b64('build/icon.png')}`

const html = `<!doctype html><html><head><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1280px; height: 640px; overflow: hidden; background: #f7f6f3;
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif; color: #191919; }
  .copy { position: absolute; left: 72px; top: 0; bottom: 0; width: 470px;
    display: flex; flex-direction: column; justify-content: center; }
  .brand { display: flex; align-items: center; gap: 18px; margin-bottom: 28px; }
  .brand img { width: 72px; height: 72px; }
  .brand h1 { font-size: 64px; font-weight: 700; letter-spacing: -2px; }
  p.tag { font-size: 30px; line-height: 1.3; font-weight: 500; letter-spacing: -0.4px; margin-bottom: 30px; }
  ul { list-style: none; padding: 0; display: grid; gap: 12px; }
  li { font-size: 21px; color: #55534e; display: flex; gap: 12px; align-items: center; }
  li::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #2383e2; flex: none; }
  .shot { position: absolute; left: 590px; top: 84px; width: 980px; border-radius: 14px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(15, 15, 15, .16), 0 0 0 1px rgba(15, 15, 15, .08); }
  .shot img { display: block; width: 100%; }
</style></head><body>
  <div class="copy">
    <div class="brand"><img src="${icon}"><h1>Motion</h1></div>
    <p class="tag">Notion-style editing for the Markdown files in your repo.</p>
    <ul>
      <li>Plain .md files stay the source of truth</li>
      <li>Untouched text is never rewritten</li>
      <li>Agent edits show up live</li>
    </ul>
  </div>
  <div class="shot"><img src="${shot}"></div>
</body></html>`

const tmp = mkdtempSync(join(tmpdir(), 'motion-card-'))
writeFileSync(join(tmp, 'card.html'), html)
writeFileSync(join(tmp, 'main.cjs'), `
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 640, useContentSize: true, show: false, frame: false })
  await win.loadFile(${JSON.stringify(join(tmp, 'card.html'))})
  const img = await win.webContents.capturePage()
  fs.writeFileSync(${JSON.stringify(resolve(DIR, 'social-preview.png'))}, img.resize({ width: 1280, height: 640, quality: 'best' }).toPNG())
  app.quit()
})`)
execFileSync(createRequire(import.meta.url)('electron'), [join(tmp, 'main.cjs')])
console.log(`wrote ${DIR}/social-preview.png`)
