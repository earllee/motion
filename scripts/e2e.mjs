// End-to-end checks against the built app (run `npm run build` first).
// Creates a throwaway workspace, drives the real UI with Playwright, and asserts on the files on disk.
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'motion-e2e-'))
copyFileSync('tests/fixtures/kitchen-sink.md', join(dir, 'kitchen-sink.md'))
writeFileSync(join(dir, 'scratch.md'), '# Scratch\n\nalpha\n\nbravo\n\ncharlie\n')
writeFileSync(join(dir, 'mentions.md'), '# Mentions\n\nstart\n')
writeFileSync(join(dir, 'conflict.md'), '# Conflict\n\nmine\n')
writeFileSync(join(dir, 'doomed.md'), '# Doomed\n\ntext\n')
writeFileSync(join(dir, 'lists.md'), '# Lists\n\n- one\n- two\n- three\n\n## Tasks\n\n- [ ] task a\n- [ ] task b\n')
writeFileSync(join(dir, 'pillars.md'), '# Pillars\n\nFour pillars:\n\n- **01 Plain** files\n- **02 Clean** diffs\n- **03 Live** reload\n- **04 Offline** first\n\nAfter\n')
mkdirSync(join(dir, 'sql'))
writeFileSync(join(dir, 'sql', 'q.sql'), 'SELECT 1\n')
writeFileSync(join(dir, 'notes.txt'), 'plain notes\n')
writeFileSync(join(dir, 'long.md'), '# Long\n\n' + Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n\n') + '\n')
writeFileSync(join(dir, 'toggles.md'), '# Toggles\n\n<details>\n<summary>Hidden</summary>\n\n</details>\n')
writeFileSync(join(dir, 'blocks.md'), '# Blocks\n\none\n\ntwo\n\nthree\n\nfour\n')

const read = (f) => readFileSync(join(dir, f), 'utf8')
let failures = 0
const check = (label, ok, got) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : '\n     got: ' + JSON.stringify(got)}`)
}
const pause = (win, ms = 120) => win.waitForTimeout(ms)

const app = await electron.launch({
  args: ['out/main/index.js', join(dir, 'kitchen-sink.md')],
  env: { ...process.env, MOTION_USER_DATA: mkdtempSync(join(tmpdir(), 'motion-ud-')) }
})
// never leave a stray window behind if a step hangs
const watchdog = setTimeout(() => {
  console.log('TIMEOUT: killing the test app')
  app.process().kill('SIGKILL')
  process.exit(2)
}, 300000)
watchdog.unref()
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
await win.waitForSelector('.ProseMirror')
await pause(win, 800)
const menu = (cmd) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu', c), cmd)
const open = async (name) => {
  await win.locator('.tree .tree-row', { hasText: name }).first().click()
  await pause(win, 700)
}

// --- kitchen sink: block operations
await win.locator('.ProseMirror li p', { hasText: 'First bullet' }).click()
await pause(win)
await win.keyboard.press('Escape')
await win.keyboard.press('ArrowDown')
await win.keyboard.press('Backspace')
await pause(win, 800)
check('Esc/↓/Backspace deletes a list item with its children', !read('kitchen-sink.md').includes('Second bullet') && !read('kitchen-sink.md').includes('Deeper'), read('kitchen-sink.md'))

await win.locator('.callout-icon').first().dispatchEvent('mousedown')
await pause(win, 200)
await win.locator('.menu-item', { hasText: 'Tip' }).click()
await pause(win, 800)
check('callout type changes to [!TIP]', read('kitchen-sink.md').includes('> [!TIP]\n> This is a callout'), read('kitchen-sink.md'))

const quote = win.locator('.ProseMirror blockquote p').first()
const qb = await quote.boundingBox()
await win.mouse.move(qb.x + 30, qb.y + qb.height / 2)
await pause(win, 250)
await win.locator('.block-handle .drag').click()
await pause(win, 250)
await win.locator('.menu-item', { hasText: 'Turn into' }).hover()
await pause(win, 250)
await win.locator('.menu-item', { hasText: 'Heading 2' }).click()
await pause(win, 800)
check('block menu: quote → Heading 2', read('kitchen-sink.md').includes('## A quote from a customer'), read('kitchen-sink.md'))

const cell = win.locator('.ProseMirror td p', { hasText: '$800K' })
await cell.click()
await pause(win)
await win.keyboard.press('Meta+ArrowRight')
await win.keyboard.type(' | ok')
await pause(win, 800)
check('table cells escape pipes', read('kitchen-sink.md').includes('$800K \\| ok |'), read('kitchen-sink.md'))

writeFileSync(join(dir, 'kitchen-sink.md'), read('kitchen-sink.md').replace('# Kitchen sink', '# Kitchen sink (edited by Claude)'))
await pause(win, 1500)
check('external edits reload into the editor', (await win.locator('.ProseMirror h1').first().textContent()).includes('edited by Claude'))

await menu('toggle-source')
await pause(win, 400)
check('⌘/ shows raw markdown', (await win.locator('.cm-content').textContent()).includes('# Kitchen sink (edited by Claude)'))
await menu('toggle-source')
await pause(win, 400)

// --- scratch: drag & drop, markdown shortcuts, paste, undo
await open('scratch')
const charlie = win.locator('.ProseMirror > p', { hasText: 'charlie' })
const cb = await charlie.boundingBox()
await win.mouse.move(cb.x + 20, cb.y + cb.height / 2)
await pause(win, 250)
const hb = await win.locator('.block-handle .drag').boundingBox()
const ab = await win.locator('.ProseMirror > p', { hasText: 'alpha' }).boundingBox()
await win.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
await win.mouse.down()
await win.mouse.move(hb.x + 30, hb.y - 10, { steps: 5 })
await win.mouse.move(ab.x + 40, ab.y + 3, { steps: 10 })
await pause(win, 150)
await win.mouse.up()
await pause(win, 900)
check('drag handle moves a block above another', read('scratch.md') === '# Scratch\n\ncharlie\n\nalpha\n\nbravo\n', read('scratch.md'))

await win.locator('.ProseMirror > p', { hasText: 'bravo' }).click()
await pause(win)
await win.keyboard.press('Meta+ArrowRight')
const type = (s) => win.keyboard.type(s, { delay: 5 })
await win.keyboard.press('Enter'); await type('## Sub heading')
await win.keyboard.press('Enter'); await type('- bullet **bold** and `code`')
await win.keyboard.press('Enter'); await win.keyboard.press('Enter')
await type('1. first')
await win.keyboard.press('Enter'); await type('second')
await win.keyboard.press('Enter'); await win.keyboard.press('Enter')
await type('> quoted')
await win.keyboard.press('Enter'); await win.keyboard.press('Enter')
await type('[] a todo')
await win.keyboard.press('Enter'); await win.keyboard.press('Enter')
await type('---')
await type('```')
await type('const x = 1')
await pause(win, 1000)
check(
  'markdown shortcuts write clean markdown',
  read('scratch.md') ===
    '# Scratch\n\ncharlie\n\nalpha\n\nbravo\n\n## Sub heading\n\n- bullet **bold** and `code`\n\n1. first\n2. second\n\n> quoted\n\n- [ ] a todo\n\n---\n\n```\nconst x = 1\n```\n',
  read('scratch.md')
)

