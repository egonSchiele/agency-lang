import { describe, it, expect } from "vitest";
import { checkRecipients } from "./messaging.js";

describe("checkRecipients", () => {
  it("passes when no lists are set", () => {
    const result = checkRecipients(["alice@example.com"], [], []);
    expect(result).toBeNull();
  });

  it("passes when recipient is in allowList", () => {
    const result = checkRecipients(
      ["alice@example.com"],
      ["alice@example.com"],
      [],
    );
    expect(result).toBeNull();
  });

  it("fails when recipient is not in allowList", () => {
    const result = checkRecipients(
      ["bob@example.com"],
      ["alice@example.com"],
      [],
    );
    expect(result).toContain("bob@example.com");
    expect(result).toContain("not in the allowList");
  });

  it("fails when recipient is in blockList", () => {
    const result = checkRecipients(
      ["alice@example.com"],
      [],
      ["alice@example.com"],
    );
    expect(result).toContain("alice@example.com");
    expect(result).toContain("blockList");
  });

  it("checks all recipients (to, cc, bcc)", () => {
    const result = checkRecipients(
      ["alice@example.com", "eve@example.com"],
      ["alice@example.com"],
      [],
    );
    expect(result).toContain("eve@example.com");
  });

  it("blockList checked before allowList", () => {
    const result = checkRecipients(
      ["alice@example.com"],
      ["alice@example.com"],
      ["alice@example.com"],
    );
    expect(result).toContain("blockList");
  });

  it("is case-insensitive", () => {
    const result = checkRecipients(
      ["Alice@Example.COM"],
      ["alice@example.com"],
      [],
    );
    expect(result).toBeNull();
  });
});
