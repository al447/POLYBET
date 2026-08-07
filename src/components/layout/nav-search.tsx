"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { SearchIcon } from "@/components/ui/icons";

/**
 * Live market search (FR-2.4), wired to the discovery grid via the `q` URL
 * param — see `MarketGrid`'s client-side substring filter over already-loaded
 * markets. Debounced so every keystroke doesn't rewrite browser history.
 *
 * Always targets `/` — it's the only page with a market grid to filter.
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
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
      // keyed only on `value`; including searchParams/router would refire this
      // effect on every navigation it itself causes.
    }, 300);
    return () => clearTimeout(handle);
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
