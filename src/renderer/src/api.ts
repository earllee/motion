/// <reference types="vite/client" />
import type { MotionApi } from '@shared/types'

declare global {
  interface Window {
    motion: MotionApi
  }
}

export const api: MotionApi = window.motion

/** Path helpers (renderer has no `path` module). Paths are POSIX on macOS. */
export const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'
export const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1)
export const stemOf = (p: string) => baseOf(p).replace(/\.(md|markdown)$/i, '')
export const joinPath = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')

export function resolvePath(fromDir: string, rel: string): string {
  if (rel.startsWith('/')) return normalize(rel)
  return normalize(fromDir + '/' + rel)
}

export function normalize(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

export function relativePath(fromDir: string, to: string): string {
  const a = normalize(fromDir).split('/').filter(Boolean)
  const b = normalize(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const up = a.slice(i).map(() => '..')
  const rel = [...up, ...b.slice(i)].join('/')
  return rel || '.'
}

/** URL the renderer can load for a local file (images). */
export function assetUrl(absPath: string): string {
  return 'motion-asset://local' + absPath.split('/').map(encodeURIComponent).join('/')
}
