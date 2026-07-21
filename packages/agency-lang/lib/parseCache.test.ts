import { describe, expect, test, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgencyFileCached, evictParseCache, _internal } from "./parseCache.js";

function writeTempAgencyFile(contents: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-parsecache-"));
  const tmpFile = path.join(tmpDir, "main.agency");
  fs.writeFileSync(tmpFile, contents);
  return tmpFile;
}

const VALID_PROGRAM = 'node main() {\n  return "hello"\n}\n';
const VALID_PROGRAM_B = 'node main() {\n  return "world"\n}\n';

describe("parseAgencyFileCached", () => {
  beforeEach(() => {
    _internal.clear();
  });

  test("parses a file and returns the program", () => {
    const file = writeTempAgencyFile(VALID_PROGRAM);
    const result = parseAgencyFileCached(file, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.nodes.length).toBeGreaterThan(0);
    }
  });

  test("second parse of an unchanged file is a cache hit", () => {
    const file = writeTempAgencyFile(VALID_PROGRAM);
    parseAgencyFileCached(file, {});
    const before = { ..._internal.stats };
    const second = parseAgencyFileCached(file, {});
    expect(second.success).toBe(true);
    expect(_internal.stats.hits).toBe(before.hits + 1);
    expect(_internal.stats.misses).toBe(before.misses);
  });

  test("mutating a returned program does not affect subsequent reads", () => {
    const file = writeTempAgencyFile(VALID_PROGRAM);
    const first = parseAgencyFileCached(file, {});
    expect(first.success).toBe(true);
    if (first.success) {
      first.result.nodes.length = 0;
      (first.result as any).poisoned = true;
    }
    const second = parseAgencyFileCached(file, {});
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.result.nodes.length).toBeGreaterThan(0);
      expect((second.result as any).poisoned).toBeUndefined();
    }
  });

  test("changed content (different size) invalidates the entry", () => {
    const file = writeTempAgencyFile(VALID_PROGRAM);
    parseAgencyFileCached(file, {});
    fs.writeFileSync(file, 'node main() {\n  return "hello again, longer"\n}\n');
    const result = parseAgencyFileCached(file, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(JSON.stringify(result.result)).toContain("hello again, longer");
    }
    expect(_internal.stats.hits).toBe(0);
  });

  test("same-size content change with a newer mtime invalidates the entry", () => {
    // VALID_PROGRAM and VALID_PROGRAM_B are the same byte length, so only
    // mtimeMs distinguishes the versions.
    expect(VALID_PROGRAM.length).toBe(VALID_PROGRAM_B.length);
    const file = writeTempAgencyFile(VALID_PROGRAM);
    parseAgencyFileCached(file, {});
    fs.writeFileSync(file, VALID_PROGRAM_B);
    // Force an mtime strictly newer than the first write, in case the
    // filesystem's timestamp granularity is coarse.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    const result = parseAgencyFileCached(file, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(JSON.stringify(result.result)).toContain("world");
    }
    expect(_internal.stats.hits).toBe(0);
  });

  test("applyTemplate is part of the cache key", () => {
    const file = writeTempAgencyFile(VALID_PROGRAM);
    const templated = parseAgencyFileCached(file, {}, true);
    const raw = parseAgencyFileCached(file, {}, false);
    expect(templated.success).toBe(true);
    expect(raw.success).toBe(true);
    // Distinct keys: the second call must not have hit the first's entry.
    expect(_internal.stats.hits).toBe(0);
    expect(_internal.stats.misses).toBe(2);
  });

  test("a stale tarsecTraceHost key no longer bypasses the cache", () => {
    const file = writeTempAgencyFile(VALID_PROGRAM);
    parseAgencyFileCached(file, { tarsecTraceHost: "http://x" } as any);
    parseAgencyFileCached(file, { tarsecTraceHost: "http://x" } as any);
    // Old code: bypass → hits 0, misses 0 (nothing stored). New code: caches.
    expect(_internal.stats.hits).toBe(1);
    expect(_internal.stats.misses).toBe(1);
  });

  test("failed parses are not cached", () => {
    const file = writeTempAgencyFile("node main( {{{ nope");
    const first = parseAgencyFileCached(file, {});
    expect(first.success).toBe(false);
    const second = parseAgencyFileCached(file, {});
    expect(second.success).toBe(false);
    expect(_internal.stats.hits).toBe(0);
    expect(_internal.stats.misses).toBe(2);
  });

  test("missing file returns a failure instead of throwing", () => {
    const result = parseAgencyFileCached("/nonexistent/nope.agency", {});
    expect(result.success).toBe(false);
  });

  test("evictParseCache forces a re-parse even when mtime and size match", () => {
    // Guards the long-lived-process blind spot: same-size + same-mtime edits
    // would otherwise serve a stale AST. Explicit eviction must re-parse. Both
    // variants are pinned so it clears the templated and raw keys.
    const file = writeTempAgencyFile(VALID_PROGRAM);
    parseAgencyFileCached(file, {}, true);
    parseAgencyFileCached(file, {}, false);
    const before = { ..._internal.stats };

    // Change content but restore the original mtime+size so the cache's own
    // validity check would consider the entry valid.
    const stat = fs.statSync(file);
    fs.writeFileSync(file, VALID_PROGRAM_B);
    fs.utimesSync(file, stat.atime, stat.mtime);

    evictParseCache(file);

    const templated = parseAgencyFileCached(file, {}, true);
    const raw = parseAgencyFileCached(file, {}, false);
    expect(templated.success).toBe(true);
    expect(raw.success).toBe(true);
    if (templated.success) {
      expect(JSON.stringify(templated.result)).toContain("world");
    }
    // Both reads missed (re-parsed) rather than hitting the stale entries.
    expect(_internal.stats.hits).toBe(before.hits);
    expect(_internal.stats.misses).toBe(before.misses + 2);
  });
});
