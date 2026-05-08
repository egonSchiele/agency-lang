import { describe, expect, it } from "vitest";
import { checkAuth } from "./auth.js";

describe("checkAuth", () => {
  it("allows all requests when no key configured", () => {
    expect(checkAuth(undefined, undefined)).toBe(true);
    expect(checkAuth(undefined, "Bearer anything")).toBe(true);
  });

  it("rejects when key configured but no header", () => {
    expect(checkAuth("secret", undefined)).toBe(false);
  });

  it("rejects wrong key", () => {
    expect(checkAuth("secret", "Bearer wrong")).toBe(false);
  });

  it("rejects wrong format", () => {
    expect(checkAuth("secret", "secret")).toBe(false);
    expect(checkAuth("secret", "Basic secret")).toBe(false);
    expect(checkAuth("secret", "Bearer a b")).toBe(false);
  });

  it("accepts correct key", () => {
    expect(checkAuth("secret", "Bearer secret")).toBe(true);
  });
});
