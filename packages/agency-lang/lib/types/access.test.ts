import { describe, expect, it } from "vitest";
import { chainPieces, type AccessChainElement } from "./access.js";

const unwrap: AccessChainElement = { kind: "unwrap" };
const b: AccessChainElement = { kind: "property", name: "b" };
const c: AccessChainElement = { kind: "property", name: "c" };

describe("chainPieces", () => {
  it("splits a chain at every unwrap", () => {
    expect(chainPieces([unwrap, b, unwrap, c])).toEqual({ pieces: [[], [b]], trailing: [c] });
  });

  it("a chain with no unwrap is all trailing", () => {
    expect(chainPieces([b, c])).toEqual({ pieces: [], trailing: [b, c] });
  });

  it("a chain that ends in an unwrap has no trailing piece", () => {
    expect(chainPieces([b, unwrap])).toEqual({ pieces: [[b]], trailing: [] });
  });
});
