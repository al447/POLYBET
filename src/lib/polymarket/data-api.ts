import { POLYMARKET_ENDPOINTS } from "./config";

/**
 * Browser-side reader for Data API **v2** — the user's own positions and
 * activity. Client-safe, NOT `server-only`.
 *
 * 🚩 Data API v1 was retired 2026-11-02 and every v1 route now answers 410.
 * `@polymarket/client@0.2.0` still calls v1 (v2 support starts at 0.10.0), so
 * the portfolio and activity reads bypass the SDK and come here instead. The
 * SDK is kept for trading; upgrading it is a separate task.
 *
 * v2 contract, verified live 2026-11-19 against
 * `data-api.polymarket.com/v2/openapi.json`:
 *
 *  - Every payload is `{ data, pagination: { has_more, next_cursor } }`.
 *  - Fields are snake_case.
 *  - Paging is by opaque cursor only; **`offset` is a 400, even `offset=0`**.
 *
 * Throws rather than returning an empty page, unlike `trader-feed.ts`. That
 * feed reads other people's trades, where "nothing new" is the safe reading of
 * a failure. Here it would tell a user they hold nothing.
 */

const REQUEST_TIMEOUT_MS = 8000;

export type DataApiPage = {
  rows: unknown[];
  /** `null` once the feed is exhausted. */
  nextCursor: string | null;
  hasMore: boolean;
};

export class DataApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DataApiError";
  }
}

export async function fetchDataApiPage(
  path: string,
  params: Record<string, string | undefined>,
): Promise<DataApiPage> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${POLYMARKET_ENDPOINTS.data}${path}?${query.toString()}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } catch {
    throw new DataApiError("Couldn't reach Polymarket. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new DataApiError(`Polymarket returned an error (${response.status}).`, response.status);
  }

  const body = (await response.json().catch(() => null)) as {
    data?: unknown;
    pagination?: { has_more?: unknown; next_cursor?: unknown };
  } | null;

  // A documented miss is `data: null`, which reads as an empty page.
  if (!body || !("data" in body)) {
    throw new DataApiError("Polymarket returned an unexpected response.");
  }

  const rows = Array.isArray(body.data) ? body.data : [];
  const nextCursor =
    typeof body.pagination?.next_cursor === "string" && body.pagination.next_cursor
      ? body.pagination.next_cursor
      : null;

  return { rows, nextCursor, hasMore: body.pagination?.has_more === true && nextCursor !== null };
}
