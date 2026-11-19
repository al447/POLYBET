import { beforeEach, describe, expect, it, vi } from "vitest";

const BUILDER_CODE = `0x${"ab".repeat(32)}`;

class UnauthorizedError extends Error {}
const requireUser = vi.fn<() => Promise<unknown>>();

vi.mock("@/lib/auth/session", () => ({
  UnauthorizedError,
  requireUser: () => requireUser(),
}));

vi.mock("@/lib/env", () => ({
  serverEnv: async () => ({
    POLYMARKET_BUILDER_CODE: BUILDER_CODE,
    POLYMARKET_BUILDER_API_KEY: "test-key",
    POLYMARKET_BUILDER_SECRET: "c2VjcmV0LXNlY3JldC1zZWNyZXQ=",
    POLYMARKET_BUILDER_PASSPHRASE: "test-passphrase",
  }),
}));

const { POST } = await import("./route");

const sign = (method: string, path: string, body?: string) =>
  POST(
    new Request("https://example.test/api/builder/sign", {
      method: "POST",
      body: JSON.stringify({ method, path, body }),
    }),
  );

beforeEach(() => {
  requireUser.mockReset();
  requireUser.mockResolvedValue({ id: "user-1" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("allowed paths", () => {
  it.each([
    ["POST", "/order", '{"order":{}}'],
    ["DELETE", "/order", '{"orderID":"0x1"}'],
    ["GET", "/auth/api-keys", undefined],
    ["POST", "/submit", "{}"],
    ["GET", "/v1/account/transactions/0193a7f2-tx_1", undefined],
    ["GET", "/markets-by-token/71321045679252212594626385532706912750332728571942532289631379312455583992563", undefined],
    ["GET", `/clob-markets/0x${"1f".repeat(32)}`, undefined],
    ["GET", "tick-size", undefined],
  ])("signs %s %s", async (method, path, body) => {
    const response = await sign(method, path, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      POLY_BUILDER_API_KEY: "test-key",
      POLY_BUILDER_SIGNATURE: expect.any(String),
    });
  });

  it("signs the builder-fees lookup only for our own code, in any case", async () => {
    expect((await sign("GET", `/fees/builder-fees/0x${"AB".repeat(32)}`)).status).toBe(200);
    expect((await sign("GET", `/fees/builder-fees/0x${"cd".repeat(32)}`)).status).toBe(403);
  });
});

describe("rejected paths", () => {
  it.each([
    ["DELETE", "/auth/builder-api-key"],
    ["GET", "/auth/builder-api-key"],
    ["POST", "/auth/builder-api-key"],
    ["GET", "/builder/trades"],
    ["DELETE", "/auth/api-key"],
    ["DELETE", "/cancel-all"],
    ["POST", "/v1/collateral-return/submit"],
  ])("refuses %s %s", async (method, path) => {
    const response = await sign(method, path);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "path_not_allowed" });
  });

  it.each([
    ["GET", "/order"],
    ["PATCH", "/order"],
    ["post", "/order"],
    ["POST", "/deployed"],
  ])("refuses an allowed path under the wrong method: %s %s", async (method, path) => {
    expect((await sign(method, path)).status).toBe(403);
  });

  it.each([
    "/order?x=1",
    "/order#frag",
    "/data/../auth/builder-api-key",
    "/order/",
    "//order",
    "/markets-by-token/0x12",
    "/clob-markets/0x1234",
    "/v1/account/transactions/a%2Fb",
    "/fees/builder-fees/",
  ])("refuses a malformed or smuggled path: %s", async (path) => {
    expect((await sign("GET", path)).status).toBe(403);
  });

  it("logs the rejection without the body", async () => {
    await sign("DELETE", "/auth/builder-api-key", '{"secret":"do-not-log"}');

    expect(console.warn).toHaveBeenCalledWith("builder/sign rejected", {
      method: "DELETE",
      path: "/auth/builder-api-key",
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("do-not-log");
  });
});

describe("request guards", () => {
  it("returns 401 for an anonymous caller before looking at the path", async () => {
    requireUser.mockRejectedValue(new UnauthorizedError());

    const response = await sign("POST", "/order");

    expect(response.status).toBe(401);
  });

  it("returns 400 when method or path is missing", async () => {
    const response = await POST(
      new Request("https://example.test/api/builder/sign", {
        method: "POST",
        body: JSON.stringify({ path: "/order" }),
      }),
    );

    expect(response.status).toBe(400);
  });
});
