import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseFormat, resolveFormat } from "./format.js";
import { IngestSourceError } from "./types.js";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "label-format-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeDir(name: string, files: readonly string[] = []): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{}");
  }
  return dir;
}

function auto(source: string) {
  return resolveFormat({ source, requested: "auto" });
}

describe("parseFormat", () => {
  it("accepts every documented format", () => {
    expect(parseFormat("run")).toBe("run");
    expect(parseFormat("files")).toBe("files");
    expect(parseFormat("json")).toBe("json");
    expect(parseFormat("auto")).toBe("auto");
  });

  it("rejects an unknown format, listing the ones that work", () => {
    expect(() => parseFormat("csv")).toThrow(/auto, run, files, json/);
  });
});

describe("resolveFormat auto", () => {
  it("treats a directory with config.json AND inputs/ as a run", () => {
    const dir = makeDir("run-dir", ["config.json", "inputs/a/input.json"]);
    expect(auto(dir)).toBe("run");
  });

  it("does NOT treat a directory with only config.json as a run", () => {
    // Both markers are required: a folder of answers that happens to hold a
    // config.json is a folder of files.
    expect(auto(makeDir("almost", ["config.json"]))).toBe("files");
  });

  it("does NOT treat a directory with only inputs/ as a run", () => {
    expect(auto(makeDir("almost-2", ["inputs/a/input.json"]))).toBe("files");
  });

  it("treats any other directory as files", () => {
    expect(auto(makeDir("gold", ["a.txt"]))).toBe("files");
  });



  it("treats a .json file as json", () => {
    fs.writeFileSync(path.join(root, "answers.json"), "[]");
    expect(auto(path.join(root, "answers.json"))).toBe("json");
  });

  it("treats a .JSON file as json, because extensions are not case sensitive here", () => {
    fs.writeFileSync(path.join(root, "answers.JSON"), "[]");
    expect(auto(path.join(root, "answers.JSON"))).toBe("json");
  });

  it("errors on anything else, naming the explicit formats", () => {
    fs.writeFileSync(path.join(root, "notes.txt"), "x");
    expect(() => auto(path.join(root, "notes.txt"))).toThrow(/--format run\|files\|json/);
  });

  it("errors on a path that does not exist and has no json extension", () => {
    expect(() => auto(path.join(root, "missing"))).toThrow(IngestSourceError);
  });
});

describe("resolveFormat with an explicit format", () => {
  it("honours the explicit choice over the guess", () => {
    const dir = makeDir("run-dir", ["config.json", "inputs/a/input.json"]);
    expect(resolveFormat({ source: dir, requested: "files" })).toBe("files");
  });

  it("does not inspect the filesystem at all when told the format", () => {
    expect(resolveFormat({ source: "/definitely/not/here", requested: "run" })).toBe("run");
  });
});
