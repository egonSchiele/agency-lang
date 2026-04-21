import { describe, it, expect } from "vitest";
import { _openUrl } from "../system.js";
import { detectPlatform } from "../utils.js";

describe("_openUrl", () => {
  it("should be an async function that returns a promise", () => {
    expect(typeof _openUrl).toBe("function");
    // Calling with empty string returns a promise (don't await — avoid side effects)
    const result = _openUrl("").catch(() => {});
    expect(result).toBeInstanceOf(Promise);
  });

  it("should reject with a nonexistent scheme on macOS (verifies open is called)", async () => {
    if (detectPlatform() !== "macos") return;

    // A completely bogus scheme that macOS `open` can't handle
    await expect(_openUrl("x-agency-nonexistent://test")).rejects.toThrow();
  });

  it("should throw on unsupported platforms", async () => {
    if (detectPlatform() === "macos") return;

    await expect(_openUrl("https://example.com")).rejects.toThrow(
      /currently only supported on macOS/,
    );
  });
});
