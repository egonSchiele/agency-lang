import { describe, it, expect } from "vitest";
import { findPackageRoot, resolveAgencyImportPath } from "./importPaths.js";
import * as path from "path";

describe("findPackageRoot", () => {
  it("should find the package root from a nested directory", () => {
    // __dirname is inside lib/, package root is one level up
    const root = findPackageRoot(__dirname);
    expect(root).toBe(path.resolve(__dirname, ".."));
    // Verify package.json exists there
    expect(
      require("fs").existsSync(path.join(root, "package.json")),
    ).toBe(true);
  });
});

describe("resolveAgencyImportPath", () => {
  it("should resolve relative imports against the importing file's directory", () => {
    const result = resolveAgencyImportPath(
      "./utils.agency",
      "/project/src/main.agency",
    );
    expect(result).toBe("/project/src/utils.agency");
  });

  it("should resolve std:: imports to the stdlib directory", () => {
    const result = resolveAgencyImportPath(
      "std::math",
      "/project/src/main.agency",
    );
    const root = findPackageRoot(__dirname);
    expect(result).toBe(path.join(root, "stdlib", "math.agency"));
  });

  it("should resolve std:: imports with subdirectories", () => {
    const result = resolveAgencyImportPath(
      "std::collections/queue",
      "/project/src/main.agency",
    );
    const root = findPackageRoot(__dirname);
    expect(result).toBe(
      path.join(root, "stdlib", "collections", "queue.agency"),
    );
  });

  it("should leave non-agency, non-std imports unchanged", () => {
    const result = resolveAgencyImportPath(
      "./utils.js",
      "/project/src/main.agency",
    );
    expect(result).toBe("/project/src/utils.js");
  });
});
