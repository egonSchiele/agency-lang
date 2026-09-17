import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  compileOutputsWarning,
  moduleTypeWarning,
  nearestPackageJson,
} from "./moduleTypeWarning.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

const tempDirs: string[] = [];

// A project root with a package.json, and a nested `out/` folder the
// compiled file lands in.
function makeProject(packageJson: string | null): { root: string; output: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agency-module-type-"));
  tempDirs.push(root);
  if (packageJson !== null) fs.writeFileSync(path.join(root, "package.json"), packageJson);
  fs.mkdirSync(path.join(root, "out"));
  return { root, output: path.join(root, "out", "main.js") };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) safeDeleteDirectoryWithin(os.tmpdir(), dir);
});

describe("moduleTypeWarning", () => {
  it("warns when the nearest package.json says commonjs, naming that file", () => {
    const { root, output } = makeProject(JSON.stringify({ type: "commonjs" }));
    const warning = moduleTypeWarning(output);
    expect(warning).toContain(path.join(root, "package.json"));
    expect(warning).toContain('"type": "commonjs"');
    expect(warning).toContain("outDir");
  });

  it("says nothing when the package.json says module", () => {
    const { output } = makeProject(JSON.stringify({ type: "module" }));
    expect(moduleTypeWarning(output)).toBeNull();
  });

  // Node detects module syntax here and prints its own warning.
  it("says nothing when the package.json has no type field", () => {
    const { output } = makeProject(JSON.stringify({ name: "demo" }));
    expect(moduleTypeWarning(output)).toBeNull();
  });

  it("says nothing when the package.json is not valid JSON", () => {
    const { output } = makeProject("{ not json");
    expect(moduleTypeWarning(output)).toBeNull();
  });

  it("uses the closest package.json, not one further up", () => {
    const { root, output } = makeProject(JSON.stringify({ type: "commonjs" }));
    fs.writeFileSync(path.join(root, "out", "package.json"), JSON.stringify({ type: "module" }));
    expect(moduleTypeWarning(output)).toBeNull();
  });
});

describe("nearestPackageJson", () => {
  it("walks up from the file's directory", () => {
    const { root, output } = makeProject("{}");
    expect(nearestPackageJson(output)).toBe(path.join(root, "package.json"));
  });
});

describe("compileOutputsWarning", () => {
  const commonjs = JSON.stringify({ type: "commonjs" });
  const esm = JSON.stringify({ type: "module" });

  it("says nothing for a directory with no .agency files, even under commonjs", () => {
    const { root } = makeProject(commonjs);
    expect(compileOutputsWarning({}, [path.join(root, "out")])).toBeNull();
  });

  it("finds a commonjs package.json nested inside a compiled directory", () => {
    const { root } = makeProject(esm);
    const nested = path.join(root, "out", "legacy");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "package.json"), commonjs);
    fs.writeFileSync(path.join(nested, "helper.agency"), "");
    const warning = compileOutputsWarning({}, [root]);
    expect(warning).toContain(path.join(nested, "package.json"));
  });

  // The output lands in outDir, so the source's own package.json is not
  // the one Node reads.
  it("checks the outDir location, not the source location", () => {
    const { root } = makeProject(commonjs);
    const source = path.join(root, "main.agency");
    fs.writeFileSync(source, "");
    fs.writeFileSync(path.join(root, "out", "package.json"), esm);
    expect(compileOutputsWarning({}, [source])).not.toBeNull();
    expect(compileOutputsWarning({ outDir: path.join(root, "out") }, [source])).toBeNull();
  });
});
