import { describe, expect, it } from "vitest";
import os from "os";
import path from "path";
import process from "process";
import { rejectDangerousPath } from "../fs.js";

const op = "test";
const role = "target";

function isRejected(input: string): boolean {
  try {
    rejectDangerousPath(input, op, role);
    return false;
  } catch {
    return true;
  }
}

describe("rejectDangerousPath", () => {
  it("refuses an empty string", () => {
    expect(isRejected("")).toBe(true);
  });

  it("refuses whitespace-only paths", () => {
    expect(isRejected("   ")).toBe(true);
    expect(isRejected("\t")).toBe(true);
  });

  it("refuses the filesystem root", () => {
    expect(isRejected(path.parse(process.cwd()).root)).toBe(true);
  });

  it("refuses a top-level path under root", () => {
    const root = path.parse(process.cwd()).root;
    expect(isRejected(root + "tmp")).toBe(true);
    expect(isRejected(root + "etc")).toBe(true);
    expect(isRejected(root + "Users")).toBe(true);
  });

  it("refuses the user's home directory", () => {
    expect(isRejected(os.homedir())).toBe(true);
  });

  it("refuses '.' (current working directory)", () => {
    expect(isRejected(".")).toBe(true);
  });

  it("refuses '..' (an ancestor of cwd)", () => {
    expect(isRejected("..")).toBe(true);
  });

  it("refuses '../..' (a higher ancestor of cwd)", () => {
    expect(isRejected("../..")).toBe(true);
  });

  it("allows a deep path under a top-level dir", () => {
    const root = path.parse(process.cwd()).root;
    expect(isRejected(root + path.join("tmp", "scratch", "file.txt"))).toBe(
      false,
    );
  });

  it("allows a child of cwd", () => {
    expect(isRejected(path.join(process.cwd(), "child"))).toBe(false);
  });

  it("includes the operation and role in the error message", () => {
    let msg = "";
    try {
      rejectDangerousPath("", "remove", "target");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/remove/);
    expect(msg).toMatch(/target/);
  });
});