await app.evaluate(({ clipboard }) => clipboard.writeText('## Pasted\n\n- one\n- two'))
await win.locator('.ProseMirror > p', { hasText: 'alpha' }).click()
await pause(win)
await win.keyboard.press('Meta+ArrowRight')
await win.keyboard.press('Enter')
await win.keyboard.press('Meta+v')
await pause(win, 900)
check('pasted markdown becomes blocks', read('scratch.md').includes('alpha\n\n## Pasted\n\n- one\n- two\n\nbravo'), read('scratch.md'))
await win.keyboard.press('Meta+z')
await pause(win, 900)
check('undo reverts the paste', !read('scratch.md').includes('Pasted'), read('scratch.md'))

// --- mentions
await open('mentions')
await win.locator('.ProseMirror > p', { hasText: 'start' }).click()
await pause(win)
await win.keyboard.press('Meta+ArrowRight')
await type(' see @kitch')
await pause(win, 300)
await win.keyboard.press('Enter')
await type('and [[scra')
await pause(win, 300)
await win.keyboard.press('Enter')
await type('and [Google](https://google.com) done')
await pause(win, 1000)
check(
  '@ mention, [[ wikilink, and typed [text](url)',
  read('mentions.md') === '# Mentions\n\nstart see [Kitchen sink (edited by Claude)](kitchen-sink.md) and [[scratch]] and [Google](https://google.com) done\n',
  read('mentions.md')
)

