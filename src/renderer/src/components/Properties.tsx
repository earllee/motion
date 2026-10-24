import { useEffect, useMemo, useRef, useState } from 'react'
import { parseDocument } from 'yaml'
import { frontmatterContent, parseFrontmatter, wrapFrontmatter } from '@/editor/markdown/frontmatter'
import {
  TextPropIcon,
  ListPropIcon,
  HashIcon,
  CalendarIcon,
  CheckboxPropIcon,
  BracesIcon,
  CodeIcon,
  LinkIcon
} from './icons'

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?$/

function iconFor(value: unknown) {
  if (typeof value === 'number') return <HashIcon size={16} />
  if (typeof value === 'boolean') return <CheckboxPropIcon size={16} />
  if (Array.isArray(value)) return <ListPropIcon size={16} />
  if (value instanceof Date || (typeof value === 'string' && DATE_RE.test(value))) return <CalendarIcon size={16} />
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return <LinkIcon size={16} />
  if (value && typeof value === 'object') return <BracesIcon size={16} />
  return <TextPropIcon size={16} />
}

function scalarText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().replace(/T00:00:00\.000Z$/, '')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function NestedValue({ value }: { value: Record<string, unknown> }) {
  return (
    <div className="property-nested">
      {Object.entries(value).map(([k, v]) => (
        <div key={k}>
          <b>{k}:</b> {Array.isArray(v) ? v.map(scalarText).join(', ') : scalarText(v)}
        </div>
      ))}
    </div>
  )
}

interface Props {
  frontmatter: string
  onChange: (next: string | null) => void
  startRaw?: boolean
}

/** YAML/JSON frontmatter shown as Notion page properties. */
export function Properties({ frontmatter, onChange, startRaw }: Props) {
  const data = useMemo(() => parseFrontmatter(frontmatter), [frontmatter])
  const { lang, content } = frontmatterContent(frontmatter)
  const [raw, setRaw] = useState(!!startRaw || data === null)
  const [editing, setEditing] = useState<string | null>(null)

  if (raw || !data) {
    return <RawFrontmatter content={content} lang={lang} onDone={(next) => (setRaw(false), onChange(next))} />
  }

  const commit = (key: string, text: string, original: unknown) => {
    setEditing(null)
    let value: unknown = text
    if (typeof original === 'number' && text.trim() !== '' && !isNaN(Number(text))) value = Number(text)
    if (scalarText(original) === text) return
    if (lang === 'json') {
      const obj = { ...(data as Record<string, unknown>), [key]: value }
      onChange(wrapFrontmatter(JSON.stringify(obj, null, 2), 'json'))
      return
    }
    const doc = parseDocument(content)
    doc.setIn([key], value)
    onChange(wrapFrontmatter(doc.toString(), 'yaml'))
  }

  const toggleBool = (key: string, current: boolean) => {
    if (lang === 'json') {
      onChange(wrapFrontmatter(JSON.stringify({ ...data, [key]: !current }, null, 2), 'json'))
      return
    }
    const doc = parseDocument(content)
    doc.setIn([key], !current)
    onChange(wrapFrontmatter(doc.toString(), 'yaml'))
  }

  return (
    <div className="properties">
      {Object.entries(data).map(([key, value]) => {
        const isScalar = value === null || ['string', 'number'].includes(typeof value) || value instanceof Date
        return (
          <div className="property-row" key={key}>
            <div className="property-key" title={key}>
              {iconFor(value)}
              <span>{key}</span>
            </div>
            {editing === key && isScalar ? (
              <PropertyInput initial={scalarText(value)} onCommit={(t) => commit(key, t, value)} onCancel={() => setEditing(null)} />
            ) : typeof value === 'boolean' ? (
              <div className="property-value" onClick={() => toggleBool(key, value)}>
                <input type="checkbox" checked={value} readOnly style={{ pointerEvents: 'none', margin: 0 }} />
              </div>
            ) : Array.isArray(value) ? (
              <div className="property-value" onClick={() => setRaw(true)}>
                {value.length === 0 ? (
                  <span className="property-value empty" style={{ padding: 0 }}>Empty</span>
                ) : (
                  value.map((v, i) =>
                    v && typeof v === 'object' ? (
                      <NestedValue key={i} value={v as Record<string, unknown>} />
                    ) : (
                      <span className="property-tag" key={i}>
                        {scalarText(v)}
                      </span>
                    )
                  )
                )}
              </div>
            ) : value && typeof value === 'object' && !(value instanceof Date) ? (
              <div className="property-value" onClick={() => setRaw(true)}>
                <NestedValue value={value as Record<string, unknown>} />
              </div>
            ) : (
              <div className={`property-value${scalarText(value) ? '' : ' empty'}`} onClick={() => setEditing(key)}>
                {scalarText(value) || 'Empty'}
              </div>
            )}
          </div>
        )
      })}
      <div className="properties-actions">
        <button onClick={() => setRaw(true)}>
          <CodeIcon size={16} />
          Edit {lang === 'json' ? 'JSON' : 'YAML'}
        </button>
      </div>
      <div className="properties-divider" />
    </div>
  )
}

function PropertyInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (t: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.style.height = el.scrollHeight + 'px'
  }, [])
  return (
    <div className="property-value editing">
      <textarea
        ref={ref}
        value={v}
        rows={1}
        onChange={(e) => {
          setV(e.target.value)
          e.target.style.height = 'auto'
          e.target.style.height = e.target.scrollHeight + 'px'
        }}
        onBlur={() => onCommit(v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onCommit(v)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
    </div>
  )
}

function RawFrontmatter({ content, lang, onDone }: { content: string; lang: 'yaml' | 'json'; onDone: (next: string | null) => void }) {
  const [text, setText] = useState(content)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const finish = () => {
    if (text.trim() === '') return onDone(null)
    const wrapped = wrapFrontmatter(text, lang)
    if (parseFrontmatter(wrapped) === null) {
      setError(`Not valid ${lang === 'json' ? 'JSON' : 'YAML'} — fix it or press Esc to discard.`)
      return
    }
    onDone(wrapped)
  }
  return (
    <div className="properties properties-raw">
      <textarea
        ref={ref}
        value={text}
        spellCheck={false}
        rows={Math.min(16, Math.max(3, text.split('\n').length + 1))}
        onChange={(e) => {
          setText(e.target.value)
          setError(null)
        }}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onDone(content.trim() ? wrapFrontmatter(content, lang) : null)
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            finish()
          }
        }}
      />
      {error && <div className="error">{error}</div>}
      <div className="properties-divider" />
    </div>
  )
}
