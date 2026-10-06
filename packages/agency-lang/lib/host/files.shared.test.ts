import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import os from "os";
import path from "path";
import type { Host } from "./host.js";
import { nodeHost } from "./nodeHost.js";
import { memoryHost } from "./memoryHost.js";

// One set of tests for every host that has files. Each case builds a host
// and a directory to work in, runs the same checks, and cleans up. A host
// added later registers here and gets the whole battery.

type Workspace = { host: Host; dir: string; cleanup: () => void };

function registerFileTests(name: string, open: () => Workspace): void {
  describe(`${name} files`, () => {
    const text = new TextDecoder();

    async function withWorkspace(fn: (ws: Workspace) => Promise<void>): Promise<void> {
      const ws = open();
      try {
        await fn(ws);
      } finally {
        ws.cleanup();
      }
    }

    it("writes and reads text and bytes", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        await host.files.writeText(root, "a.txt", "hello");
        expect(await host.files.readText(root, "a.txt")).toBe("hello");
        await host.files.writeBytes(root, "b.bin", new Uint8Array([1, 2, 3]));
        const bytes = await host.files.readBytes(root, "b.bin");
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(Array.from(bytes)).toEqual([1, 2, 3]);
        let chunks = "";
        for await (const chunk of host.files.readChunks(root, "a.txt")) {
          chunks += text.decode(chunk);
        }
        expect(chunks).toBe("hello");
      }));

    it("honours every write mode", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        await host.files.writeText(root, "m.txt", "one", { mode: "create-only" });
        await expect(
          host.files.writeText(root, "m.txt", "two", { mode: "create-only" }),
        ).rejects.toThrow();
        await host.files.writeText(root, "m.txt", "+two", { mode: "append" });
        expect(await host.files.readText(root, "m.txt")).toBe("one+two");
        await host.files.writeText(root, "m.txt", "three", { mode: "overwrite" });
        expect(await host.files.readText(root, "m.txt")).toBe("three");
      }));

    it("lists, stats, makes, and removes directories", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        await host.files.mkdir(root, "sub/deep");
        await host.files.writeText(root, "sub/f.txt", "x");
        const entries = await host.files.list(root, "sub");
        expect(entries.map((e) => `${e.name}:${e.type}`).sort()).toEqual([
          "deep:dir",
          "f.txt:file",
        ]);
        const info = await host.files.stat(root, "sub/f.txt");
        expect(info?.kind).toBe("file");
        expect(info?.size).toBe(1);
        expect((await host.files.stat(root, "sub"))?.kind).toBe("dir");
        expect(await host.files.stat(root, "missing")).toBeNull();
        await host.files.remove(root, "sub");
        expect(await host.files.stat(root, "sub")).toBeNull();
      }));

    it("copies and moves", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        await host.files.writeText(root, "src.txt", "copy me");
        await host.files.copy({ root, target: "src.txt" }, { root, target: "dst.txt" });
        expect(await host.files.readText(root, "dst.txt")).toBe("copy me");
        await host.files.move({ root, target: "dst.txt" }, { root, target: "moved.txt" });
        expect(await host.files.stat(root, "dst.txt")).toBeNull();
        expect(await host.files.readText(root, "moved.txt")).toBe("copy me");
        await expect(
          host.files.copy({ root, target: "nope" }, { root, target: "x" }),
        ).rejects.toThrow("no such file");
      }));

    it("rejects a missing file", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        await expect(host.files.readText(root, "missing.txt")).rejects.toThrow();
      }));

    it("refuses a path that escapes the root", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        await expect(host.files.readText(root, "../outside")).rejects.toThrow("outside dir");
        await expect(host.files.writeText(root, "/etc/passwd", "x")).rejects.toThrow("outside dir");
        await expect(host.files.resolvePath(root, "../x")).rejects.toThrow("outside dir");
      }));

    it("splits a whole path and locates a file for a payload", () =>
      withWorkspace(async ({ host, dir }) => {
        const located = await host.files.wholePath(path.posix.join(dir, "sub", "name.txt"));
        expect(located.target).toBe("name.txt");
        const found = await host.files.locate(dir, "a/b.txt", "write");
        expect(found.filename).toBe("a/b.txt");
        await expect(host.files.locate(dir, "../up.txt", "write")).rejects.toThrow(
          "To write somewhere else, pass that directory in dir.",
        );
        await expect(host.files.locate(path.posix.join(dir, "nope"), "f", "read")).rejects.toThrow(
          "does not exist",
        );
      }));

    it("updateText loses neither of two overlapping updates", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        await host.files.writeText(root, "n.txt", "0");
        const bump = (current: string | null) => String(Number(current ?? "0") + 1);
        // Started without awaiting the first, as two branches of a fork would.
        await Promise.all([
          host.files.updateText(root, "n.txt", bump),
          host.files.updateText(root, "n.txt", bump),
        ]);
        expect(await host.files.readText(root, "n.txt")).toBe("2");
      }));

    it("withLock runs two pieces of work on one path one after the other", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        const order: string[] = [];
        const slow = host.files.withLock(root, "shared", async () => {
          order.push("first start");
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push("first end");
        });
        const fast = host.files.withLock(root, "shared", async () => {
          order.push("second");
        });
        await Promise.all([slow, fast]);
        expect(order).toEqual(["first start", "first end", "second"]);
      }));

    it("fixedPath and realPath spell a whole path the way a payload does", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        await host.files.mkdir(root, "sub");
        const whole = path.posix.join(dir, "sub", "note.txt");
        const fixed = await host.files.fixedPath(whole);
        expect(fixed.target).toBe("note.txt");
        expect(await host.files.resolvePath(fixed.root, fixed.target)).toBe(whole);
        expect(await host.files.realPath(whole)).toBe(whole);
        expect(await host.files.realPath(path.posix.join(dir, "sub", "..", "other"))).toBe(
          path.posix.join(dir, "other"),
        );
      }));

    it("fixedRoot and realDir spell a directory the way a payload does", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        await host.files.mkdir(root, "sub");
        const sub = path.posix.join(dir, "sub");
        const fixed = await host.files.fixedRoot(sub);
        expect(await host.files.resolvePath(fixed, ".")).toBe(sub);
        expect(await host.files.realDir(path.posix.join(dir, "sub", "..", "sub"))).toBe(sub);
        // A directory that does not exist yet keeps its lexical spelling.
        const missing = path.posix.join(dir, "later");
        expect(await host.files.realDir(missing)).toBe(missing);
        await expect(host.files.fixedRoot("")).rejects.toThrow("must not be empty");
      }));

    it("openForWrite writes at positions and truncates", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        const file = await host.files.openForWrite(root, "o.bin");
        await file.writeAt(new TextEncoder().encode("hello world"), 0);
        await file.writeAt(new TextEncoder().encode("HELLO"), 0);
        await file.truncate(8);
        await file.close();
        expect(await host.files.readText(root, "o.bin")).toBe("HELLO wo");
      }));

    it("withLock releases its entry when the last holder leaves", () =>
      withWorkspace(async ({ host, dir }) => {
        const root = await host.files.root(dir);
        await host.files.withLock(root, "once", async () => {});
        // A second lock on the same path must not wait on anything the
        // first left behind, and must run at once.
        let ran = false;
        await host.files.withLock(root, "once", async () => {
          ran = true;
        });
        expect(ran).toBe(true);
      }));

    it("a host without fileWrite refuses a write and still reads", () =>
      withWorkspace(async ({ dir }) => {
        const readOnly =
          name === "nodeHost"
            ? nodeHost({ capabilities: ["fileRead"] })
            : memoryHost({ capabilities: ["fileRead"], files: { [`${dir}/r.txt`]: "ro" } });
        const root = await readOnly.files.root(dir);
        // A refusal throws when the function is called, before any promise
        // exists; an `await` in an async caller turns that into a rejection.
        expect(() => readOnly.files.writeText(root, "w.txt", "x")).toThrow(
          "files.writeText needs the fileWrite capability",
        );
        if (name === "memoryHost") {
          expect(await readOnly.files.readText(root, "r.txt")).toBe("ro");
        }
      }));
  });
}

registerFileTests("nodeHost", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "host-files-")));
  return {
    host: nodeHost(),
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
});

registerFileTests("memoryHost", () => ({
  host: memoryHost({ cwd: "/work" }),
  dir: "/work",
  cleanup: () => {},
}));