// --- new page gets a slug filename from its title
await menu('new-page')
await pause(win, 800)
await type('My Plan For Q4')
await win.keyboard.press('Enter')
await type('- step one')
await pause(win, 1500)
check('new page auto-renames to my-plan-for-q4.md', existsSync(join(dir, 'my-plan-for-q4.md')) && read('my-plan-for-q4.md') === '# My Plan For Q4\n\n- step one\n', existsSync(join(dir, 'my-plan-for-q4.md')) ? read('my-plan-for-q4.md') : 'missing')

// --- conflict: Claude writes while you're typing → nothing is overwritten
await open('conflict')
await win.locator('.ProseMirror > p', { hasText: 'mine' }).click()
await pause(win)
await win.keyboard.press('Meta+ArrowRight')
await win.keyboard.type(' plus my edit')
writeFileSync(join(dir, 'conflict.md'), '# Conflict\n\nclaude rewrote this\n')
await pause(win, 1500)
check('concurrent external write is not overwritten', read('conflict.md') === '# Conflict\n\nclaude rewrote this\n', read('conflict.md'))
check('conflict banner appears', (await win.locator('.page-banner', { hasText: 'changed on disk' }).count()) === 1)
await win.keyboard.type('!')
await pause(win, 800)
check('autosave stays paused during a conflict', read('conflict.md') === '# Conflict\n\nclaude rewrote this\n', read('conflict.md'))
await win.locator('.page-banner button', { hasText: 'Keep mine' }).click()
await pause(win, 800)
check('"Keep mine" writes your version', read('conflict.md') === '# Conflict\n\nmine plus my edit!\n', read('conflict.md'))

// --- deleted while open → not resurrected by autosave
await open('doomed')
await win.locator('.ProseMirror > p', { hasText: 'text' }).click()
await pause(win)
const { unlinkSync } = await import('fs')
unlinkSync(join(dir, 'doomed.md'))
await win.keyboard.press('Meta+ArrowRight')
await win.keyboard.type(' more')
await pause(win, 1500)
check('deleted file is not recreated by autosave', !existsSync(join(dir, 'doomed.md')))
check('deleted banner appears', (await win.locator('.page-banner', { hasText: 'deleted or moved' }).count()) === 1)

// --- multi-block selection
await open('blocks')
await win.locator('.ProseMirror > p', { hasText: 'one' }).click()
await pause(win)
await win.keyboard.press('Shift+ArrowDown')
await win.keyboard.press('Escape')
await pause(win, 150)
check('Esc on a selection across blocks selects all of them', (await win.locator('.ProseMirror .block-selected').count()) === 2)
await win.keyboard.press('Shift+ArrowDown')
await pause(win, 150)
check('⇧↓ extends the block selection', (await win.locator('.ProseMirror .block-selected').count()) === 3)
await win.keyboard.press('Meta+c')
await pause(win, 150)
const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
check('⌘C copies the blocks as markdown', copied === 'one\n\ntwo\n\nthree', copied)
await win.keyboard.press('Meta+Shift+ArrowDown')
await pause(win, 800)
check('⌘⇧↓ moves the whole run', read('blocks.md') === '# Blocks\n\nfour\n\none\n\ntwo\n\nthree\n', read('blocks.md'))
await win.keyboard.type('x')
await pause(win, 500)
check('typing does not replace selected blocks', read('blocks.md') === '# Blocks\n\nfour\n\none\n\ntwo\n\nthree\n', read('blocks.md'))
await win.keyboard.press('Backspace')
await pause(win, 800)
check('Backspace deletes the selected blocks', read('blocks.md') === '# Blocks\n\nfour\n', read('blocks.md'))

// --- spreadsheet paste: cells + HTML + a picture of the cells, like Numbers/Excel
await win.locator('.ProseMirror > p', { hasText: 'four' }).click()
await win.keyboard.press('End')
await win.keyboard.press('Enter')
await app.evaluate(({ clipboard, ClipboardItem }) =>
  clipboard.write([
    new ClipboardItem({
      'text/plain': 'ID_TYPE\tCount\nAAID\t80,430,461\n',
      'text/html': '<table><tr><td>ID_TYPE</td><td>Count</td></tr><tr><td>AAID</td><td>80,430,461</td></tr></table>',
      'image/png': new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' })
    })
  ])
)
await win.keyboard.press('Meta+v')
await pause(win, 800)
check('spreadsheet paste becomes a table, not an image', read('blocks.md').includes('| ID_TYPE | Count |\n| --- | --- |\n| AAID | 80,430,461 |') && !read('blocks.md').includes('!['), read('blocks.md'))

