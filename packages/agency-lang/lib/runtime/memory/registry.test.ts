import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOrCreateStore, _resetStoreRegistry } from "./registry.js";
import { FileMemoryStore } from "./store.js";

describe("memory registry", () => {
  let tmpRoot: string;

  beforeEach(() => {
    _resetStoreRegistry();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memreg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    _resetStoreRegistry();
  });

  it("returns the same instance for the same absDir", () => {
    const a = getOrCreateStore(tmpRoot);
    const b = getOrCreateStore(tmpRoot);
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(FileMemoryStore);
  });

  it("returns different stores for different absDirs", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "memreg-other-"));
    try {
      const a = getOrCreateStore(tmpRoot);
      const b = getOrCreateStore(otherDir);
      expect(a).not.toBe(b);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("two execCtxs in the same process see the same underlying store", () => {
    // Simulates two execCtxs both calling getOrCreateStore with the
    // same absDir; the resulting stores must be reference-equal so
    // writes from one are visible to the other without disk reload.
    const execCtxAStore = getOrCreateStore(tmpRoot);
    const execCtxBStore = getOrCreateStore(tmpRoot);
    expect(execCtxAStore).toBe(execCtxBStore);
  });
});
