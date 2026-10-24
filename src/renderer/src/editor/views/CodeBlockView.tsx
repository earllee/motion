import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { PopoverMenu } from '@/components/Menu'
import { rectOf, type AnchorRect } from '@/components/Popover'
import { ChevronDown, CopyIcon, CheckIcon, EyeIcon, CodeIcon } from '@/components/icons'
import { api } from '@/api'

export const LANGUAGES: [string, string][] = [
  ['', 'Plain text'],
  ['bash', 'Bash'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['css', 'CSS'],
  ['diff', 'Diff'],
  ['go', 'Go'],
  ['graphql', 'GraphQL'],
  ['html', 'HTML'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['json', 'JSON'],
  ['jsx', 'JSX'],
  ['kotlin', 'Kotlin'],
  ['markdown', 'Markdown'],
  ['mermaid', 'Mermaid'],
  ['php', 'PHP'],
  ['python', 'Python'],
  ['ruby', 'Ruby'],
  ['rust', 'Rust'],
  ['shell', 'Shell'],
  ['sql', 'SQL'],
  ['swift', 'Swift'],
  ['toml', 'TOML'],
  ['tsx', 'TSX'],
  ['typescript', 'TypeScript'],
  ['xml', 'XML'],
  ['yaml', 'YAML']
]

const ALIASES: Record<string, string> = {
  js: 'JavaScript',
  ts: 'TypeScript',
  sh: 'Shell',
  zsh: 'Shell',
  py: 'Python',
  yml: 'YAML',
  md: 'Markdown',
  rb: 'Ruby',
  text: 'Plain text',
  txt: 'Plain text',
  console: 'Shell'
}

export function languageLabel(lang: string | null): string {
  if (!lang) return 'Plain text'
  const found = LANGUAGES.find(([k]) => k === lang.toLowerCase())
  return found ? found[1] : ALIASES[lang.toLowerCase()] ?? lang
}

let mermaidLoader: Promise<typeof import('mermaid').default> | null = null
let mermaidSeq = 0
function loadMermaid(dark: boolean) {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: dark ? 'dark' : 'neutral',
        securityLevel: 'strict',
        fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif'
      })
      return m.default
    })
  }
  return mermaidLoader
}

function MermaidPreview({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
        const mermaid = await loadMermaid(dark)
        const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, code || 'graph TD\n  A')
        if (!cancelled) {
          setSvg(svg)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(String((e as Error)?.message || e).split('\n').slice(0, 3).join('\n'))
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [code])
  if (error) return <div className="mermaid-preview error" contentEditable={false}>{error}</div>
  return <div className="mermaid-preview" contentEditable={false} dangerouslySetInnerHTML={{ __html: svg ?? '' }} />
}

export function CodeBlockView({ node, updateAttributes, editor, getPos }: ReactNodeViewProps) {
  const [menu, setMenu] = useState<AnchorRect | null>(null)
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<'preview' | 'code'>('preview')
  const langRef = useRef<HTMLButtonElement>(null)
  const lang: string | null = node.attrs.language
  const isMermaid = lang?.toLowerCase() === 'mermaid'

  // keep the code visible while the caret is inside a mermaid block
  const [caretInside, setCaretInside] = useState(false)
  useEffect(() => {
    if (!isMermaid) return
    const update = () => {
      const pos = typeof getPos === 'function' ? getPos() : undefined
      if (pos === undefined) return
      const { from, to } = editor.state.selection
      setCaretInside(from > pos && to < pos + node.nodeSize)
    }
    editor.on('selectionUpdate', update)
    return () => {
      editor.off('selectionUpdate', update)
    }
  }, [editor, getPos, isMermaid, node.nodeSize])

  const showPreviewOnly = isMermaid && mode === 'preview' && !caretInside

  return (
    <NodeViewWrapper className={`code-block${showPreviewOnly ? ' mermaid-mode-preview' : ''}`} data-language={lang ?? ''}>
      <div className="code-block-header" contentEditable={false}>
        <button
          ref={langRef}
          className="code-lang"
          onMouseDown={(e) => {
            e.preventDefault()
            setMenu(rectOf(e.currentTarget))
          }}
        >
          {languageLabel(lang)}
          <ChevronDown size={12} />
        </button>
        <div className="code-actions">
          {isMermaid && (
            <button
              className="code-action"
              onMouseDown={(e) => {
                e.preventDefault()
                setMode(mode === 'preview' ? 'code' : 'preview')
              }}
            >
              {mode === 'preview' ? <CodeIcon size={14} /> : <EyeIcon size={14} />}
              {mode === 'preview' ? 'Code' : 'Preview'}
            </button>
          )}
          <button
            className="code-action"
            onMouseDown={(e) => {
              e.preventDefault()
              void api.copyText(node.textContent)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre spellCheck={false}>
        <NodeViewContent<'code'> as="code" />
      </pre>
      {isMermaid && <MermaidPreview code={node.textContent} />}
      {menu && (
        <PopoverMenu
          anchor={menu}
          searchable
          placeholder="Search for a language…"
          width={240}
          onClose={() => setMenu(null)}
          items={LANGUAGES.map(([k, label]) => ({
            id: k || 'plain',
            label,
            checked: (lang || '') === k,
            keywords: [k],
            onSelect: () => updateAttributes({ language: k || null })
          }))}
        />
      )}
    </NodeViewWrapper>
  )
}
