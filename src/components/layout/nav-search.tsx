"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { SearchIcon } from "@/components/ui/icons";

/**
 * Live market search (FR-2.4), wired to the discovery grid via the `q` URL
 * param. `MarketGrid` reads it and switches to full-catalogue search against
 * Gamma's `/public-search` — not a filter over what's already on screen, which
 * is what this used to drive. Debounced so every keystroke doesn't rewrite
 * browser history or spend a request.
 *
 * Always targets `/` — it's the only page with a market grid.
 *
 * ⚠️ `hidden lg:block`: there is no search on mobile yet. It belongs in the
 * nav bar's mobile menu, which is still a disabled placeholder.
 */
export function NavSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get("q") ?? "");

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

  return (
    <div className="relative hidden lg:block">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-600" />
      <input
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search markets"
        className="w-56 rounded-lg border border-zinc-800 bg-zinc-900/60 py-2 pr-3 pl-9 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600 focus:outline-none"
      />
    </div>
  );
}
