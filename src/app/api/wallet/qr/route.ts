import { NextResponse } from "next/server";

import { getAuthProvider, requireUser, UnauthorizedError } from "@/lib/auth/session";
import { createUserClient, readWalletStatus } from "@/lib/polymarket/clob";
import { serverEnv } from "@/lib/env";

/**
 * Deposit address QR (FR-1.4).
 *
 * Takes no address parameter on purpose. Rendering an arbitrary caller-supplied
 * string would make this a generic QR generator on the platform's own domain —
 * an easy way to lend the client's brand to someone else's payment address. The
 * address is resolved server-side from the session instead.
 *
 * Encodes the bare address rather than an EIP-681 URI: wallet apps parse a
 * plain address universally, and a malformed token-transfer URI silently sends
 * a user to the wrong asset.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const provider = await getAuthProvider();
    if (!provider) {
      return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
    }

    const env = await serverEnv();
    const signer = await provider.createSigner(user);
    const ctx = await createUserClient({ env, signer });
    const { address } = await readWalletStatus(ctx);

    if (!address) {
      return NextResponse.json({ error: "no_address" }, { status: 404 });
    }

    const { toString } = await import("qrcode");
    const svg = await toString(address, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#f4f4f5", light: "#00000000" },
    });

    return new NextResponse(svg, {
      headers: {
        "content-type": "image/svg+xml",
        // Per-user content; must never land in a shared cache.
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "qr_failed" }, { status: 502 });
  }
}
