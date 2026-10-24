import { Extension, type AnyExtension } from '@tiptap/core'
import type { Plugin } from '@tiptap/pm/state'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { baseExtensions } from '../schema'
import { NotionKeys } from './notionKeys'
import { SlashCommand } from './slash'
import { MarkdownClipboard } from './clipboard'
import { Links, type LinkOptions } from './links'
import { Find } from './find'
import { Placeholders } from './placeholder'
import { BlockDrop } from './blockDrop'
import { PageMention } from './pageMention'
import type { FileEntry } from '@shared/types'
import { CalloutView, ImageView, TableView, ToggleView } from '../views/domViews'
import { CodeBlockView } from '../views/CodeBlockView'

export interface EditorHooks extends LinkOptions {
  plugins?: Plugin[]
  files: () => FileEntry[]
  docPath: () => string | null
  saveImage: (file: File) => Promise<string | null>
  onCalloutIcon: (pos: number, rect: DOMRect) => void
}

export function editorExtensions(hooks: EditorHooks): AnyExtension[] {
  return [
    ...baseExtensions({
      callout: ({ node, getPos }) => new CalloutView(node, hooks.onCalloutIcon, getPos as () => number | undefined),
      toggle: ({ node, view, getPos }) => new ToggleView(node, view, getPos as () => number | undefined),
      image: ({ node }) => new ImageView(node, hooks.docPath),
      table: ({ node }) => new TableView(node),
      codeBlock: ReactNodeViewRenderer(CodeBlockView)
    }),
    NotionKeys,
    SlashCommand,
    MarkdownClipboard.configure({ onImage: hooks.saveImage }),
    Links.configure({ openLink: hooks.openLink, openWiki: hooks.openWiki, resolveWiki: hooks.resolveWiki }),
    Find,
    Placeholders,
    BlockDrop,
    PageMention.configure({ files: hooks.files, docPath: hooks.docPath }),
    Extension.create({ name: 'hostPlugins', addProseMirrorPlugins: () => hooks.plugins ?? [] })
  ]
}
