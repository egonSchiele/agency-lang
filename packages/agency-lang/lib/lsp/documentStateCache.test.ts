import { describe, expect, it } from "vitest";
import { DocumentStateCache } from "./documentStateCache.js";
import type { DocumentState } from "./documentState.js";

/**
 * A stand-in state. The cache stores states without inspecting them, so
 * what matters is only that two of them are distinguishable — hence
 * assertions on identity rather than on any field.
 */
function aState(): DocumentState {
  return {} as DocumentState;
}

const URI = "file:///test.agency";

describe("DocumentStateCache", () => {
  it("serves the state that was set", () => {
    const cache = new DocumentStateCache();
    const state = aState();
    cache.set(URI, state);
    expect(cache.get(URI)).toBe(state);
    expect(cache.getLastGood(URI)).toBe(state);
  });

  it("keeps the last good state when a parse fails", () => {
    // The whole reason this class exists. A half-typed line produces no
    // state, and highlighting that returned nothing here would blank
    // every color in the file on almost every keystroke.
    const cache = new DocumentStateCache();
    const good = aState();
    cache.set(URI, good);
    cache.clearCurrent(URI);

    expect(cache.get(URI)).toBeUndefined();
    expect(cache.getLastGood(URI)).toBe(good);
  });

  it("keeps serving the last good state across repeated failures", () => {
    // The buffer keeps moving while it does not parse. The retained
    // state gets older, and that is the intended trade: colors lagging
    // are invisible, colors vanishing are not. Positions from a state
    // this old are bounds-checked by getSemanticTokens, not here.
    const cache = new DocumentStateCache();
    const good = aState();
    cache.set(URI, good);
    for (let i = 0; i < 3; i++) cache.clearCurrent(URI);

    expect(cache.getLastGood(URI)).toBe(good);
  });

  it("advances the last good state on each success", () => {
    const cache = new DocumentStateCache();
    const older = aState();
    const newer = aState();
    cache.set(URI, older);
    cache.set(URI, newer);
    expect(cache.getLastGood(URI)).toBe(newer);
  });

  it("forgets everything when the document closes", () => {
    // Retention is a feature while a document is open and a leak after
    // it is closed.
    const cache = new DocumentStateCache();
    cache.set(URI, aState());
    cache.remove(URI);

    expect(cache.get(URI)).toBeUndefined();
    expect(cache.getLastGood(URI)).toBeUndefined();
  });

  it("keeps documents separate", () => {
    const cache = new DocumentStateCache();
    const other = "file:///other.agency";
    const otherState = aState();
    cache.set(URI, aState());
    cache.set(other, otherState);
    cache.clearCurrent(URI);

    expect(cache.get(other)).toBe(otherState);
    expect(cache.get(URI)).toBeUndefined();
  });

  it("reports a miss for names that live on Object.prototype", () => {
    // URIs come from the client, so the key space is not ours to
    // constrain. On a plain object these would resolve off the
    // prototype chain and hand back a function where a caller expects
    // either a state or nothing.
    const cache = new DocumentStateCache();
    for (const key of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
      expect(cache.get(key)).toBeUndefined();
      expect(cache.getLastGood(key)).toBeUndefined();
    }
  });

  it("stores and retrieves a prototype-shaped key like any other", () => {
    const cache = new DocumentStateCache();
    const state = aState();
    cache.set("toString", state);
    expect(cache.get("toString")).toBe(state);
    expect(cache.get("valueOf")).toBeUndefined();
  });

  it("offers a current state for document-independent requests", () => {
    const cache = new DocumentStateCache();
    expect(cache.anyCurrent()).toBeUndefined();
    const state = aState();
    cache.set(URI, state);
    expect(cache.anyCurrent()).toBe(state);
  });
});
