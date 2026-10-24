import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { FsChange, Prefs, WriteResult } from '@shared/types'
import { api, baseOf } from '@/api'
import { SourceEditor } from './SourceEditor'
import { Banner, type PageHandle, type PageMeta, type SaveStatus } from './PageView'

interface Props {
  path: string
  prefs: Prefs
  fsChange: FsChange | null
  onMeta(meta: PageMeta): void
  toast(msg: string): void
}

/**
 * A non-markdown text file (code, SQL, txt…): edited as source and saved as-is, with the
 * same compare-and-swap autosave and outside-edit handling as pages.
 */
export const CodeView = forwardRef<PageHandle, Props>(function CodeView({ path, prefs, fsChange, onMeta, toast }, ref) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(false)
  const current = useRef('')
  const lastSaved = useRef('')
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const mtime = useRef<number | null>(null)
  const status = useRef<SaveStatus>('saved')
  const conflictRef = useRef<string | null>(null)
  conflictRef.current = conflict
  const meta = useRef({ onMeta, toast })
  meta.current = { onMeta, toast }

  const emit = useCallback(
    (s?: SaveStatus) => {
      if (s) status.current = s
      meta.current.onMeta({ title: baseOf(path), status: status.current, mtime: mtime.current })
    },
    [path]
  )

  useEffect(() => {
    let cancelled = false
    api.read(path).then(
      ({ content, mtime: m }) => {
        if (cancelled) return
        current.current = lastSaved.current = content
        mtime.current = m
        setText(content)
        emit('saved')
      },
      (e: Error) => !cancelled && setError(e.message)
    )
    return () => {
      cancelled = true
    }
  }, [path, emit])

  const doSave = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!dirty.current || conflictRef.current !== null) return
    const next = current.current
    if (next === lastSaved.current) {
      dirty.current = false
      return emit('saved')
    }
    dirty.current = false
    emit('saving')
    let res: WriteResult
    try {
      res = await api.write(path, next, { expected: lastSaved.current })
    } catch (e) {
      res = { ok: false, reason: 'error', message: (e as Error).message }
    }
    if (res.ok) {
      lastSaved.current = next
      mtime.current = res.mtime
      return emit(dirty.current ? 'unsaved' : 'saved')
    }
    dirty.current = true
    if (res.reason === 'conflict') setConflict(res.disk)
    else if (res.reason === 'missing') setDeleted(true)
    else meta.current.toast(`Couldn’t save: ${res.message}`)
    emit(res.reason === 'error' ? 'error' : 'unsaved')
  }, [path, emit])

  const save = useCallback(() => (chain.current = chain.current.then(doSave)), [doSave])

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    if (!dirty.current || current.current === lastSaved.current) return
    const res = api.writeSync(path, current.current, { expected: conflictRef.current ?? lastSaved.current })
    if (res.ok) {
      lastSaved.current = current.current
      dirty.current = false
    } else if (res.reason === 'conflict') {
      // keep both versions rather than losing either
      const copy = path.replace(/(\.[^./]+)?$/, (ext) => ` (my edits)${ext}`)
      if (api.writeSync(copy, current.current, { create: true, force: true }).ok) meta.current.toast(`Your edits were saved as ${baseOf(copy)}`)
      dirty.current = false
    }
  }, [path])

  useImperativeHandle(
    ref,
    () => ({
      flush,
      settle: async () => {
        await save()
      },
      editor: () => null,
      markdown: () => current.current,
      words: () => (current.current.match(/\S+/g) || []).length,
      addProperties: () => {}
    }),
    [flush, save]
  )

  useEffect(() => () => flush(), [flush])

  // outside edits: reload when clean, otherwise pause and ask
  useEffect(() => {
    if (!fsChange) return
    if (fsChange.removed.includes(path)) return setDeleted(true)
    if (!fsChange.changed.includes(path) && !fsChange.added.includes(path)) return
    void api.read(path).then(({ content, mtime: m }) => {
      setDeleted(false)
      if (content === lastSaved.current || content === current.current) return
      mtime.current = m
      if (dirty.current) return setConflict(content)
      current.current = lastSaved.current = content
      setText(content)
      emit('reloaded')
      setTimeout(() => status.current === 'reloaded' && emit('saved'), 2500)
    })
  }, [fsChange, path, emit])

  const pageClass = ['page', 'code-page', prefs.fullWidth ? 'full-width' : ''].filter(Boolean).join(' ')
  if (error)
    return (
      <div className={pageClass}>
        <div className="page-header" />
        <Banner tone="error" title="Couldn’t open this file" detail={error} />
      </div>
    )
  return (
    <div className={pageClass}>
      <div className="page-header">
        {deleted && <Banner tone="error" title="Deleted or moved on disk" detail="Edits aren’t being saved." />}
        {conflict !== null && (
          <Banner tone="warning" title="Changed on disk" detail="Autosave is paused until you pick a version.">
            <button
              onClick={() => {
                current.current = lastSaved.current = conflict
                dirty.current = false
                setText(conflict)
                setConflict(null)
                emit('saved')
              }}
            >
              Use disk version
            </button>
            <button
              onClick={() => {
                lastSaved.current = conflict
                setConflict(null)
                conflictRef.current = null
                dirty.current = true
                void save()
              }}
            >
              Keep mine
            </button>
          </Banner>
        )}
      </div>
      <h1 className="code-title">{baseOf(path)}</h1>
      {text !== null && (
        <SourceEditor
          key={path}
          value={text}
          filename={baseOf(path)}
          onChange={(v) => {
            current.current = v
            dirty.current = true
            if (status.current !== 'unsaved') emit('unsaved')
            if (timer.current) clearTimeout(timer.current)
            if (conflictRef.current === null) timer.current = setTimeout(() => void save(), 350)
          }}
        />
      )}
    </div>
  )
})
