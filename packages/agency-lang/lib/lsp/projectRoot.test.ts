import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { findProjectRoot } from "../config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-root-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("findProjectRoot", () => {
  it("returns directory containing agency.json when starting from that directory", () => {
    fs.writeFileSync(path.join(tmpDir, "agency.json"), "{}");
    expect(findProjectRoot(tmpDir)).toBe(tmpDir);
  });

  it("returns directory containing agency.json when starting from a file in that directory", () => {
    fs.writeFileSync(path.join(tmpDir, "agency.json"), "{}");
    const file = path.join(tmpDir, "main.agency");
    fs.writeFileSync(file, "");
    expect(findProjectRoot(file)).toBe(tmpDir);
  });

  it("walks upward to find agency.json in a parent directory", () => {
    fs.writeFileSync(path.join(tmpDir, "agency.json"), "{}");
    const nested = path.join(tmpDir, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    const file = path.join(nested, "foo.agency");
    fs.writeFileSync(file, "");
    expect(findProjectRoot(file)).toBe(tmpDir);
  });

  it("returns null when no agency.json exists in any ancestor", () => {
    const nested = path.join(tmpDir, "no-config");
    fs.mkdirSync(nested, { recursive: true });
    const file = path.join(nested, "foo.agency");
    fs.writeFileSync(file, "");
    expect(findProjectRoot(file)).toBeNull();
  });

  it("stops at the nearest agency.json when nested configs exist", () => {
    fs.writeFileSync(path.join(tmpDir, "agency.json"), "{}");
    const inner = path.join(tmpDir, "sub");
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, "agency.json"), "{}");
    expect(findProjectRoot(inner)).toBe(inner);
  });
});
