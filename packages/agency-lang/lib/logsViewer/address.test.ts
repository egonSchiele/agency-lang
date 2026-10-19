import { describe, expect, it } from "vitest";

import { formatAddress, splitAddress } from "./address.js";

describe("addresses", () => {
  const traceIds = ["k3Pq9abc", "hosted/run/42", "k3Pq"];

  it("round-trips each row id shape against the log's trace ids", () => {
    for (const rowId of [
      "round:span-7f3a:2",
      "round:span-7f3a:2:user",
      "span-9c01",
      "leaf:span-9c01:interrupt:0",
    ]) {
      expect(splitAddress(formatAddress("k3Pq9abc", rowId), traceIds)).toEqual({
        traceId: "k3Pq9abc",
        rowId,
      });
    }
  });

  it("takes the longest trace id that starts the text, so a trace id may contain slashes", () => {
    expect(splitAddress("hosted/run/42/round:s1:0", traceIds)).toEqual({
      traceId: "hosted/run/42",
      rowId: "round:s1:0",
    });
    expect(splitAddress("k3Pq9abc/round:s1:0", traceIds)).toEqual({
      traceId: "k3Pq9abc",
      rowId: "round:s1:0",
    });
  });

  it("keeps a row id that embeds the trace id, as a leaf under the trace root does", () => {
    const rowId = "leaf:trace-hosted/run/42:error:0";
    expect(splitAddress(formatAddress("hosted/run/42", rowId), traceIds)).toEqual({
      traceId: "hosted/run/42",
      rowId,
    });
    // Pasted without its trace, the same row id is not an address.
    expect(splitAddress(rowId, traceIds)).toBeUndefined();
  });

  it("is undefined for a bare row id, an unknown trace, or an empty row", () => {
    expect(splitAddress("round:s1:0", traceIds)).toBeUndefined();
    expect(splitAddress("zzz/round:s1:0", traceIds)).toBeUndefined();
    expect(splitAddress("k3Pq9abc/", traceIds)).toBeUndefined();
  });
});
