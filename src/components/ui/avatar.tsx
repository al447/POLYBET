import Image from "next/image";

/**
 * Trader avatar with a coloured letter fallback.
 *
 * The fallback is the **normal** case, not the edge case: `profileImage` is
 * empty on 47 of 50 leaderboard rows (measured 2026-08-17), so a grey circle
 * would make the whole board look broken. Colour is derived from the address,
 * so the same trader keeps the same swatch across every surface without
 * storing anything.
 *
 * Differs from the private grey-circle `Avatar` in `market-discussion-tabs.tsx`
 * for that reason — there, a missing image is rare and a neutral placeholder is
 * the right weight.
 */

/**
 * Fixed palette rather than a generated hue: hand-picked to stay legible
 * against black at the one text colour used on top of them, which
 * `hsl(hash, …)` does not guarantee.
 */
const SWATCHES = [
  "bg-orange-600",
  "bg-emerald-600",
  "bg-fuchsia-600",
  "bg-blue-600",
  "bg-amber-600",
  "bg-teal-600",
  "bg-rose-600",
  "bg-violet-600",
];

/**
 * Stable index from an address. Sums the char codes rather than parsing hex —
 * addresses are mixed-case and occasionally malformed, and this only needs to
 * be deterministic, not uniform.
 */
function swatchFor(seed: string): string {
  let total = 0;
  for (let i = 0; i < seed.length; i += 1) total += seed.charCodeAt(i);
  return SWATCHES[total % SWATCHES.length];
}

/** First character of the display name, or a fallback for names that start with punctuation. */
function initialFor(name: string): string {
  const char = name.trim().charAt(0);
  return char ? char.toUpperCase() : "?";
}

export function TraderAvatar({
  src,
  name,
  seed,
  size = 40,
}: {
  src?: string;
  /** Display name — supplies the letter. */
  name: string;
  /** Stable value picking the colour; the trader's address. */
  seed: string;
  size?: number;
}) {
  if (src) {
    return (
      <Image
        src={src}
        alt=""
        width={size}
        height={size}
        // Same reasoning as `MarketCard`: the image-transform pipeline is
        // untested on this Workers/OpenNext setup, and these are hundreds of
        // distinct avatars that gain little from resizing.
        unoptimized
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${swatchFor(seed)}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initialFor(name)}
    </div>
  );
}
