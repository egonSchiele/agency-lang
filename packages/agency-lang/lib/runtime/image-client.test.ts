import { describe, it, expect } from "vitest";
import { DeterministicClient } from "./deterministicClient.js";
import { DETERMINISTIC_IMAGE_COST } from "../constants.js";

// Note: SmoltalkClient.image's `{ model: DEFAULT_IMAGE_MODEL, ...config }` spread
// (default applied only when config sets no model) is trivial by construction and
// exercised for real by the image-generation e2e (tests/agency-js/image-generation).
// It isn't unit-tested here because smoltalk's `image` is a read-only ESM export
// that vitest cannot spy on without fragile whole-module mocking.

describe("DeterministicClient.image", () => {
  it("returns a decodable PNG with the fixed cost", async () => {
    const client = new DeterministicClient([]);
    const r = await client.image!("a red bike", { model: "test-image" });
    expect(r.success).toBe(true);
    if (r.success) {
      const img = r.value.images[0];
      expect(img.mimeType).toBe("image/png");
      // Real PNG signature — proves the base64 decodes to actual PNG bytes.
      expect(Array.from(img.data.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(r.value.costEstimate?.totalCost).toBe(DETERMINISTIC_IMAGE_COST);
    }
  });
});
