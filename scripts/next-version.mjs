// Print the version the next release should get: the last v* tag bumped by
// patch, minor or major. A package.json version ahead of the last tag (bumped by
// hand for a bigger release) is used as is.
// usage: node scripts/next-version.mjs <last tag or ""> [patch|minor|major]
import { readFileSync } from 'fs'

const parse = (v) => v.replace(/^v/, '').split('-')[0].split('.').map(Number)
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

const last = parse(process.argv[2] || '0.0.0')
const pkg = parse(JSON.parse(readFileSync('package.json', 'utf8')).version)
const bump = process.argv[3] || 'patch'

let [major, minor, patch] = last
if (cmp(pkg, last) > 0) [major, minor, patch] = pkg
else if (bump === 'major') [major, minor, patch] = [major + 1, 0, 0]
else if (bump === 'minor') [major, minor, patch] = [major, minor + 1, 0]
else patch++
console.log(`${major}.${minor}.${patch}`)
