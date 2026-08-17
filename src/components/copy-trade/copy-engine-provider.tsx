"use client";

import { createContext, useContext, type ReactNode } from "react";

import { useCopyEngine, type CopyEngine } from "@/hooks/use-copy-engine";

/**
 * One engine per page, shared by everything that needs it.
 *
 * 🚩 This context is not a convenience — it is a correctness requirement.
 * `useCopyEngine` owns a polling interval and the ledger. Calling it from two
 * components would create **two independent loops**, each with its own
 * in-memory copy of the ledger, each writing to the same localStorage key. The
 * dedup that stops one trade being copied twice is a check against the ledger
 * the loop holds, so two loops would each see a trade as new and each queue a
 * copy of it. The user gets double the exposure they asked for.
 *
 * So the engine is instantiated exactly once, here. The `Copy trader` buttons
 * on the trader cards read this context rather than starting their own.
 *
 * The value is nullable by design: `CopyCta` also renders on the signed-out
 * landing page and in mock mode, where no provider is mounted (and where
 * `usePrivy` would throw). `null` there means "no engine on this page", which
 * is a state the button already knows how to render.
 */

const CopyEngineContext = createContext<CopyEngine | null>(null);

export function CopyEngineProvider({ children }: { children: ReactNode }) {
  const engine = useCopyEngine();
  return <CopyEngineContext.Provider value={engine}>{children}</CopyEngineContext.Provider>;
}

/** `null` when rendered outside a provider — see the note above on why that is legal. */
export function useCopyEngineContext(): CopyEngine | null {
  return useContext(CopyEngineContext);
}
