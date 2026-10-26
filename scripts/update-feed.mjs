// Refresh latest-mac.yml after release.sh re-signs and staples the DMGs, so the
// checksums listed for them match the files that get uploaded.
import { createHash } from 'crypto'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

const dir = process.argv[2] || 'release'
const feed = join(dir, 'latest-mac.yml')
const lines = readFileSync(feed, 'utf8').split('\n')
for (let i = 0; i < lines.length; i++) {
  const m = /^\s*- url: (.+\.dmg)$/.exec(lines[i])
  if (!m) continue
  const file = join(dir, m[1])
  lines[i + 1] = lines[i + 1].replace(/sha512: .*/, 'sha512: ' + createHash('sha512').update(readFileSync(file)).digest('base64'))
  lines[i + 2] = lines[i + 2].replace(/size: .*/, 'size: ' + statSync(file).size)
}
writeFileSync(feed, lines.join('\n'))
console.log(`updated ${feed}`)
