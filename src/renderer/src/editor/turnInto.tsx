import type { ReactNode } from 'react'
import type { BlockKind } from './blocks'
import {
  TextIcon,
  Glyph,
  BulletListIcon,
  NumberedListIcon,
  TodoIcon,
  ToggleIcon,
  QuoteIcon,
  CalloutIcon,
  CodeBlockIcon
} from '@/components/icons'

export const TURN_INTO: { kind: BlockKind; label: string; icon: ReactNode; keywords?: string[] }[] = [
  { kind: 'paragraph', label: 'Text', icon: <TextIcon size={18} />, keywords: ['paragraph'] },
  { kind: 'h1', label: 'Heading 1', icon: <Glyph text="H1" size={20} />, keywords: ['title'] },
  { kind: 'h2', label: 'Heading 2', icon: <Glyph text="H2" size={20} /> },
  { kind: 'h3', label: 'Heading 3', icon: <Glyph text="H3" size={20} /> },
  { kind: 'bulletList', label: 'Bulleted list', icon: <BulletListIcon size={18} /> },
  { kind: 'orderedList', label: 'Numbered list', icon: <NumberedListIcon size={18} /> },
  { kind: 'taskList', label: 'To-do list', icon: <TodoIcon size={18} />, keywords: ['todo', 'checkbox'] },
  { kind: 'toggle', label: 'Toggle list', icon: <ToggleIcon size={16} /> },
  { kind: 'blockquote', label: 'Quote', icon: <QuoteIcon size={18} /> },
  { kind: 'callout', label: 'Callout', icon: <CalloutIcon size={18} /> },
  { kind: 'codeBlock', label: 'Code', icon: <CodeBlockIcon size={18} /> }
]

export const KIND_LABEL: Record<BlockKind, string> = Object.fromEntries(TURN_INTO.map((t) => [t.kind, t.label])) as Record<
  BlockKind,
  string
>
