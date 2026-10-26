import { api } from '@/api'

/**
 * Outside edits made while a page is open show as suggestions. For each file open in
 * a tab we keep its text from when it was opened (or last accepted), and diff against
 * it. Nothing is persisted: closing the file drops this, which accepts the suggestions.
 */
export const openBases = new Map<string, string>()

/** how many suggestions each open file has, as counted when its page last showed them (absent: unknown) */
export const pendingSuggestions = new Map<string, number>()

/** Might closing this file drop suggestions? */
export const mayHaveSuggestions = (p: string) => openBases.has(p) && pendingSuggestions.get(p) !== 0

/** Remember a file's text when a tab first opens it. */
export function ensureBase(path: string, content?: string) {
  if (openBases.has(path)) return
  if (content !== undefined) {
    openBases.set(path, content)
    return
  }
  void api
    .read(path)
    .then((r) => {
      if (!openBases.has(path)) openBases.set(path, r.content)
    })
    .catch(() => {})
}

/** Keep only the files still open in a tab. */
export function keepBases(open: Set<string>) {
  for (const p of [...openBases.keys()]) {
    if (open.has(p)) continue
    openBases.delete(p)
    pendingSuggestions.delete(p)
  }
}

export function moveBase(remap: (p: string) => string) {
  for (const [p, base] of [...openBases]) {
    const to = remap(p)
    if (to === p) continue
    openBases.delete(p)
    openBases.set(to, base)
    const n = pendingSuggestions.get(p)
    pendingSuggestions.delete(p)
    if (n) pendingSuggestions.set(to, n)
  }
}

/**
 * Before files stop being open (a tab closes or shows another page): if any have
 * suggestions, ask, since closing accepts them.
 */
export async function confirmClose(paths: (string | null | undefined)[], stillOpen: (p: string) => boolean): Promise<boolean> {
  const closing = paths.filter((p): p is string => !!p && !stillOpen(p) && openBases.has(p))
  let n = closing.reduce((t, p) => t + (pendingSuggestions.get(p) ?? 0), 0)
  // a background tab hasn't counted its suggestions: any outside change since it opened is one
  const unknown = closing.filter((p) => !pendingSuggestions.has(p))
  if (!n && unknown.length) {
    const squash = (t: string) => t.replace(/\s+/g, ' ').trim()
    const reads = await Promise.all(unknown.map((p) => api.read(p).then((r) => r.content, () => null)))
    if (reads.some((text, k) => text !== null && squash(text) !== squash(openBases.get(unknown[k])!))) n = -1
  }
  if (!n) return true
  return api.confirm(
    n === 1 ? 'Accept the suggestion?' : n > 1 ? `Accept all ${n} suggestions?` : 'Accept the suggestions?',
    'Closing the page accepts the outside edits shown as suggestions. They stay in the file either way.',
    'Accept and Close'
  )
}
