import { Menu, app, shell, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/types'

export function buildMenu(run: (cmd: MenuCommand) => void): Menu {
  const cmd = (label: string, command: MenuCommand, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => run(command)
  })

  // extra shortcuts for the same command, kept out of sight like Chrome's
  const hidden = (command: MenuCommand, accelerator: string): MenuItemConstructorOptions => ({
    label: command,
    accelerator,
    visible: false,
    acceleratorWorksWhenHidden: true,
    click: () => run(command)
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        cmd('New Page', 'new-page', 'CmdOrCtrl+N'),
        cmd('New Tab', 'new-tab', 'CmdOrCtrl+T'),
        { type: 'separator' },
        cmd('Open Folder…', 'open-folder', 'CmdOrCtrl+O'),
        cmd('Open File…', 'open-file', 'CmdOrCtrl+Shift+O'),
        { type: 'separator' },
        cmd('Reload From Disk', 'reload-file', 'CmdOrCtrl+Shift+R'),
        cmd('Reveal in Finder', 'reveal', 'CmdOrCtrl+Alt+R'),
        cmd('Copy Path', 'copy-path', 'CmdOrCtrl+Shift+C'),
        { type: 'separator' },
        cmd('Close Tab', 'close-tab', 'CmdOrCtrl+W'),
        cmd('Reopen Closed Tab', 'reopen-tab', 'CmdOrCtrl+Shift+T'),
        { role: 'close', accelerator: 'CmdOrCtrl+Shift+W' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        cmd('Find…', 'find', 'CmdOrCtrl+F'),
        { type: 'separator' },
        { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
      ]
    },
    {
      label: 'View',
      submenu: [
        cmd('Search', 'search', 'CmdOrCtrl+P'),
        cmd('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+\\'),
        cmd('Toggle Markdown Source', 'toggle-source', 'CmdOrCtrl+/'),
        { type: 'separator' },
        {
          label: 'Style',
          submenu: [
            cmd('Default', 'font-default'),
            cmd('Serif', 'font-serif'),
            cmd('Mono', 'font-mono'),
            { type: 'separator' },
            cmd('Small Text', 'toggle-small-text'),
            cmd('Full Width', 'toggle-full-width', 'CmdOrCtrl+Shift+\\')
          ]
        },
        {
          label: 'Appearance',
          submenu: [cmd('Use System Setting', 'theme-system'), cmd('Light', 'theme-light'), cmd('Dark', 'theme-dark', 'CmdOrCtrl+Shift+L')]
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload', accelerator: 'CmdOrCtrl+Alt+Shift+R' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' }
      ]
    },
    {
      label: 'Go',
      submenu: [
        cmd('Back', 'back', 'CmdOrCtrl+['),
        cmd('Forward', 'forward', 'CmdOrCtrl+]'),
        { type: 'separator' },
        cmd('Next Tab', 'next-tab', 'Ctrl+Tab'),
        cmd('Previous Tab', 'prev-tab', 'Ctrl+Shift+Tab'),
        hidden('next-tab', 'CmdOrCtrl+Shift+]'),
        hidden('prev-tab', 'CmdOrCtrl+Shift+['),
        ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => hidden(`tab-${n}`, `CmdOrCtrl+${n}`))
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Markdown Guide',
          click: () => void shell.openExternal('https://www.markdownguide.org/cheat-sheet/')
        }
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}