// --- Tab / Shift-Tab nest list items
await open('lists')
await win.locator('.ProseMirror li p', { hasText: 'two' }).click()
await win.keyboard.press('Tab')
await pause(win, 800)
check('Tab nests a bullet under the one above', read('lists.md').includes('- one\n  - two\n- three'), read('lists.md'))
await win.locator('.ProseMirror li p', { hasText: 'three' }).click()
await win.keyboard.press('Tab')
await win.keyboard.press('Tab')
await pause(win, 800)
check('Tab again makes a third level', read('lists.md').includes('- one\n  - two\n    - three'), read('lists.md'))
await win.keyboard.press('Shift+Tab')
await win.keyboard.press('Shift+Tab')
await win.keyboard.press('Shift+Tab')
await pause(win, 800)
check('Shift-Tab lifts it back out, and stops at the top level', read('lists.md').includes('- one\n  - two\n- three\n'), read('lists.md'))
await win.locator('.ProseMirror li p', { hasText: 'task b' }).click()
await win.keyboard.press('Tab')
await pause(win, 800)
check('Tab nests a to-do', read('lists.md').includes('- [ ] task a\n  - [ ] task b'), read('lists.md'))

// --- shift-click selects blocks; ⌘⌥6 / ⌘⌥5 turn every selected item, not just the first
await open('pillars')
const item = (t) => win.locator('.ProseMirror li p', { hasText: t })
const dragSelect = async (fromText, toText) => {
  const f = await item(fromText).boundingBox()
  const t = await item(toText).boundingBox()
  await win.mouse.move(f.x + 60, f.y + f.height / 2)
  await win.mouse.down()
  await win.mouse.move(t.x + 40, t.y + t.height / 2, { steps: 8 })
  await win.mouse.up()
}
await item('Plain').click()
await item('Offline').click({ modifiers: ['Shift'] })
await pause(win, 150)
check('shift-click selects every block in the range', (await win.locator('.ProseMirror .block-selected').count()) === 4)
await win.keyboard.press('Meta+Alt+6')
await pause(win, 800)
const numbered = 'Four pillars:\n\n1. **01 Plain** files\n2. **02 Clean** diffs\n3. **03 Live** reload\n4. **04 Offline** first\n\nAfter'
const bullets = 'Four pillars:\n\n- **01 Plain** files\n- **02 Clean** diffs\n- **03 Live** reload\n- **04 Offline** first\n\nAfter'
check('⌘⌥6 on the selected blocks numbers every item', read('pillars.md').includes(numbered), read('pillars.md'))
await win.keyboard.press('Meta+Alt+5')
await pause(win, 800)
check('the selection survives, so ⌘⌥5 turns them all back into bullets', read('pillars.md').includes(bullets), read('pillars.md'))
// text selected by dragging: ⌘⌥6 converts every item it touches
await dragSelect('Plain', 'Offline')
await win.keyboard.press('Meta+Alt+6')
await pause(win, 800)
check('⌘⌥6 on a dragged text selection numbers every item', read('pillars.md').includes(numbered), read('pillars.md'))
// the reported sequence: first item numbered, rest bullets, text selection → Esc → ⌘⌥6
await item('Plain').click()
await win.keyboard.press('Meta+Alt+6')
await item('Clean').click()
await item('Offline').click({ modifiers: ['Shift'] })
await win.keyboard.press('Meta+Alt+5')
await pause(win, 300)
await dragSelect('Plain', 'Offline')
await win.keyboard.press('Escape')
await pause(win, 150)
check('Esc on a text selection selects the blocks', (await win.locator('.ProseMirror .block-selected').count()) >= 1)
await win.keyboard.press('Meta+Alt+6')
await pause(win, 800)
check('mixed numbered + bulleted selection → one numbered list, text intact', read('pillars.md').includes(numbered), read('pillars.md'))
// ⌘⇧↓ moves what's selected
await item('Plain').click()
await item('Clean').click({ modifiers: ['Shift'] })
await win.keyboard.press('Meta+Shift+ArrowDown')
await pause(win, 800)
check('⌘⇧↓ moves shift-click-selected blocks', read('pillars.md').includes('1. **03 Live** reload\n2. **01 Plain** files\n3. **02 Clean** diffs\n4. **04 Offline**'), read('pillars.md'))
await dragSelect('Plain', 'Clean')
await win.keyboard.press('Meta+Shift+ArrowUp')
await pause(win, 800)
check('⌘⇧↑ moves the blocks a text selection touches', read('pillars.md').includes(numbered), read('pillars.md'))

