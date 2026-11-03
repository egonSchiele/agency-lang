import { describe, test, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  compiledPathFor,
  resolveTrustedModules,
  sourcePathFor,
  trustedEntryFor,
} from "./trustedModules.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

function makeDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), prefix)));
}

function cleanup(dir: string): void {
  expect(safeDeleteDirectoryWithin(process.cwd(), dir).success).toBe(true);
}

describe("resolveTrustedModules", () => {
  test("a relative entry resolves against the base directory", () => {
    const base = makeDir(".tm-rel-");
    try {
      fs.mkdirSync(path.join(base, "src", "agent"), { recursive: true });
      fs.mkdirSync(path.join(base, "dist", "agent"), { recursive: true });
      const result = resolveTrustedModules([{ source: "src/agent", compiled: "dist/agent" }], base);
      expect(result).toEqual({
        ok: true,
        value: [
          { source: path.join(base, "src", "agent"), compiled: path.join(base, "dist", "agent") },
        ],
      });
    } finally {
      cleanup(base);
    }
  });

  test("a missing source directory fails with the entry and the resolved path", () => {
    const base = makeDir(".tm-missing-");
    try {
      fs.mkdirSync(path.join(base, "dist"));
      const result = resolveTrustedModules([{ source: "src", compiled: "dist" }], base);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("source: 'src'");
        expect(result.error).toContain(path.join(base, "src"));
        expect(result.error).toContain("does not exist");
      }
    } finally {
      cleanup(base);
    }
  });

  test("a missing compiled directory resolves, as a project not built yet", () => {
    const base = makeDir(".tm-unbuilt-");
    try {
      fs.mkdirSync(path.join(base, "src"));
      const result = resolveTrustedModules([{ source: "src", compiled: "dist" }], base);
      expect(result).toEqual({
        ok: true,
        value: [{ source: path.join(base, "src"), compiled: path.join(base, "dist") }],
      });
    } finally {
      cleanup(base);
    }
  });

  test("a directory reached through a symlink fails", () => {
    const base = makeDir(".tm-link-");
    try {
      fs.mkdirSync(path.join(base, "real"));
      fs.symlinkSync(path.join(base, "real"), path.join(base, "linked"));
      const result = resolveTrustedModules([{ source: "linked", compiled: "real" }], base);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("symlink");
    } finally {
      cleanup(base);
    }
  });
});

describe("trustedEntryFor", () => {
  const entry = { source: "/p/src/agent", compiled: "/p/dist/agent" };

  test("finds a file in a nested subdirectory", () => {
    expect(trustedEntryFor("/p/src/agent/scheduled/run.agency", [entry])).toBe(entry);
  });

  test("does not match a sibling that shares a prefix", () => {
    expect(trustedEntryFor("/p/src/agentx/run.agency", [entry])).toBeNull();
  });
});

describe("compiledPathFor", () => {
  test("keeps the subdirectory", () => {
    const entry = { source: "/p/src/agent", compiled: "/p/dist/agent" };
    expect(compiledPathFor("/p/src/agent/scheduled/run.agency", entry)).toBe(
      "/p/dist/agent/scheduled/run.js",
    );
  });
});

describe("sourcePathFor", () => {
  const entry = { source: "/p/src/agent", compiled: "/p/dist/agent" };

  test("maps a path under the compiled directory back to the source directory", () => {
    expect(sourcePathFor("/p/dist/agent/scheduled/run.agency", [entry])).toBe(
      "/p/src/agent/scheduled/run.agency",
    );
  });

  test("leaves any other path as it is", () => {
    expect(sourcePathFor("/p/src/other.agency", [entry])).toBe("/p/src/other.agency");
  });
});
