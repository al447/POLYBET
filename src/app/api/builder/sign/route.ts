import { buildHmacSignature } from "@polymarket/client";
import { NextResponse } from "next/server";

import { requireUser, UnauthorizedError } from "@/lib/auth/session";
import { MissingBuilderCredentialsError, resolveBuilderAuth } from "@/lib/polymarket/builder";
import { serverEnv } from "@/lib/env";

/**
 * Remote builder signing (SEC-1).
 *
 * The architecture signs orders in the *browser* with the user's own Privy
 * wallet — no delegation, no server-held signing authority. But Relayer
 * operations still need builder authorization, and the builder secret must
 * never reach the client.
 *
 * This is the SDK's sanctioned split. `remoteBuilderSigning({ url })` makes the
 * browser client call here whenever it needs builder auth; we compute the HMAC
 * server-side and return only the result. The **secret never leaves the
 * server** — without it a signature cannot be forged.
 *
 * ⚠️ Residual exposure, accepted deliberately: the contract requires returning
 * the API key and passphrase so the client can set its headers. Any signed-in
 * user can therefore read them. They are useless for forging new requests
 * (that needs the secret), but they do identify our builder account. Mitigations
 * here: authentication is mandatory, and each call is one signature for one
 * request path. If these are ever abused, rotate P-2..P-4 with
 * `npm run builder:provision -- derive-keys`.
 *
 * The wire contract (request `{body, method, path}` → the four `POLY_BUILDER_*`
 * fields) is fixed by the SDK, not by us. See `buildHmacSignature`'s docstring.
 */
export async function POST(request: Request) {
  try {
    // Never anonymous: every signature spends our builder reputation and,
    // downstream, our relay quota.
    await requireUser();

    const env = await serverEnv();
    const auth = resolveBuilderAuth(env);

    const payload = (await request.json()) as {
      body?: unknown;
      method?: unknown;
      path?: unknown;
    };

    const method = typeof payload.method === "string" ? payload.method : null;
    const path = typeof payload.path === "string" ? payload.path : null;
    // `body` is the already-serialized request body, or absent for GETs.
    const body = typeof payload.body === "string" ? payload.body : undefined;

    if (!method || !path) {
      return NextResponse.json(
        { error: "invalid_request", message: "`method` and `path` are required." },
        { status: 400 },
      );
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await buildHmacSignature(
      auth.secret,
      timestamp,
      method,
      path,
      body,
    );

    return NextResponse.json(
      {
        POLY_BUILDER_API_KEY: auth.key,
        POLY_BUILDER_PASSPHRASE: auth.passphrase,
        POLY_BUILDER_SIGNATURE: signature,
        POLY_BUILDER_TIMESTAMP: `${timestamp}`,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (error instanceof MissingBuilderCredentialsError) {
      return NextResponse.json(
        { error: "builder_not_configured", message: error.message },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "signing_failed" }, { status: 500 });
  }
}
