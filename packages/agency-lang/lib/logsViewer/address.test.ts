import { describe, expect, it } from "vitest";

import { formatAddress, isAddress, parseAddress } from "./address.js";

describe("addresses", () => {
  it("round-trips each row id shape", () => {
    for (const rowId of [
      "round:span-7f3a:2",
      "round:span-7f3a:2:user",
      "span-9c01",
      "leaf:span-9c01:interrupt:0",
    ]) {
      expect(parseAddress(formatAddress("k3Pq9abc", rowId))).toEqual({
        traceId: "k3Pq9abc",
        rowId,
      });
    }
  });

  it("splits on the last slash, so a trace id may contain slashes", () => {
    expect(parseAddress("hosted/run/42/round:s1:0")).toEqual({
      traceId: "hosted/run/42",
      rowId: "round:s1:0",
    });
  });

  it("rejects text with no slash or an empty half", () => {
    for (const text of ["round:s1:0", "/round:s1:0", "abc/"]) {
      const parsed = parseAddress(text);
      expect(isAddress(parsed)).toBe(false);
      if (!isAddress(parsed)) {
        expect(parsed.error).toContain("not an address");
      }
    }
  });
});
