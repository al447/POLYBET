"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CloseIcon, SearchIcon } from "@/components/ui/icons";

/**
 * Live market search (FR-2.4), wired to the discovery grid via the `q` URL
 * param. `MarketGrid` reads it and switches to full-catalogue search against
 * Gamma's `/public-search` — not a filter over what's already on screen.
 * Debounced so every keystroke doesn't rewrite browser history or spend a
 * request.
 *
 * Always targets `/` — it's the only page with a market grid.
 *
 * Sizing is the caller's job now: this fills whatever slot the nav bar gives
 * it (`w-full`), which is how it became the wide centre element of the
 * masthead instead of a 224px box pinned to the right. It also no longer hides
 * below `lg` — search on mobile used to be simply missing.
 */
export function NavSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get("q") ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set("q", value);
      else params.delete("q");
      const query = params.toString();
      router.replace(query ? `/?${query}` : "/", { scroll: false });
    }, 300);
    return () => clearTimeout(handle);
    // Intentionally keyed only on `value`: including `searchParams`/`router`
    // would refire this effect on the very navigation it just caused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // "/" focuses the box from anywhere on the page — the shortcut the `/` hint
  // inside the input advertises. Skipped when the user is already typing
  // somewhere, or a "/" would be swallowed mid-word in the order ticket.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (typing) return;

      event.preventDefault();
      inputRef.current?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="relative w-full">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-zinc-500" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          setValue("");
          inputRef.current?.blur();
        }}
        placeholder="Search markets..."
        aria-label="Search markets"
        // `appearance-none` kills Safari's own search decorations, which would
        // otherwise sit on top of the clear button below.
        className="w-full appearance-none rounded-xl border border-zinc-800 bg-zinc-900/70 py-2.5 pr-11 pl-10 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-600 focus:bg-zinc-900 focus:ring-1 focus:ring-zinc-600 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />

      {value ? (
        <button
          type="button"
          onClick={() => {
            setValue("");
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md p-1 text-zinc-500 transition hover:text-zinc-200"
        >
          <CloseIcon className="size-4" />
        </button>
      ) : (
        <kbd
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] leading-none text-zinc-500 sm:block"
        >
          /
        </kbd>
      )}
    </div>
  );
}
