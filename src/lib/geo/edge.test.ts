import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveGeoStatus } from "./edge";

/**
 * Upstream payload parsing.
 *
 * These exist because of a real defect: the parser read `countryCode`/
 * `regionCode` while the live endpoint returns `country`/`region`. The country
 * silently resolved to `undefined`, every request fell through to the
 * fail-closed branch, and unrestricted users were shown "close-only" — a
 * failure mode that looks like correct conservative behaviour from the outside,
 * which is why it survived. The shape is asserted here so a rename upstream
 * fails loudly instead.
 */

const mockGeoblock = (body: unknown, ok = true) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })),
  );

const request = (headers: Record<string, string> = {}) =>
  new Request("https://example.test/", { headers });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveGeoStatus", () => {
  it("reads the live `country`/`region` field names", async () => {
    mockGeoblock({ blocked: false, ip: "118.179.95.17", country: "BD", region: "C" });

    const status = await resolveGeoStatus(request());

    expect(status.countryCode).toBe("BD");
    expect(status.regionCode).toBe("C");
    expect(status.tier).toBe("allowed");
    expect(status.degraded).toBe(false);
  });

  it("still accepts the `countryCode`/`regionCode` spelling", async () => {
    mockGeoblock({ blocked: false, countryCode: "BD", regionCode: "C" });

    const status = await resolveGeoStatus(request());

    expect(status.countryCode).toBe("BD");
    expect(status.tier).toBe("allowed");
  });

  it("honours upstream `blocked` even for an otherwise unrestricted country", async () => {
    mockGeoblock({ blocked: true, country: "BD" });

    expect((await resolveGeoStatus(request())).tier).toBe("close-only");
  });

  it("applies our own list to an upstream-supplied country", async () => {
    mockGeoblock({ blocked: false, country: "US" });

    expect((await resolveGeoStatus(request())).tier).toBe("close-only");
  });

  it("keeps OFAC blocks above upstream's opinion", async () => {
    mockGeoblock({ blocked: false, country: "IR" });

    expect((await resolveGeoStatus(request())).tier).toBe("blocked");
  });

  it("falls back to cf-ipcountry when upstream is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));

    const status = await resolveGeoStatus(request({ "cf-ipcountry": "BD" }));

    expect(status.countryCode).toBe("BD");
    expect(status.tier).toBe("allowed");
    expect(status.degraded).toBe(true);
  });

  it("fails closed and reports degraded when no country can be determined", async () => {
    mockGeoblock({ blocked: false, ip: "1.2.3.4" });

    const status = await resolveGeoStatus(request());

    expect(status.countryCode).toBeNull();
    expect(status.tier).toBe("close-only");
    expect(status.degraded).toBe(true);
  });
});
