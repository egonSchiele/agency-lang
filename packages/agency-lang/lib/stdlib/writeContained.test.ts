import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { _write } from "./builtins.js";

/** A root the writes must stay inside, and a sibling they must never reach. */
function sandbox(): { root: string; outside: string } {
  const base = mkdtempSync(path.join(tmpdir(), "wc-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside };
}

describe("_write with allowedPaths", () => {
  it("writes normally inside the root, including new subdirectory-less files", async () => {
    const { root } = sandbox();
    await _write(root, "fib.agency", "export def fib", "overwrite", [root]);
    expect(readFileSync(path.join(root, "fib.agency"), "utf8")).toBe("export def fib");
  });

  it("refuses .. and absolute escapes by resolved destination", async () => {
    const { root, outside } = sandbox();
    await expect(_write(root, "../outside/x.txt", "x", "overwrite", [root])).rejects.toThrow(
      /not under any of the allowed paths/,
    );
    await expect(
      _write(root, path.join(outside, "y.txt"), "y", "overwrite", [root]),
    ).rejects.toThrow(/not under any of the allowed paths/);
    expect(existsSync(path.join(outside, "x.txt"))).toBe(false);
    expect(existsSync(path.join(outside, "y.txt"))).toBe(false);
  });

  it("refuses ~ escapes: containment judges the expanded destination", async () => {
    const { root } = sandbox();
    await expect(_write(root, "~/payload.agency", "x", "overwrite", [root])).rejects.toThrow(
      /not under any of the allowed paths/,
    );
  });

  it("never writes through a dangling final-component symlink (the stale-preflight attack)", async () => {
    const { root, outside } = sandbox();
    // root/payload.agency -> ../outside/payload.agency, which does not exist:
    // realpath of the full path fails, so an ancestor-based preflight calls
    // this contained. The write itself must still refuse to follow it.
    symlinkSync(path.join("..", "outside", "payload.agency"), path.join(root, "payload.agency"));
    await expect(_write(root, "payload.agency", "x", "overwrite", [root])).rejects.toThrow(
      /never follow symlinks/,
    );
    expect(existsSync(path.join(outside, "payload.agency"))).toBe(false);
  });

  it("never writes through an existing final-component symlink either", async () => {
    const { root, outside } = sandbox();
    await _write(outside, "real.txt", "original", "overwrite");
    symlinkSync(path.join("..", "outside", "real.txt"), path.join(root, "link.txt"));
    // Refused a layer earlier than the dangling case: realpath succeeds, so
    // assertContained already sees the outside destination.
    await expect(_write(root, "link.txt", "clobbered", "overwrite", [root])).rejects.toThrow(
      /never follow symlinks|not under any of the allowed paths/,
    );
    expect(readFileSync(path.join(outside, "real.txt"), "utf8")).toBe("original");
  });

  it("keeps append and create-only semantics on the contained path", async () => {
    const { root } = sandbox();
    await _write(root, "log.txt", "a", "overwrite", [root]);
    await _write(root, "log.txt", "b", "append", [root]);
    expect(readFileSync(path.join(root, "log.txt"), "utf8")).toBe("ab");
    await expect(_write(root, "log.txt", "c", "create-only", [root])).rejects.toThrow(
      /already exists/,
    );
  });

  it("without allowedPaths, behavior is unchanged (no new restriction)", async () => {
    const { root, outside } = sandbox();
    await _write(root, "../outside/free.txt", "x", "overwrite");
    expect(readFileSync(path.join(outside, "free.txt"), "utf8")).toBe("x");
  });
});
