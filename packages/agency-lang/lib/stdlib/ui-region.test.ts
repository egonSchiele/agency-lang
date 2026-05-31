import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  installRegion,
  resetRegion,
  withBottomCursor,
  scrollBottomRow,
  onResize,
} from "./ui-region.js";

// Tests stub process.stdout.write / isTTY / rows / columns so the
// region helper can be exercised in isolation from a real terminal.

describe("ui-region", () => {
  let writes: string[] = [];
  let origWrite: typeof process.stdout.write;
  let origIsTTY: boolean | undefined;
  let origRows: number | undefined;
  let origCols: number | undefined;

  beforeEach(() => {
    writes = [];
    origWrite = process.stdout.write.bind(process.stdout);
    origIsTTY = process.stdout.isTTY;
    origRows = process.stdout.rows;
    origCols = process.stdout.columns;
    (process.stdout as any).isTTY = true;
    (process.stdout as any).rows = 24;
    (process.stdout as any).columns = 80;
    process.stdout.write = ((s: any) => {
      writes.push(String(s));
      return true;
    }) as any;
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    (process.stdout as any).isTTY = origIsTTY;
    (process.stdout as any).rows = origRows;
    (process.stdout as any).columns = origCols;
    resetRegion();
  });

  it("installRegion(3) sets scroll region 1..21 on a 24-row terminal", () => {
    installRegion(3);
    expect(writes.join("")).toContain("\x1b[1;21r");
    expect(scrollBottomRow()).toBe(21);
  });

  it("resetRegion emits CSI r and prints a trailing newline", () => {
    installRegion(3);
    writes.length = 0;
    resetRegion();
    const out = writes.join("");
    expect(out).toContain("\x1b[r");
    expect(out.endsWith("\n")).toBe(true);
    expect(scrollBottomRow()).toBe(0);
  });

  it("withBottomCursor wraps a write in save/move/restore", () => {
    installRegion(3);
    writes.length = 0;
    withBottomCursor(() => process.stdout.write("FRAME"));
    const out = writes.join("");
    expect(out).toMatch(/\x1b\[s.*\x1b\[22;1H.*FRAME.*\x1b\[u/s);
  });

  it("onResize recomputes scrollBottomRow on new terminal size", () => {
    installRegion(3);
    (process.stdout as any).rows = 40;
    onResize();
    expect(scrollBottomRow()).toBe(37);
  });

  it("non-TTY: installRegion is a no-op and emits no escapes", () => {
    (process.stdout as any).isTTY = false;
    writes.length = 0;
    installRegion(3);
    expect(writes.join("")).toBe("");
    expect(scrollBottomRow()).toBe(0);
  });

  it("non-TTY: withBottomCursor still runs the callback (no escapes)", () => {
    (process.stdout as any).isTTY = false;
    installRegion(3);
    writes.length = 0;
    let ran = false;
    withBottomCursor(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(writes.join("")).toBe("");
  });

  it("non-TTY: resetRegion clears state without emitting escapes", () => {
    (process.stdout as any).isTTY = false;
    installRegion(3);
    writes.length = 0;
    resetRegion();
    expect(writes.join("")).toBe("");
    expect(scrollBottomRow()).toBe(0);
  });
});
