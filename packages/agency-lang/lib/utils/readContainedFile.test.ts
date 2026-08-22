import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { readContainedFile } from "./readContainedFile.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

function makeDir(prefix: string): string {
  return fs.mkdtempSync(path.join(process.cwd(), prefix));
}

function cleanup(dir: string): void {
  expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
}

describe("readContainedFile", () => {
  test("reads a regular file inside the root", () => {
    const dir = makeDir(".rcf-ok-");
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "sub", "a.txt"), "hello");
      expect(readContainedFile(dir, path.join(dir, "sub", "a.txt"))).toBe("hello");
    } finally {
      cleanup(dir);
    }
  });

  test("swap seam: an ancestor replaced by a link outside between open and validation is refused", () => {
    const parent = makeDir(".rcf-swap-");
    try {
      const root = path.join(parent, "root");
      fs.mkdirSync(path.join(root, "sub"), { recursive: true });
      fs.writeFileSync(path.join(root, "sub", "a.txt"), "inside");
      fs.mkdirSync(path.join(parent, "outside"));
      fs.writeFileSync(path.join(parent, "outside", "a.txt"), "secret");
      const target = path.join(root, "sub", "a.txt");
      // The descriptor already names the inside file; the path now leads
      // outside. Neither the inside bytes nor the outside ones may be
      // returned as a validated read.
      expect(() =>
        readContainedFile(root, target, {
          afterOpen: () => {
            fs.renameSync(path.join(root, "sub"), path.join(root, "sub.moved"));
            fs.symlinkSync(path.join(parent, "outside"), path.join(root, "sub"));
          },
        }),
      ).toThrow(/outside/);
    } finally {
      cleanup(parent);
    }
  });

  test("swap seam: a swap undone again after the open is caught by file identity", () => {
    const dir = makeDir(".rcf-ident-");
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "original");
      const target = path.join(dir, "a.txt");
      expect(() =>
        readContainedFile(dir, target, {
          afterOpen: () => {
            // The path is inside again, but it is a different file than
            // the one the descriptor was opened on.
            fs.unlinkSync(target);
            fs.writeFileSync(target, "replacement");
          },
        }),
      ).toThrow(/changed between validation and read/);
    } finally {
      cleanup(dir);
    }
  });

  test("a final-component symlink is not followed", () => {
    const parent = makeDir(".rcf-link-");
    try {
      const root = path.join(parent, "root");
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(parent, "secret.txt"), "secret");
      fs.symlinkSync(path.join(parent, "secret.txt"), path.join(root, "link.txt"));
      expect(() => readContainedFile(root, path.join(root, "link.txt"))).toThrow();
    } finally {
      cleanup(parent);
    }
  });

  test("a FIFO is refused without blocking", () => {
    const dir = makeDir(".rcf-fifo-");
    try {
      execFileSync("mkfifo", [path.join(dir, "pipe")]);
      expect(() => readContainedFile(dir, path.join(dir, "pipe"))).toThrow(/not a regular file/);
    } finally {
      cleanup(dir);
    }
  });
});
