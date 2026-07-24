import { describe, expect, it } from "vitest";
import { DocumentStateCache } from "./documentStateCache.js";
import type { DocumentState } from "./documentState.js";

/** A stand-in state — the cache stores states without inspecting them. */
function stateAtVersion(version: number): DocumentState {
  return { version } as DocumentState;
}

const URI = "file:///test.agency";

describe("DocumentStateCache", () => {
  it("serves the state that was set", () => {
    const cache = new DocumentStateCache();
    cache.set(URI, stateAtVersion(1));
    expect(cache.get(URI)?.version).toBe(1);
    expect(cache.getLastGood(URI)?.version).toBe(1);
  });

  it("keeps the last good state when a parse fails", () => {
    // The whole reason this class exists. A half-typed line produces no
    // state, and highlighting that returned nothing here would blank
    // every colour in the file on almost every keystroke.
    const cache = new DocumentStateCache();
    cache.set(URI, stateAtVersion(1));
    cache.clearCurrent(URI);

    expect(cache.get(URI)).toBeUndefined();
    expect(cache.getLastGood(URI)?.version).toBe(1);
  });

  it("serves a stale last-good state rather than nothing", () => {
    // After a failure the buffer keeps moving. The retained state is
    // then older than the document, and that is the intended trade:
    // colours lagging by a debounce are invisible, colours vanishing
    // are not. The version field is what lets a caller tell.
    const cache = new DocumentStateCache();
    cache.set(URI, stateAtVersion(4));
    cache.clearCurrent(URI);

    const served = cache.getLastGood(URI);
    expect(served).toBeDefined();
    expect(served!.version).toBe(4);
  });

  it("advances the last good state on each success", () => {
    const cache = new DocumentStateCache();
    cache.set(URI, stateAtVersion(1));
    cache.set(URI, stateAtVersion(2));
    expect(cache.getLastGood(URI)?.version).toBe(2);
  });

  it("forgets everything when the document closes", () => {
    // Retention is a feature while a document is open and a leak after
    // it is closed.
    const cache = new DocumentStateCache();
    cache.set(URI, stateAtVersion(1));
    cache.remove(URI);

    expect(cache.get(URI)).toBeUndefined();
    expect(cache.getLastGood(URI)).toBeUndefined();
  });

  it("keeps documents separate", () => {
    const cache = new DocumentStateCache();
    const other = "file:///other.agency";
    cache.set(URI, stateAtVersion(1));
    cache.set(other, stateAtVersion(2));
    cache.clearCurrent(URI);

    expect(cache.get(other)?.version).toBe(2);
    expect(cache.get(URI)).toBeUndefined();
  });

  it("offers a current state for document-independent requests", () => {
    const cache = new DocumentStateCache();
    expect(cache.anyCurrent()).toBeUndefined();
    cache.set(URI, stateAtVersion(1));
    expect(cache.anyCurrent()?.version).toBe(1);
  });
});
