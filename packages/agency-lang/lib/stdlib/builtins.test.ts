import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { format } from "node:util";
import { _write, _read, _print, _printJSON } from "./builtins.js";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { StateStack } from "../runtime/state/stateStack.js";
import { ThreadStore } from "../runtime/state/threadStore.js";

function frameWithPrintSpy() {
  const ctx = new RuntimeContext<any>({
    statelogConfig: { host: "https://example.com", apiKey: "k", projectId: "p", debugMode: false },
    smoltalkDefaults: {},
    dirname: "/tmp",
  });
  // Build threads from the real client (it needs threadCreated), then patch the
  // one method under test in place so the rest of the client stays intact.
  const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  const printRecorded = vi.fn(async () => undefined);
  (ctx.statelogClient as any).printRecorded = printRecorded;
  return { ctx, threads, printRecorded };
}

describe("_print / _printJSON statelog recording", () => {
  it("records the same formatted value that print writes", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ctx, threads, printRecorded } = frameWithPrintSpy();
    const object = { answer: 42 };

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      _print("result", object);
    });

    expect(spy).toHaveBeenCalledWith("result", object);
    expect(printRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "print", value: format("result", object), truncated: false }),
    );
    spy.mockRestore();
  });

  it("preserves printJSON serialization failures: no console write, no event", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ctx, threads, printRecorded } = frameWithPrintSpy();

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      expect(() => _printJSON(10n as unknown)).toThrow(TypeError);
    });

    expect(spy).not.toHaveBeenCalled();
    expect(printRecorded).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("records top-level undefined the way the console renders it", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { ctx, threads, printRecorded } = frameWithPrintSpy();

    await runInTestContext(ctx, new StateStack(), threads, async () => {
      _printJSON(undefined);
    });

    expect(spy).toHaveBeenCalledWith(undefined);
    expect(printRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "printJSON", value: "undefined" }),
    );
    spy.mockRestore();
  });
});

describe("_write mode parameter", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-write-mode-"));
    target = "out.txt";
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch (_) { /* best effort */ }
  });

  it("defaults to overwrite (backward compat: no mode arg)", async () => {
    writeFileSync(join(dir, target), "existing", "utf-8");
    await _write(dir, target, "replaced");
    expect(readFileSync(join(dir, target), "utf-8")).toBe("replaced");
  });

  it("overwrite mode replaces existing content", async () => {
    writeFileSync(join(dir, target), "existing", "utf-8");
    await _write(dir, target, "replaced", "overwrite");
    expect(readFileSync(join(dir, target), "utf-8")).toBe("replaced");
  });

  it("append mode concatenates to existing content", async () => {
    writeFileSync(join(dir, target), "hello ", "utf-8");
    await _write(dir, target, "world", "append");
    expect(readFileSync(join(dir, target), "utf-8")).toBe("hello world");
  });

  it("append mode creates the file when it does not exist", async () => {
    await _write(dir, target, "fresh", "append");
    expect(readFileSync(join(dir, target), "utf-8")).toBe("fresh");
  });

  it("create-only mode creates a new file successfully", async () => {
    expect(existsSync(join(dir, target))).toBe(false);
    await _write(dir, target, "created", "create-only");
    expect(readFileSync(join(dir, target), "utf-8")).toBe("created");
  });

  it("create-only mode throws when the file already exists", async () => {
    writeFileSync(join(dir, target), "existing", "utf-8");
    await expect(_write(dir, target, "should-fail", "create-only")).rejects.toThrow(
      /already exists/,
    );
    // Original content must be untouched.
    expect(readFileSync(join(dir, target), "utf-8")).toBe("existing");
  });

  it("rejects unknown mode strings with a clear message", async () => {
    await expect(
      _write(dir, target, "x", "bogus" as "overwrite"),
    ).rejects.toThrow(/Invalid mode 'bogus'/);
  });
});

describe("_read offset/limit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agency-read-"));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch (_) { /* best effort */ }
  });

  it("returns the whole file when no offset/limit is given", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(dir, "small.txt"), lines, "utf-8");
    const out = await _read(dir, "small.txt");
    expect(out).toBe(lines);
  });

  it("returns the whole file even when it is large (no soft cap)", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join("\n");
    writeFileSync(join(dir, "big.txt"), lines, "utf-8");
    const out = await _read(dir, "big.txt");
    expect(out).toBe(lines);
    expect(out).not.toContain("[truncated");
  });

  it("paginates with offset and limit (1-indexed) and appends a truncation note", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(dir, "small.txt"), lines.join("\n"), "utf-8");
    const out = await _read(dir, "small.txt", 10, 20);
    const expectedSlice = lines.slice(9, 29).join("\n");
    expect(out.startsWith(expectedSlice)).toBe(true);
    expect(out).toContain("[truncated: showing 10-29 of 50 lines]");
  });

  it("with offset only, reads from offset to end without truncation note", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `x${i}`);
    writeFileSync(join(dir, "tiny.txt"), lines.join("\n"), "utf-8");
    const out = await _read(dir, "tiny.txt", 4, 0);
    expect(out).toBe(lines.slice(3).join("\n"));
    expect(out).not.toContain("[truncated");
  });

  it("treats 0 offset/limit as unset", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `x${i}`).join("\n");
    writeFileSync(join(dir, "tiny.txt"), lines, "utf-8");
    const out = await _read(dir, "tiny.txt", 0, 0);
    expect(out).toBe(lines);
  });
});
