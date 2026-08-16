import type { SVGProps } from "react";

/**
 * Hand-rolled inline SVGs, not an icon library.
 *
 * The Worker bundle is already ~4.79 MiB gzipped against a 10 MiB paid cap
 * (see CLAUDE.md Traps), so a new icon dependency is a real cost, not a
 * convenience. These are the glyphs the nav bar, its menus and the sidebar
 * need — nothing speculative.
 */

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Generic geometric mark — this is a white-label frontend, not Polymarket's own brand. */
export function LogoMark(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z" />
      <path d="M12 2 L12 22 M3 7 L21 17 M21 7 L3 17" strokeWidth={1.25} opacity={0.5} />
    </svg>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function ChartIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 20 V10 M12 20 V4 M20 20 V14" />
    </svg>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </svg>
  );
}

export function TrophyIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M7 4h10v4a5 5 0 0 1-10 0Z" />
      <path d="M7 5H4a3 3 0 0 0 3 5M17 5h3a3 3 0 0 1-3 5" />
      <path d="M12 13v3M9 21h6M10 18h4v3h-4Z" />
    </svg>
  );
}

export function GiftIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M5 12h14v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1Z" />
      <path d="M12 8v13" />
      <path d="M12 8c-1.2-3.2-6-3.4-6 0M12 8c1.2-3.2 6-3.4 6 0" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function StarIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

export function TrendingIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/** Copy trading — one trader, one follower. */
export function UsersIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16.5 5.3a3.5 3.5 0 0 1 0 6.4M18 14.5a6 6 0 0 1 3 5.5" />
    </svg>
  );
}

/** Predict AI. */
export function SparkleIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M11 3l1.7 4.3L17 9l-4.3 1.7L11 15l-1.7-4.3L5 9l4.3-1.7Z" />
      <path d="M18 14.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8Z" strokeWidth={1.25} />
    </svg>
  );
}

export function HelpIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.2 2.4c-.6.2-1 .8-1 1.4v.3" />
      <path d="M11.9 16.8h.01" strokeWidth={2.25} />
    </svg>
  );
}

/** Hot topics. */
export function FlameIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 21a6 6 0 0 0 6-6c0-4.2-4.2-5.6-4.2-9.6 0 0-3.3 1.6-3.3 5.3 0 1.3-1.1 2-1.9 1.2C7.7 12 6 13.4 6 15a6 6 0 0 0 6 6Z" />
    </svg>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  );
}

export function BookmarkIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 4h12v17l-6-4-6 4Z" />
    </svg>
  );
}
