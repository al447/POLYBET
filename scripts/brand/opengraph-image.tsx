import { ImageResponse } from "next/og";

/**
 * GENERATOR for `src/app/opengraph-image.png` — **not a route.**
 *
 * ⚠️ Do not move this back into `src/app/`. Measured 2026-08-19: living there
 * as a route costs **~989 KiB gzipped** in the Worker bundle (`resvg.wasm` 517,
 * `index.node.js` 213, `index.edge.js` 163, `yoga.wasm` 28) — about 10% of the
 * entire 10 MiB cap. Marking the route static does **not** avoid this: Next
 * reported it as `○ (Static)` and prerendered the PNG, and OpenNext bundled the
 * whole `@vercel/og` runtime into the server function anyway. The committed PNG
 * is byte-identical to what this produced, at zero runtime cost.
 *
 * No custom font is loaded on purpose. Satori — the renderer behind `next/og` —
 * reads TTF, OTF and WOFF, but **not WOFF2**, and the only faces committed to
 * this repo are `Geist-Variable.woff2` / `GeistMono-Variable.woff2`. Passing
 * either throws at build, so this uses `next/og`'s bundled default sans.
 *
 * To regenerate after a brand change:
 *   1. cp scripts/brand/opengraph-image.tsx src/app/
 *   2. npm run build
 *   3. cp .next/server/app/opengraph-image.body src/app/opengraph-image.png
 *   4. rm src/app/opengraph-image.tsx      ← do not skip this step
 */

export const alt = "Polybets — prediction markets";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          backgroundColor: "#09090b",
          padding: "0 96px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <svg
            width="96"
            height="96"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#34d399"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z" />
            <path
              d="M12 2 L12 22 M3 7 L21 17 M21 7 L3 17"
              strokeWidth={1.25}
              opacity={0.5}
            />
          </svg>
          <div
            style={{
              fontSize: 96,
              fontWeight: 700,
              color: "#fafafa",
              letterSpacing: "-0.03em",
            }}
          >
            Polybets
          </div>
        </div>

        <div
          style={{
            marginTop: 32,
            fontSize: 38,
            color: "#a1a1aa",
            letterSpacing: "-0.01em",
          }}
        >
          Prediction markets on Polymarket liquidity
        </div>

        <div style={{ marginTop: 16, fontSize: 28, color: "#52525b" }}>
          Self-custodial — you hold your own keys
        </div>
      </div>
    ),
    { ...size },
  );
}
