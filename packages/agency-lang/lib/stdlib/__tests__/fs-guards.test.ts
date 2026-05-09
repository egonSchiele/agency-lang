import { describe, expect, it } from "vitest";
import os from "os";
import path from "path";
import process from "process";
import { rejectDangerousPath } from "../fs.js";

const op = "test";
const role = "target";

async function isRejected(input: string): Promise<boolean> {
  try {
    await rejectDangerousPath(input, op, role);
    return false;
  } catch {
    return true;
  }
}

describe("rejectDangerousPath", () => {
  it("refuses an empty string", async () => {
    expect(await isRejected("")).toBe(true);
  });

  it("refuses whitespace-only paths", async () => {
    expect(await isRejected("   ")).toBe(true);
    expect(await isRejected("\t")).toBe(true);
  });

  it("refuses the filesystem root", async () => {
    expect(await isRejected(path.parse(process.cwd()).root)).toBe(true);
  });

  it("refuses a top-level path under root", async () => {
    const root = path.parse(process.cwd()).root;
    expect(await isRejected(root + "tmp")).toBe(true);
    expect(await isRejected(root + "etc")).toBe(true);
    expect(await isRejected(root + "Users")).toBe(true);
  });

  it("refuses the user's home directory", async () => {
    expect(await isRejected(os.homedir())).toBe(true);
  });

  it("refuses '.' (current working directory)", async () => {
    expect(await isRejected(".")).toBe(true);
  });

  it("refuses '..' (an ancestor of cwd)", async () => {
    expect(await isRejected("..")).toBe(true);
  });

  it("refuses '../..' (a higher ancestor of cwd)", async () => {
    expect(await isRejected("../..")).toBe(true);
  });

  it("allows a deep path under a top-level dir", async () => {
    const root = path.parse(process.cwd()).root;
    expect(await isRejected(root + path.join("tmp", "scratch", "file.txt"))).toBe(
      false,
    );
  });

  it("allows a child of cwd", async () => {
    expect(await isRejected(path.join(process.cwd(), "child"))).toBe(false);
  });

  it("includes the operation and role in the error message", async () => {
    let msg = "";
    try {
      await rejectDangerousPath("", "remove", "target");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/remove/);
    expect(msg).toMatch(/target/);
  });
});
