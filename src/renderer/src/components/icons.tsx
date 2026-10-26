import type { CSSProperties, ReactNode } from 'react'

interface P {
  size?: number
  style?: CSSProperties
  className?: string
}

const svg = (children: ReactNode, viewBox = '0 0 20 20') =>
  function Icon({ size = 18, style, className }: P) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: 'block', ...style }}
        className={className}
      >
        {children}
      </svg>
    )
  }

export const PageIcon = svg(
  <>
    <path d="M5.5 2.75h6.1l3.65 3.65v10.1a.75.75 0 0 1-.75.75H5.5a.75.75 0 0 1-.75-.75V3.5a.75.75 0 0 1 .75-.75Z" />
    <path d="M11.5 2.9v3.35a.5.5 0 0 0 .5.5h3.2" />
    <path d="M7.25 10.25h5.5M7.25 13h5.5" />
  </>
)

export const FolderIcon = svg(
  <path d="M2.75 5.25a1.5 1.5 0 0 1 1.5-1.5h3.1l1.6 1.75h6.8a1.5 1.5 0 0 1 1.5 1.5v7.75a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5V5.25Z" />
)

export const ChevronRight = svg(<path d="m8 5.5 4.5 4.5L8 14.5" />)
export const ChevronDown = svg(<path d="m5.5 8 4.5 4.5L14.5 8" />)
export const ChevronLeft = svg(<path d="M12 5.5 7.5 10l4.5 4.5" />)

export const PlusIcon = svg(<path d="M10 4.25v11.5M4.25 10h11.5" />)

export function DragIcon({ size = 18 }: P) {
  return (
    <svg width={size * 0.6} height={size} viewBox="0 0 10 16" style={{ display: 'block' }} fill="currentColor">
      {[2.5, 8, 13.5].map((y) => (
        <g key={y}>
          <circle cx="2.8" cy={y} r="1.3" />
          <circle cx="7.2" cy={y} r="1.3" />
        </g>
      ))}
    </svg>
  )
}

export const SearchIcon = svg(
  <>
    <circle cx="8.75" cy="8.75" r="5" />
    <path d="m12.5 12.5 4 4" />
  </>
)

export const TrashIcon = svg(
  <>
    <path d="M3.75 5.5h12.5M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
    <path d="m5.25 5.5.7 10.1a1 1 0 0 0 1 .9h6.1a1 1 0 0 0 1-.9l.7-10.1" />
  </>
)

export const DuplicateIcon = svg(
  <>
    <rect x="6.75" y="6.75" width="9.5" height="9.5" rx="1.5" />
    <path d="M13.25 6.5V5a1.25 1.25 0 0 0-1.25-1.25H5A1.25 1.25 0 0 0 3.75 5v7A1.25 1.25 0 0 0 5 13.25h1.5" />
  </>
)

export function MoreIcon({ size = 18 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" style={{ display: 'block' }}>
      <circle cx="4.5" cy="10" r="1.4" />
      <circle cx="10" cy="10" r="1.4" />
      <circle cx="15.5" cy="10" r="1.4" />
    </svg>
  )
}

export const CollapseIcon = svg(
  <>
    <path d="m10.5 5.5-4.5 4.5 4.5 4.5" />
    <path d="m15 5.5-4.5 4.5 4.5 4.5" />
  </>
)

export const AlertIcon = svg(
  <>
    <path d="M8.7 3.6 2.9 13.8A1.5 1.5 0 0 0 4.2 16h11.6a1.5 1.5 0 0 0 1.3-2.2L11.3 3.6a1.5 1.5 0 0 0-2.6 0Z" />
    <path d="M10 8v3.25" />
    <circle cx="10" cy="13.6" r=".4" fill="currentColor" />
  </>
)

export const SidebarIcon = svg(
  <>
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" />
    <path d="M7.5 3.75v12.5" />
  </>
)

export const MenuIcon = svg(<path d="M3.75 5.75h12.5M3.75 10h12.5M3.75 14.25h12.5" />)

export const StarIcon = svg(
  <path d="m10 3.25 2.05 4.2 4.6.65-3.33 3.24.79 4.58L10 13.77l-4.11 2.15.79-4.58L3.35 8.1l4.6-.65L10 3.25Z" />
)

