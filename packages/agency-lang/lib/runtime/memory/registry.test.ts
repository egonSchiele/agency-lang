import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOrCreateStore, _resetStoreRegistry } from "./registry.js";
import { FileMemoryStore } from "./store.js";
import { nodeHost } from "../../host/node/nodeHost.js";

const files = nodeHost().files;

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
    const a = getOrCreateStore(files, tmpRoot);
    const b = getOrCreateStore(files, tmpRoot);
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(FileMemoryStore);
  });

  it("returns different stores for different absDirs", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "memreg-other-"));
    try {
      const a = getOrCreateStore(files, tmpRoot);
      const b = getOrCreateStore(files, otherDir);
      expect(a).not.toBe(b);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("two hosts over the same directory get their own stores", () => {
    const other = nodeHost().files;
    expect(getOrCreateStore(files, tmpRoot)).not.toBe(getOrCreateStore(other, tmpRoot));
    expect(getOrCreateStore(other, tmpRoot)).toBe(getOrCreateStore(other, tmpRoot));
  });

  it("two execCtxs in the same process see the same underlying store", () => {
    // Simulates two execCtxs both calling getOrCreateStore with the
    // same absDir; the resulting stores must be reference-equal so
    // writes from one are visible to the other without disk reload.
    const execCtxAStore = getOrCreateStore(files, tmpRoot);
    const execCtxBStore = getOrCreateStore(files, tmpRoot);
    expect(execCtxAStore).toBe(execCtxBStore);
  });
});
