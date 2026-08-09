import { describe, expect, it } from "vitest";

import { validateWithdrawal } from "./withdraw";
import { toBaseUnits } from "./fees";

const VALID_RECIPIENT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BALANCE = toBaseUnits("100");

describe("validateWithdrawal", () => {
  it("accepts a well-formed withdrawal and returns base units", () => {
    const result = validateWithdrawal({
      amount: "10",
      recipient: VALID_RECIPIENT,
      balance: BALANCE,
    });
    expect(result).toEqual({ ok: true, amountBaseUnit: toBaseUnits("10") });
  });

  it("rejects a malformed amount", () => {
    const result = validateWithdrawal({
      amount: "abc",
      recipient: VALID_RECIPIENT,
      balance: BALANCE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/valid amount/i);
  });

  it("rejects zero", () => {
    const result = validateWithdrawal({
      amount: "0",
      recipient: VALID_RECIPIENT,
      balance: BALANCE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/greater than zero/i);
  });

  it("rejects a malformed recipient address", () => {
    const result = validateWithdrawal({
      amount: "10",
      recipient: "0xnope",
      balance: BALANCE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/valid polygon wallet address/i);
  });

  it("rejects an ENS name — the bridge takes raw addresses only", () => {
    const result = validateWithdrawal({
      amount: "10",
      recipient: "vitalik.eth",
      balance: BALANCE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/valid polygon wallet address/i);
  });

  it("rejects an amount below the bridge minimum", () => {
    const result = validateWithdrawal({
      amount: "1",
      recipient: VALID_RECIPIENT,
      balance: BALANCE,
      minUsd: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/minimum withdrawal is \$2/i);
  });

  it("accepts an amount exactly at the minimum", () => {
    const result = validateWithdrawal({
      amount: "2",
      recipient: VALID_RECIPIENT,
      balance: BALANCE,
      minUsd: 2,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an amount above the available balance", () => {
    const result = validateWithdrawal({
      amount: "150",
      recipient: VALID_RECIPIENT,
      balance: BALANCE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exceeds your available balance/i);
  });

  it("accepts withdrawing the exact full balance", () => {
    const result = validateWithdrawal({
      amount: "100",
      recipient: VALID_RECIPIENT,
      balance: BALANCE,
    });
    expect(result).toEqual({ ok: true, amountBaseUnit: BALANCE });
  });

  it("reports the amount problem before the address problem", () => {
    // Both are wrong; the user should be told about the more fundamental one
    // rather than fixing an address only to then hit an amount error.
    const result = validateWithdrawal({ amount: "", recipient: "nope", balance: BALANCE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/valid amount/i);
  });
});
