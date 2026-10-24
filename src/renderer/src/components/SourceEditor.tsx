import { useEffect, useRef } from 'react'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

const style = HighlightStyle.define([
  { tag: t.heading, fontWeight: '600', color: 'var(--text-strong)' },
  { tag: t.heading1, fontSize: '1.25em' },
  { tag: t.heading2, fontSize: '1.15em' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--blue)' },
  { tag: t.url, color: 'var(--text-3)' },
  { tag: t.monospace, color: 'var(--inline-code)' },
  { tag: t.quote, color: 'var(--text-2)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--text-3)' },
  { tag: t.list, color: 'var(--text-2)' },
  // code files
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--c-purple, #9b51e0)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--c-green, #2f9e44)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--c-orange, #d9730d)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--blue)' },
  { tag: [t.typeName, t.className, t.tagName], color: 'var(--c-red, #e03e3e)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--text-strong)' }
])

/** Markdown unless `filename` names another language CodeMirror knows. */
async function languageFor(filename?: string) {
  if (!filename || /\.(md|markdown)$/i.test(filename)) return markdown()
  const desc = LanguageDescription.matchFilename(languages, filename)
  return desc ? await desc.load() : []
}

/** Raw markdown mode (⌘/), Typora-style; also the editor for code and text files. */
export function SourceEditor({ value, onChange, filename }: { value: string; onChange: (v: string) => void; filename?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const lang = new Compartment()
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          lang.of(filename && !/\.(md|markdown)$/i.test(filename) ? [] : markdown()),
          syntaxHighlighting(style),
          // ⌘/ belongs to the app (toggle back to blocks), not CodeMirror's comment toggle
          keymap.of([indentWithTab, ...defaultKeymap.filter((b) => b.key !== 'Mod-/'), ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          })
        ]
      })
    })
    viewRef.current = view
    if (filename && !/\.(md|markdown)$/i.test(filename))
      void languageFor(filename).then((l) => !view.dom.isConnected || view.dispatch({ effects: lang.reconfigure(l) }))
    view.focus()
    return () => view.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // external reloads while in source mode
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur !== value) view.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
  }, [value])

  return <div className={`source-editor${filename && !/\.(md|markdown)$/i.test(filename) ? ' is-code' : ''}`} ref={host} />
}
