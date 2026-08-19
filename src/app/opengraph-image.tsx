import { ImageResponse } from "next/og";

/**
 * The card that renders when a Polybets link is shared.
 *
 * No custom font is loaded on purpose. Satori — the renderer behind `next/og` —
 * reads TTF, OTF and WOFF, but **not WOFF2**, and the only faces committed to
 * this repo are `Geist-Variable.woff2` / `GeistMono-Variable.woff2`. Passing
 * either would throw at build. `next/og`'s bundled default sans is used
 * instead; matching Geist here would mean committing a second copy of the font
 * in another format purely for this one image.
 *
 * Kept free of dynamic data so Next can prerender it to a static file at build
 * time rather than pulling the Satori/resvg WASM into the Worker bundle — which
 * is already ~4.79 MiB gzipped against a 10 MiB cap (see CLAUDE.md Traps).
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
