import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { atomicWriteValidated, openJsonlStrict } from "./jsonl.js";

const RowSchema = z
  .object({
    id: z.string().min(1),
    n: z.number().int(),
  })
  .strict();

type Row = z.infer<typeof RowSchema>;

const identityOf = (row: Row) => row.id;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "label-jsonl-"));
  file = path.join(dir, "rows.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function open() {
  return openJsonlStrict({ filePath: file, schema: RowSchema, identityOf });
}

describe("openJsonlStrict", () => {
  it("opens a missing file as empty", () => {
    expect(open().rows()).toEqual([]);
  });

  it("opens an empty file as empty", () => {
    fs.writeFileSync(file, "");
    expect(open().rows()).toEqual([]);
  });

  it("reads rows in append order", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\n{"id":"b","n":2}\n');
    expect(
      open()
        .rows()
        .map((row) => row.id),
    ).toEqual(["a", "b"]);
  });

  it("names the line number when a middle row is not JSON", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\nNOT JSON\n{"id":"c","n":3}\n');
    expect(() => open()).toThrow(/line 2/);
  });

  it("names the line number when a row fails the schema", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\n{"id":"b"}\n');
    expect(() => open()).toThrow(/line 2/);
  });

  it("rejects an unknown key rather than dropping it", () => {
    fs.writeFileSync(file, '{"id":"a","n":1,"extra":true}\n');
    expect(() => open()).toThrow(/line 1/);
  });

  it("refuses a nonempty file that does not end in a newline, because that is a torn append", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\n{"id":"b","n":2}');
    expect(() => open()).toThrow(/newline|torn|incomplete/i);
  });

  it("explains how to repair a torn tail", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\n{"id":"b"');
    expect(() => open()).toThrow(/last line/i);
  });

  it("rejects a duplicate identity already on disk, not just on append", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\n{"id":"a","n":2}\n');
    expect(() => open()).toThrow(/repeats identity "a".*different content/is);
  });

  it("rejects an identical duplicate line too, because no correct writer makes one", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\n{"id":"a","n":1}\n');
    expect(() => open()).toThrow(/repeats identity "a".*identical content/is);
  });
});

describe("appendExact", () => {
  it("appends a new row and reports it", () => {
    const log = open();
    expect(log.appendExact({ id: "a", n: 1 })).toBe("appended");
    expect(log.rows().map((row) => row.id)).toEqual(["a"]);
  });

  it("treats an identical repeat as a replay rather than a duplicate", () => {
    const log = open();
    log.appendExact({ id: "a", n: 1 });
    expect(log.appendExact({ id: "a", n: 1 })).toBe("replayed");
    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("throws when the same identity carries different content", () => {
    const log = open();
    log.appendExact({ id: "a", n: 1 });
    expect(() => log.appendExact({ id: "a", n: 2 })).toThrow(/different content/i);
  });

  it("validates before writing, so a bad row never reaches the file", () => {
    const log = open();
    expect(() => log.appendExact({ id: "", n: 1 })).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("supports many appends after a single open without re-reading the file", () => {
    const log = open();
    for (let index = 0; index < 50; index += 1) {
      log.appendExact({ id: `row-${index}`, n: index });
    }
    expect(log.rows()).toHaveLength(50);
    expect(open().rows()).toHaveLength(50);
  });

  it("always terminates a row with a newline so the next append is well-formed", () => {
    const log = open();
    log.appendExact({ id: "a", n: 1 });
    expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
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

describe("find", () => {
  it("returns undefined for an identity the log does not hold", () => {
    expect(open().find("missing")).toBeUndefined();
  });

  it("returns a row appended in this session", () => {
    const log = open();
    log.appendExact({ id: "a", n: 1 });
    expect(log.find("a")).toEqual({ id: "a", n: 1 });
  });

  it("returns a row written by an earlier session, after reopening", () => {
    open().appendExact({ id: "a", n: 1 });
    expect(open().find("a")).toEqual({ id: "a", n: 1 });
  });

  it("shares one index with appendExact, so a found row is also a replay", () => {
    const log = open();
    log.appendExact({ id: "a", n: 1 });
    expect(log.find("a")).toBeDefined();
    expect(log.appendExact({ id: "a", n: 1 })).toBe("replayed");
  });
});
