import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { writeContainedFile } from "./writeContainedFile.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(process.cwd(), prefix));
}

function cleanup(dir: string): void {
  expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
}

describe("writeContainedFile", () => {
  test("overwrites a regular file inside the root", () => {
    const dir = makeDir(".wcf-ok-");
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      const target = path.join(dir, "sub", "a.txt");
      fs.writeFileSync(target, "a much longer original");
      writeContainedFile(dir, target, "new");
      expect(fs.readFileSync(target, "utf-8")).toBe("new");
    } finally {
      cleanup(dir);
    }
  });

  test("creates a missing file whose parent is a real directory inside the root", () => {
    const dir = makeDir(".wcf-create-");
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      const target = path.join(dir, "sub", "a.txt");
      writeContainedFile(dir, target, "made");
      expect(fs.readFileSync(target, "utf-8")).toBe("made");
    } finally {
      cleanup(dir);
    }
  });

  test("a final-component symlink is not followed", () => {
    const parent = makeDir(".wcf-link-");
    try {
      const root = path.join(parent, "root");
      fs.mkdirSync(root);
      const secret = path.join(parent, "secret.txt");
      fs.writeFileSync(secret, "secret");
      fs.symlinkSync(secret, path.join(root, "link.txt"));
      expect(() => writeContainedFile(root, path.join(root, "link.txt"), "x")).toThrow();
      expect(fs.readFileSync(secret, "utf-8")).toBe("secret");
    } finally {
      cleanup(parent);
    }
  });

  test("a new file under a symlinked directory is refused", () => {
    const parent = makeDir(".wcf-linkdir-");
    try {
      const root = path.join(parent, "root");
      fs.mkdirSync(root);
      const outside = path.join(parent, "outside");
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(root, "tool"));
      // Positive control: the link is reachable through the filesystem.
      expect(fs.existsSync(path.join(root, "tool"))).toBe(true);
      expect(() => writeContainedFile(root, path.join(root, "tool", "meta.json"), "x")).toThrow(
        /symlink/,
      );
      expect(fs.existsSync(path.join(outside, "meta.json"))).toBe(false);
    } finally {
      cleanup(parent);
    }
  });

  test("a FIFO is refused without blocking", () => {
    const dir = makeDir(".wcf-fifo-");
    try {
      execFileSync("mkfifo", [path.join(dir, "pipe")]);
      expect(() => writeContainedFile(dir, path.join(dir, "pipe"), "x")).toThrow();
    } finally {
      cleanup(dir);
    }
  });

  test("swap seam: an ancestor replaced by a link outside between open and validation is refused", () => {
    const parent = makeDir(".wcf-swap-");
    try {
      const root = path.join(parent, "root");
      fs.mkdirSync(path.join(root, "sub"), { recursive: true });
      const target = path.join(root, "sub", "a.txt");
      fs.writeFileSync(target, "inside");
      fs.mkdirSync(path.join(parent, "outside"));
      fs.writeFileSync(path.join(parent, "outside", "a.txt"), "secret");
      expect(() =>
        writeContainedFile(root, target, "x", {
          afterOpen: () => {
            fs.renameSync(path.join(root, "sub"), path.join(root, "sub.moved"));
            fs.symlinkSync(path.join(parent, "outside"), path.join(root, "sub"));
          },
        }),
      ).toThrow(/outside/);
      // Neither file received the bytes.
      expect(fs.readFileSync(path.join(root, "sub.moved", "a.txt"), "utf-8")).toBe("inside");
      expect(fs.readFileSync(path.join(parent, "outside", "a.txt"), "utf-8")).toBe("secret");
    } finally {
      cleanup(parent);
    }
  });

  test("swap seam: a swap undone again after the open is caught by file identity", () => {
    const dir = makeDir(".wcf-ident-");
    try {
      const target = path.join(dir, "a.txt");
      fs.writeFileSync(target, "original");
      expect(() =>
        writeContainedFile(dir, target, "x", {
          afterOpen: () => {
            fs.unlinkSync(target);
            fs.writeFileSync(target, "replacement");
          },
        }),
      ).toThrow(/changed between validation and write/);
      expect(fs.readFileSync(target, "utf-8")).toBe("replacement");
    } finally {
      cleanup(dir);
    }
  });
});
