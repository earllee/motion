import { parse as parseYaml } from 'yaml'

// `---` YAML frontmatter, plus gray-matter style `---json`.
const FRONTMATTER_RE = /^---(yaml|json)?[ \t]*\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/

export type FrontmatterLang = 'yaml' | 'json'

/** Split a leading frontmatter block off the body. Only an object/mapping counts. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const m = FRONTMATTER_RE.exec(text)
  if (!m) return { frontmatter: null, body: text }
  const { lang, content } = frontmatterContent(m[0])
  try {
    if (content.trim() !== '') {
      const data = lang === 'json' ? JSON.parse(content) : parseYaml(content)
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return { frontmatter: null, body: text }
    }
  } catch {
    return { frontmatter: null, body: text }
  }
  return { frontmatter: m[0], body: text.slice(m[0].length) }
}

/** The text between the delimiters, and its language. */
export function frontmatterContent(frontmatter: string): { lang: FrontmatterLang; content: string } {
  const lang: FrontmatterLang = /^---json/.test(frontmatter) ? 'json' : 'yaml'
  const content = frontmatter.replace(/^---(?:yaml|json)?[ \t]*\n/, '').replace(/(?:---|\.\.\.)[ \t]*\n?$/, '')
  return { lang, content }
}

export function parseFrontmatter(frontmatter: string): Record<string, unknown> | null {
  const { lang, content } = frontmatterContent(frontmatter)
  try {
    const data = lang === 'json' ? JSON.parse(content) : parseYaml(content)
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return null
  }
}

export function wrapFrontmatter(content: string, lang: FrontmatterLang = 'yaml'): string {
  const body = content.endsWith('\n') || content === '' ? content : content + '\n'
  return `---${lang === 'json' ? 'json' : ''}\n${body}---\n`
}
