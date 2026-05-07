import { describe, it, expect } from "vitest";
import { checkAllowBlockList } from "./allowBlockList.js";

describe("checkAllowBlockList", () => {
  it("passes when no lists are set", () => {
    const result = checkAllowBlockList(["alice@example.com"], [], []);
    expect(result).toBeNull();
  });

  it("passes when recipient is in allowList", () => {
    const result = checkAllowBlockList(
      ["alice@example.com"],
      ["alice@example.com"],
      [],
    );
    expect(result).toBeNull();
  });

  it("fails when recipient is not in allowList", () => {
    const result = checkAllowBlockList(
      ["bob@example.com"],
      ["alice@example.com"],
      [],
    );
    expect(result).toContain("bob@example.com");
    expect(result).toContain("not in the allowList");
  });

  it("fails when recipient is in blockList", () => {
    const result = checkAllowBlockList(
      ["alice@example.com"],
      [],
      ["alice@example.com"],
    );
    expect(result).toContain("alice@example.com");
    expect(result).toContain("blockList");
  });

  it("checks all recipients (to, cc, bcc)", () => {
    const result = checkAllowBlockList(
      ["alice@example.com", "eve@example.com"],
      ["alice@example.com"],
      [],
    );
    expect(result).toContain("eve@example.com");
  });

  it("blockList checked before allowList", () => {
    const result = checkAllowBlockList(
      ["alice@example.com"],
      ["alice@example.com"],
      ["alice@example.com"],
    );
    expect(result).toContain("blockList");
  });

  it("passes with empty recipients array", () => {
    const result = checkAllowBlockList([], ["alice@example.com"], []);
    expect(result).toBeNull();
  });

  it("skips whitespace-only recipients", () => {
    const result = checkAllowBlockList(
      ["  "],
      ["alice@example.com"],
      [],
    );
    expect(result).toBeNull();
  });

  it("passes when recipient is not in blockList", () => {
    const result = checkAllowBlockList(
      ["bob@example.com"],
      [],
      ["alice@example.com"],
    );
    expect(result).toBeNull();
  });

  it("is case-insensitive", () => {
    const result = checkAllowBlockList(
      ["Alice@Example.COM"],
      ["alice@example.com"],
      [],
    );
    expect(result).toBeNull();
  });
});