// --- dragging a block to the bottom edge scrolls the page
await open('long')
const scroller = win.locator('.scroller')
// the renderer can't answer evaluate() mid-drag, so record the furthest scroll as it happens
await scroller.evaluate((el) => {
  window.__maxScroll = 0
  el.addEventListener('scroll', () => (window.__maxScroll = Math.max(window.__maxScroll, el.scrollTop)))
})
const lb = await win.locator('.ProseMirror > p', { hasText: 'line 1' }).first().boundingBox()
await win.mouse.move(lb.x + 20, lb.y + lb.height / 2)
await pause(win, 250)
const h = await win.locator('.block-handle .drag').boundingBox()
const sb = await scroller.boundingBox()
await win.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
await win.mouse.down()
// small first moves: a big jump as the drag starts wedges Playwright's synthetic drag
await win.mouse.move(h.x + h.width / 2 + 2, h.y + h.height / 2 + 2)
await win.mouse.move(h.x + h.width / 2 + 4, h.y + h.height / 2 + 4)
for (let i = 1; i <= 10; i++) await win.mouse.move(h.x + 9 + i * 10, h.y + (sb.y + sb.height - 30 - h.y) * (i / 10))
for (let i = 0; i < 20; i++) {
  await win.mouse.move(h.x + 120 + (i % 2), sb.y + sb.height - 30)
  await pause(win, 40)
}
await win.mouse.up()
await pause(win, 300)
const scrolled = await win.evaluate(() => window.__maxScroll)
check('dragging near the bottom edge scrolls the page', scrolled > 100, scrolled)

// --- clicking an empty toggle's prompt starts its first child
await open('toggles')
await win.locator('.ProseMirror .toggle-button').first().click()
await pause(win, 200)
const prompt = await win.locator('.ProseMirror .toggle-content').first().boundingBox()
await win.mouse.click(prompt.x + 40, prompt.y + prompt.height - 8)
await win.keyboard.type('inside')
await pause(win, 800)
check('clicking "Empty toggle" types inside it', /<summary>Hidden<\/summary>\n\s*\ninside\n\s*\n?<\/details>/.test(read('toggles.md')), read('toggles.md'))

// --- non-markdown files, Recently edited, the "changed outside" dot
const recentRows = () => win.locator('.sidebar-section', { hasText: 'Recently edited' }).locator('.tree-row')
check('a folder holding only .sql shows in the tree', (await win.locator('.tree .tree-row', { hasText: /^sql$/ }).count()) === 1)
await win.locator('.tree .tree-row', { hasText: 'notes.txt' }).click()
await pause(win, 600)
check('a .txt file opens in the code view', (await win.locator('.code-title', { hasText: 'notes.txt' }).count()) === 1)
await win.locator('.source-editor .cm-content').click()
await win.keyboard.press('Meta+ArrowDown')
await win.keyboard.type('more')
await pause(win, 900)
check('code view autosaves as-is', read('notes.txt') === 'plain notes\nmore', read('notes.txt'))
check('our own save tops Recently edited', ((await recentRows().first().textContent()) || '').includes('notes.txt'), await recentRows().allTextContents())
check('our own save gets no dot', (await recentRows().first().locator('.unseen-dot').count()) === 0)
writeFileSync(join(dir, 'scratch.md'), '# Scratch\n\nedited outside\n')
await pause(win, 900)
const scratchRow = recentRows().filter({ hasText: 'scratch' })
check('an outside edit tops Recently edited with a dot', ((await recentRows().first().textContent()) || '').includes('scratch') && (await scratchRow.locator('.unseen-dot').count()) === 1, await recentRows().allTextContents())
await scratchRow.click()
await pause(win, 600)
check('opening it clears the dot', (await recentRows().filter({ hasText: 'scratch' }).locator('.unseen-dot').count()) === 0)
await win.locator('.workspace-row').click()
await win.locator('.menu-item', { hasText: 'Show non-Markdown files' }).click()
await pause(win, 300)
check('the toggle hides non-markdown files', (await win.locator('.tree .tree-row', { hasText: 'notes.txt' }).count()) === 0)
await win.locator('.workspace-row').click()
await win.locator('.menu-item', { hasText: 'Show non-Markdown files' }).click()

check('no renderer errors', errors.length === 0, errors)
await app.close()
console.log(failures ? `\n${failures} failing` : '\nall e2e checks passed')
process.exit(failures ? 1 : 0)
