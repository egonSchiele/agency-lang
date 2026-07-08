import { describe, expect, test, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgencyFileCached, _internal } from "./parseCache.js";

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

  test("bypasses the cache entirely when tarsecTraceHost is set", () => {
    const file = writeTempAgencyFile(VALID_PROGRAM);
    const traced = parseAgencyFileCached(file, { tarsecTraceHost: true } as any);
    expect(traced.success).toBe(true);
    expect(_internal.stats.hits).toBe(0);
    expect(_internal.stats.misses).toBe(0);
    // The traced parse must not have stored an entry either.
    parseAgencyFileCached(file, {});
    expect(_internal.stats.hits).toBe(0);
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
});
