// Write the notes for a release: the merged PRs since the last release (GitHub's
// generated "What's Changed"), commits pushed straight to main, then the download
// and checksum sections the hand-written releases have.
// usage: node scripts/release-notes.mjs <version> <previous tag or ""> <sha> [release dir]
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const [version, prev, sha, dir = 'release'] = process.argv.slice(2)
const tag = `v${version}`
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()

const api = ['api', 'repos/{owner}/{repo}/releases/generate-notes', '-f', `tag_name=${tag}`, '-f', `target_commitish=${sha}`]
if (prev) api.push('-f', `previous_tag_name=${prev}`)
let notes = run('gh', [...api, '--jq', '.body'])

// commits without a "(#123)" squash-merge suffix never show up as PRs above
const range = prev ? `${prev}..${sha}` : sha
const direct = run('git', ['log', '--no-merges', '--format=%s', range])
  .split('\n')
  .filter((s) => s && !/\(#\d+\)$/.test(s))
if (direct.length) {
  const list = direct.map((s) => `* ${s}`).join('\n')
  // keep the "Full Changelog" link last
  const at = notes.lastIndexOf('**Full Changelog**')
  const block = `## Other changes\n${list}\n\n`
  notes = at >= 0 ? notes.slice(0, at) + block + notes.slice(at) : `${notes}\n\n${block}`
}

const all = readdirSync(dir).sort()
const files = [...all.filter((f) => f.endsWith('.dmg')), ...all.filter((f) => f.endsWith('.zip'))]
const sums = files.map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`)

console.log(`${notes.trim()}

## Download

- **Apple Silicon (M1 and later):** \`Motion-${version}-arm64.dmg\`
- **Intel:** \`Motion-${version}-x64.dmg\`

Open the DMG and drag Motion to Applications. Signed and notarized by Apple. Requires macOS 13 or later. Installed copies update themselves.

## Checksums (SHA-256)

\`\`\`
${sums.join('\n')}
\`\`\``)
