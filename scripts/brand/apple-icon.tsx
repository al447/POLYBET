import { ImageResponse } from "next/og";

/**
 * GENERATOR for `src/app/apple-icon.png` — **not a route.**
 *
 * ⚠️ Do not move this back into `src/app/`. See the header of
 * `opengraph-image.tsx` next door: as a route it drags the ~989 KiB `next/og`
 * runtime into the Worker bundle even though the output is fully static.
 *
 * iOS home-screen icon, 180x180. Full-bleed square with no rounded corners:
 * iOS applies its own corner radius and masks whatever it is given, so rounding
 * here would show as a dark ring inside the system's own curve. PNG rather than
 * reusing `icon.svg` because the `apple-icon` convention does not accept SVG.
 *
 * Regenerate the same way, swapping `apple-icon` for `opengraph-image`.
 */

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#09090b",
        }}
      >
        <svg
          width="128"
          height="128"
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
      </div>
    ),
    { ...size },
  );
}
