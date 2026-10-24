import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'

interface Heading {
  pos: number
  level: number
  text: string
}

function collect(editor: Editor): Heading[] {
  const out: Heading[] = []
  editor.state.doc.forEach((node, pos) => {
    if (node.type.name === 'heading' && node.attrs.level <= 3 && node.textContent.trim()) {
      out.push({ pos, level: node.attrs.level, text: node.textContent.trim() })
    }
  })
  // the title H1 isn't part of the outline
  if (out[0]?.pos === 0 && out[0].level === 1) out.shift()
  return out
}

/** Notion's floating outline: dashes on the right edge that expand into headings on hover. */
export function Outline({ editor, scroller }: { editor: Editor; scroller: HTMLElement | null }) {
  const [headings, setHeadings] = useState<Heading[]>(() => collect(editor))
  const [active, setActive] = useState(-1)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const update = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => !editor.isDestroyed && setHeadings(collect(editor)), 250)
    }
    editor.on('update', update)
    return () => {
      editor.off('update', update)
      if (t) clearTimeout(t)
    }
  }, [editor])

  useEffect(() => {
    if (!scroller) return
    const onScroll = () => {
      if (editor.isDestroyed) return
      const top = scroller.getBoundingClientRect().top + 120
      let idx = -1
      headings.forEach((h, i) => {
        const dom = editor.view.nodeDOM(h.pos) as HTMLElement | null
        if (dom && dom.getBoundingClientRect().top <= top) idx = i
      })
      setActive(idx)
    }
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scroller, headings, editor])

  if (headings.length < 3) return null
  const minLevel = Math.min(...headings.map((h) => h.level))
  const go = (h: Heading) => {
    const dom = editor.view.nodeDOM(h.pos) as HTMLElement | null
    dom?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <nav className={`outline${open ? ' open' : ''}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {!open ? (
        <div className="outline-dashes">
          {headings.map((h, i) => (
            <span key={h.pos} className={i === active ? 'active' : ''} style={{ width: 16 - (h.level - minLevel) * 4 }} />
          ))}
        </div>
      ) : (
        <div className="outline-panel">
          {headings.map((h, i) => (
            <button
              key={h.pos}
              className={i === active ? 'active' : ''}
              style={{ paddingLeft: 10 + (h.level - minLevel) * 12 }}
              onClick={() => go(h)}
              title={h.text}
            >
              {h.text}
            </button>
          ))}
        </div>
      )}
    </nav>
  )
}
