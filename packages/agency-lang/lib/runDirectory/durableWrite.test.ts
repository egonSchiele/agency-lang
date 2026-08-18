import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { appendDurably, atomicWriteValidated } from "./durableWrite.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-write-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("appendDurably", () => {
  it("creates the file and appends in order", () => {
    const file = path.join(dir, "rows.jsonl");
    appendDurably(file, "one\n");
    appendDurably(file, "two\n");
    expect(fs.readFileSync(file, "utf8")).toBe("one\ntwo\n");
  });
});

describe("atomicWriteValidated", () => {
  const TargetSchema = z.object({ value: z.string() }).strict();

  it("writes the file", () => {
    const target = path.join(dir, "x.json");
    atomicWriteValidated({ targetPath: target, value: { value: "hi" }, schema: TargetSchema });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ value: "hi" });
  });

  it("leaves no temporary file behind", () => {
    const target = path.join(dir, "x.json");
    atomicWriteValidated({ targetPath: target, value: { value: "hi" }, schema: TargetSchema });
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("replaces an existing file", () => {
    const target = path.join(dir, "x.json");
    atomicWriteValidated({ targetPath: target, value: { value: "one" }, schema: TargetSchema });
    atomicWriteValidated({ targetPath: target, value: { value: "two" }, schema: TargetSchema });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ value: "two" });
  });

  it("rejects an invalid value without touching the target", () => {
    const target = path.join(dir, "x.json");
    expect(() =>
      atomicWriteValidated({
        targetPath: target,
        value: { value: 5 } as never,
        schema: TargetSchema,
      }),
    ).toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("cleans up its temporary file when the rename fails", () => {
    // A directory where the target should be makes rename fail after the temp
    // file already exists, which is the case that would otherwise leak.
    const target = path.join(dir, "as-a-directory");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "occupant"), "x");
    expect(() =>
      atomicWriteValidated({
        targetPath: target,
        value: { value: "hi" },
        schema: TargetSchema,
      }),
    ).toThrow();
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
