"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Minimal dropdown menu — the nav bar's hamburger and the category row's
 * "More" overflow both need one, and there wasn't a popover anywhere in the
 * app before this.
 *
 * Hand-rolled rather than pulling in Radix or Headless UI, for the same reason
 * `primitives.tsx` gives for skipping shadcn: the Worker bundle is ~4.79 MiB
 * gzipped against a 10 MiB paid cap (CLAUDE.md), so a dependency for two
 * dropdowns is a real cost. What that buys us is click-outside, Escape, and
 * the aria wiring — not a full focus trap or roving tabindex. These are short,
 * link-only menus where Tab already lands on every item in order.
 *
 * No portal. The header is already `sticky z-10`, so an absolutely-positioned
 * panel inside it stacks correctly without escaping the DOM tree.
 */

/** Lets `MenuItem` close the menu it's inside without prop-drilling. */
const MenuCloseContext = createContext<() => void>(() => {});

export function Menu({
  label,
  trigger,
  align = "right",
  triggerClassName,
  panelClassName,
  children,
}: {
  /** Accessible name for the trigger. Needed because triggers are often icon-only. */
  label: string;
  /** Receives `open` so a caller can rotate a chevron or highlight the button. */
  trigger: (open: boolean) => ReactNode;
  align?: "left" | "right";
  triggerClassName?: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    // `pointerdown` rather than `click`: a click that starts outside and ends
    // on the panel (a drag, a text selection) shouldn't count as "outside".
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Escape must hand focus back, or the user is stranded at the top of the
      // document with no idea where they are.
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => setOpen((previous) => !previous)}
        className={triggerClassName}
      >
        {trigger(open)}
      </button>

      {open ? (
        <div
          id={panelId}
          role="menu"
          aria-label={label}
          className={`absolute top-full z-20 mt-2 min-w-56 rounded-xl border border-zinc-800 bg-zinc-950 p-1.5 shadow-xl shadow-black/50 ${
            align === "right" ? "right-0" : "left-0"
          } ${panelClassName ?? ""}`}
        >
          <MenuCloseContext.Provider value={() => setOpen(false)}>{children}</MenuCloseContext.Provider>
        </div>
      ) : null}
    </div>
  );
}

const itemClass =
  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition";

export function MenuItem({
  href,
  icon,
  children,
}: {
  href: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const close = useContext(MenuCloseContext);
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={close}
      className={`${itemClass} text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100`}
    >
      {icon ? <span className="shrink-0 text-zinc-500">{icon}</span> : null}
      {children}
    </Link>
  );
}

/** For menu rows that run an action instead of navigating — sign in, sign out. */
export function MenuButton({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const close = useContext(MenuCloseContext);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        close();
        onClick();
      }}
      className={`${itemClass} cursor-pointer text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100`}
    >
      {icon ? <span className="shrink-0 text-zinc-500">{icon}</span> : null}
      {children}
    </button>
  );
}

/**
 * A row for a feature that doesn't exist yet.
 *
 * Same convention as `InertNavItem` in the old nav bar and `AuthNotConfigured`
 * / `WalletUnavailable` elsewhere: show the control, explain why it does
 * nothing, rather than hide it and leave the user wondering where the feature
 * went. `aria-disabled` says the same thing to a screen reader that the muted
 * colour says visually.
 */
export function MenuItemInert({
  icon,
  children,
  title = "Coming soon",
}: {
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      role="menuitem"
      aria-disabled
      title={title}
      className={`${itemClass} cursor-default text-zinc-600`}
    >
      {icon ? <span className="shrink-0 text-zinc-700">{icon}</span> : null}
      {children}
    </span>
  );
}

export function MenuDivider() {
  return <hr className="my-1.5 border-zinc-800" role="separator" />;
}