export function StarFilledIcon({ size = 18 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={{ display: 'block' }}>
      <path
        d="m10 3.25 2.05 4.2 4.6.65-3.33 3.24.79 4.58L10 13.77l-4.11 2.15.79-4.58L3.35 8.1l4.6-.65L10 3.25Z"
        fill="rgb(242, 187, 47)"
        stroke="rgb(242, 187, 47)"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const CodeIcon = svg(<path d="m7 6-4 4 4 4M13 6l4 4-4 4" />)

export const SuggestIcon = svg(
  <>
    <path d="M12.6 4.4 15.6 7.4 8.5 14.5H5.5v-3l7.1-7.1Z" />
    <path d="M11 6 14 9" />
  </>
)

export const CheckIcon = svg(<path d="m4.5 10.5 3.5 3.5 7.5-8" />)

export const LinkIcon = svg(
  <>
    <path d="M8.5 11.5a3 3 0 0 0 4.24 0l2.5-2.5a3 3 0 0 0-4.24-4.24l-.75.75" />
    <path d="M11.5 8.5a3 3 0 0 0-4.24 0l-2.5 2.5a3 3 0 0 0 4.24 4.24l.75-.75" />
  </>
)

export const CopyIcon = DuplicateIcon

export const ExternalIcon = svg(
  <>
    <path d="M11.5 3.75h4.75V8.5M16 4l-6.5 6.5" />
    <path d="M14.25 11.5v3.25a1.5 1.5 0 0 1-1.5 1.5h-7.5a1.5 1.5 0 0 1-1.5-1.5v-7.5a1.5 1.5 0 0 1 1.5-1.5H8.5" />
  </>
)

export const BulletListIcon = svg(
  <>
    <circle cx="4.5" cy="5.75" r=".9" fill="currentColor" />
    <circle cx="4.5" cy="10" r=".9" fill="currentColor" />
    <circle cx="4.5" cy="14.25" r=".9" fill="currentColor" />
    <path d="M8 5.75h8.25M8 10h8.25M8 14.25h8.25" />
  </>
)

export function NumberedListIcon({ size = 18 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={{ display: 'block' }}>
      <text x="2.2" y="7.6" fontSize="5.5" fontWeight="600" fill="currentColor" fontFamily="-apple-system">1</text>
      <text x="2.2" y="12" fontSize="5.5" fontWeight="600" fill="currentColor" fontFamily="-apple-system">2</text>
      <text x="2.2" y="16.4" fontSize="5.5" fontWeight="600" fill="currentColor" fontFamily="-apple-system">3</text>
      <path d="M8 5.75h8.25M8 10h8.25M8 14.25h8.25" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export const TodoIcon = svg(
  <>
    <rect x="3.75" y="3.75" width="12.5" height="12.5" rx="2" />
    <path d="m7 10.25 2 2 4-4.5" />
  </>
)

export function ToggleIcon({ size = 18 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={{ display: 'block' }} fill="currentColor">
      <path d="M6.5 4.8v10.4a.5.5 0 0 0 .8.4l7-5.2a.5.5 0 0 0 0-.8l-7-5.2a.5.5 0 0 0-.8.4Z" />
    </svg>
  )
}

export function TriangleIcon({ size = 12 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" style={{ display: 'block' }} fill="currentColor">
      <path d="M4 2.2v7.6a.4.4 0 0 0 .65.31l4.75-3.8a.4.4 0 0 0 0-.62L4.65 1.89A.4.4 0 0 0 4 2.2Z" />
    </svg>
  )
}

export const QuoteIcon = svg(
  <>
    <path d="M4.25 4.25v11.5" strokeWidth={2} />
    <path d="M8 6.25h8M8 10h8M8 13.75h5.5" />
  </>
)

export const CalloutIcon = svg(
  <>
    <rect x="2.75" y="4.25" width="14.5" height="11.5" rx="2" />
    <path d="M6.5 8.25h7M6.5 11.5h4.5" />
  </>
)

export const DividerIcon = svg(<path d="M3 10h14" />)

export const CodeBlockIcon = svg(
  <>
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" />
    <path d="m7.75 8-2 2 2 2M12.25 8l2 2-2 2" />
  </>
)

export const TableIcon = svg(
  <>
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="1.75" />
    <path d="M2.75 8h14.5M2.75 12h14.5M8 8v8.25M12.5 8v8.25" />
  </>
)

export const ImageIcon = svg(
  <>
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" />
    <circle cx="7.25" cy="8" r="1.4" />
    <path d="m3 14.5 4-4 3 3 2.5-2.5 4.5 4.5" />
  </>
)

export const TurnIntoIcon = svg(
  <>
    <path d="M4 7.5h10.5l-3-3M16 12.5H5.5l3 3" />
  </>
)

export const TextIcon = ({ size = 18 }: P) => (
  <span style={{ fontSize: size * 0.82, fontWeight: 500, lineHeight: 1, letterSpacing: '-0.02em' }}>Aa</span>
)

export function Glyph({ text, size = 18 }: { text: string; size?: number }) {
  return (
    <span style={{ fontSize: size * 0.72, fontWeight: 600, lineHeight: 1, letterSpacing: '-0.02em' }}>{text}</span>
  )
}

export const ClockIcon = svg(
  <>
    <circle cx="10" cy="10" r="6.75" />
    <path d="M10 6.25V10l2.5 1.75" />
  </>
)

export const SettingsIcon = svg(
  <>
    <circle cx="10" cy="10" r="2.25" />
    <path d="M10 2.75v1.6M10 15.65v1.6M17.25 10h-1.6M4.35 10h-1.6M15.13 4.87l-1.13 1.13M6 14l-1.13 1.13M15.13 15.13 14 14M6 6 4.87 4.87" />
  </>
)

export const SunIcon = svg(
  <>
    <circle cx="10" cy="10" r="3.25" />
    <path d="M10 2.75v1.5M10 15.75v1.5M17.25 10h-1.5M4.25 10h-1.5M15.13 4.87l-1.06 1.06M5.93 14.07l-1.06 1.06M15.13 15.13l-1.06-1.06M5.93 5.93 4.87 4.87" />
  </>
)

export const MoonIcon = svg(<path d="M15.5 12.4A6.5 6.5 0 0 1 7.6 4.5a6.5 6.5 0 1 0 7.9 7.9Z" />)

export const MarkdownIcon = svg(
  <>
    <rect x="2.25" y="4.75" width="15.5" height="10.5" rx="2" />
    <path d="M5 12.5v-5l2 2.25 2-2.25v5M12.75 7.5v5M10.9 10.75l1.85 1.85 1.85-1.85" />
  </>
)

export const ArrowLeftIcon = svg(<path d="M15.5 10h-11M9 5 4 10l5 5" />)
export const ArrowRightIcon = svg(<path d="M4.5 10h11M11 5l5 5-5 5" />)
export const ArrowUpIcon = svg(<path d="M10 15.5v-11M5 9l5-5 5 5" />)
export const ArrowDownIcon = svg(<path d="M10 4.5v11M5 11l5 5 5-5" />)

export const CloseIcon = svg(<path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />)

export const ReturnIcon = svg(<path d="M15.5 4.5v5a2 2 0 0 1-2 2h-9M8 8l-3.5 3.5L8 15" />)

export const NewPageIcon = svg(
  <>
    <path d="M14.5 10.75v4.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 5.75h4.5" />
    <path d="m13.6 3.4 3 3-6.1 6.1-3.6.6.6-3.6 6.1-6.1Z" />
  </>
)

export const FolderOpenIcon = svg(
  <>
    <path d="M2.75 14.5V5.25a1.5 1.5 0 0 1 1.5-1.5h3.1l1.6 1.75h5.3a1.5 1.5 0 0 1 1.5 1.5v1.25" />
    <path d="M2.75 14.5 5 9.25a1.5 1.5 0 0 1 1.38-.9h10.1a.75.75 0 0 1 .69 1.04l-2.2 5.2a1.5 1.5 0 0 1-1.38.91H4.25a1.5 1.5 0 0 1-1.5-1.5" />
  </>
)

export const TextPropIcon = svg(<path d="M4 5.5h12M4 10h12M4 14.5h7" />)
export const ListPropIcon = svg(
  <>
    <path d="M7.5 6h8.5M7.5 10h8.5M7.5 14h8.5" />
    <path d="M4 6h.5M4 10h.5M4 14h.5" strokeWidth={2} />
  </>
)
export const HashIcon = svg(<path d="M7.5 3.5 6 16.5M14 3.5l-1.5 13M4 7.25h12.5M3.5 12.75H16" />)
export const CalendarIcon = svg(
  <>
    <rect x="3.25" y="4.25" width="13.5" height="12" rx="1.75" />
    <path d="M3.25 8h13.5M7 2.75v3M13 2.75v3" />
  </>
)
export const CheckboxPropIcon = TodoIcon
export const BracesIcon = svg(
  <path d="M7 3.75H6a1.5 1.5 0 0 0-1.5 1.5v3L3.25 10l1.25 1.75v3A1.5 1.5 0 0 0 6 16.25h1M13 3.75h1a1.5 1.5 0 0 1 1.5 1.5v3L16.75 10l-1.25 1.75v3a1.5 1.5 0 0 1-1.5 1.5h-1" />
)
export const MermaidIcon = svg(
  <>
    <rect x="2.75" y="3.25" width="5.5" height="4" rx="1" />
    <rect x="11.75" y="12.75" width="5.5" height="4" rx="1" />
    <path d="M5.5 7.25v3.25a1.5 1.5 0 0 0 1.5 1.5h7.5v.75" />
  </>
)
export const EyeIcon = svg(
  <>
    <path d="M2.5 10s2.75-5.25 7.5-5.25S17.5 10 17.5 10s-2.75 5.25-7.5 5.25S2.5 10 2.5 10Z" />
    <circle cx="10" cy="10" r="2.25" />
  </>
)
export const RowIcon = svg(
  <>
    <rect x="3" y="7" width="14" height="6" rx="1" />
  </>
)
export const ColumnIcon = svg(
  <>
    <rect x="7" y="3" width="6" height="14" rx="1" />
  </>
)

/** Motion's mark: a Charter Black M sliced into blocks, with the V lifted as if mid-drag. */
import markSvg from '@/assets/mark.svg?raw'

export function LogoMark({ size = 32, color = 'var(--blue)' }: { size?: number; color?: string }) {
  return (
    <span
      aria-label="Motion"
      style={{ display: 'block', width: size, height: size, color, lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: markSvg.replace('<svg ', `<svg width="${size}" height="${size}" `) }}
    />
  )
}
