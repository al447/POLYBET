import { describe, expect, it } from "vitest";

import {
  ACCEPTED_AT_KEY,
  ACCEPTED_VERSION_KEY,
  needsAcceptance,
  readAcceptance,
  userNeedsAcceptance,
} from "./acceptance";

const CURRENT = "2026-08-15";

describe("readAcceptance", () => {
  it("reads the version and timestamp out of the metadata bag", () => {
    const state = readAcceptance(
      { [ACCEPTED_VERSION_KEY]: CURRENT, [ACCEPTED_AT_KEY]: "2026-08-15T10:00:00.000Z" },
      true,
    );

    expect(state).toEqual({
      hasAcceptedTerms: true,
      version: CURRENT,
      acceptedAt: "2026-08-15T10:00:00.000Z",
    });
  });

  it("reports no record when metadata is absent entirely", () => {
    const state = readAcceptance(undefined, false);

    expect(state.version).toBeNull();
    expect(state.acceptedAt).toBeNull();
    expect(state.hasAcceptedTerms).toBe(false);
  });

  it("reports no record for an empty bag", () => {
    expect(readAcceptance({}, true).version).toBeNull();
  });

  it("treats non-string values as no record rather than coercing them", () => {
    // CustomMetadata permits numbers and booleans in every slot. Coercing one
    // into a version string would compare unequal forever and trap the user in
    // a prompt loop with nothing to diagnose.
    expect(readAcceptance({ [ACCEPTED_VERSION_KEY]: 20260815 }, true).version).toBeNull();
    expect(readAcceptance({ [ACCEPTED_VERSION_KEY]: true }, true).version).toBeNull();
  });

  it("treats an empty string as no record", () => {
    expect(readAcceptance({ [ACCEPTED_VERSION_KEY]: "" }, true).version).toBeNull();
  });

  it("passes Privy's flag through untouched", () => {
    expect(readAcceptance({}, true).hasAcceptedTerms).toBe(true);
    expect(readAcceptance({}, false).hasAcceptedTerms).toBe(false);
  });
});

describe("needsAcceptance", () => {
  it("lets through a user with both the flag and the current version", () => {
    const state = readAcceptance({ [ACCEPTED_VERSION_KEY]: CURRENT }, true);
    expect(needsAcceptance(state, CURRENT)).toBe(false);
  });

  it("prompts a user with no record at all", () => {
    expect(needsAcceptance(readAcceptance(undefined, false), CURRENT)).toBe(true);
  });

  it("prompts when Privy's flag is set but our version record is missing", () => {
    // The half-written state: `acceptTerms()` succeeded, our POST didn't. The
    // user must be asked again rather than let through on evidence we can't produce.
    expect(needsAcceptance(readAcceptance({}, true), CURRENT)).toBe(true);
  });

  it("prompts when our version is current but Privy's flag is not set", () => {
    const state = readAcceptance({ [ACCEPTED_VERSION_KEY]: CURRENT }, false);
    expect(needsAcceptance(state, CURRENT)).toBe(true);
  });

  it("re-prompts everyone when the version is bumped", () => {
    // The whole point of versioning: a stale acceptance is not an acceptance.
    const state = readAcceptance({ [ACCEPTED_VERSION_KEY]: "2026-01-01" }, true);
    expect(needsAcceptance(state, CURRENT)).toBe(true);
  });

  it("does not accept a newer stored version as satisfying an older current one", () => {
    // Exact match, not ordering — versions are opaque strings, not comparable dates.
    const state = readAcceptance({ [ACCEPTED_VERSION_KEY]: "2027-01-01" }, true);
    expect(needsAcceptance(state, CURRENT)).toBe(true);
  });
});

/**
 * Server-side gate.
 *
 * 🚩 Deliberately version-only. Privy's `hasAcceptedTerms` is hardcoded
 * `false` by `@privy-io/node`'s identity-token parser, so a server check that
 * consulted it rejected **every** order from **every** user, forever — no
 * matter how many times they accepted. These tests pin the shape that fixed
 * it: the accepted revision is the whole decision.
 */
describe("userNeedsAcceptance", () => {
  it("lets through a session carrying the current version", () => {
    expect(userNeedsAcceptance({ legalVersion: CURRENT }, CURRENT)).toBe(false);
  });

  it("prompts on a stale version", () => {
    // What makes bumping ACCEPTANCE_VERSION re-prompt the whole user base.
    expect(userNeedsAcceptance({ legalVersion: "2026-01-01" }, CURRENT)).toBe(true);
  });

  it("prompts when no version is recorded", () => {
    // Also the shape of a stale identity token: minted before the metadata
    // write, so the claim isn't there yet.
    expect(userNeedsAcceptance({ legalVersion: null }, CURRENT)).toBe(true);
  });

  it("compares exactly, never by ordering", () => {
    // Versions are opaque strings. A "newer" stored value does not satisfy an
    // older current one.
    expect(userNeedsAcceptance({ legalVersion: "2027-01-01" }, CURRENT)).toBe(true);
  });
});
