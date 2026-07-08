import { describe, expect, test } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  findCrossConfigConflicts,
  groupTestSources,
  precompileTestSources,
} from "./precompile.js";

const TRIVIAL = 'node main() {\n  return "ok"\n}\n';
const HELPER = 'export def helper(): string {\n  return "shared"\n}\n';
const IMPORTS_HELPER =
  'import { helper } from "../shared/helper.agency"\n\nnode main() {\n  return helper()\n}\n';

// Lay out a temp tree of test dirs. Spec: { "dirName": { files..., } }
function writeTree(spec: Record<string, Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agency-precompile-"));
  for (const [dir, files] of Object.entries(spec)) {
    const dirPath = path.join(root, dir);
    fs.mkdirSync(dirPath, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dirPath, name), contents);
    }
  }
  return root;
}

const TEST_JSON = JSON.stringify({ tests: [] });

describe("findCrossConfigConflicts", () => {
  test("no conflict when groups with the same config share a module", () => {
    const conflicts = findCrossConfigConflicts([
      { label: "a", configKey: "{}", modules: ["/shared.agency"] },
      { label: "b", configKey: "{}", modules: ["/shared.agency"] },
    ]);
    expect(conflicts).toEqual([]);
  });

  test("conflict when groups with differing configs share a module", () => {
    const conflicts = findCrossConfigConflicts([
      { label: "a", configKey: "{}", modules: ["/shared.agency", "/a.agency"] },
      { label: "b", configKey: '{"verbose":true}', modules: ["/shared.agency"] },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].module).toBe("/shared.agency");
    expect(conflicts[0].labels.sort()).toEqual(["a", "b"]);
  });

  test("no conflict when differing-config groups touch disjoint modules", () => {
    const conflicts = findCrossConfigConflicts([
      { label: "a", configKey: "{}", modules: ["/a.agency"] },
      { label: "b", configKey: '{"verbose":true}', modules: ["/b.agency"] },
    ]);
    expect(conflicts).toEqual([]);
  });
});

describe("groupTestSources", () => {
  test("files without a local agency.json land in one base group", () => {
    const root = writeTree({
      one: { "main.agency": TRIVIAL, "main.test.json": TEST_JSON },
      two: { "main.agency": TRIVIAL, "main.test.json": TEST_JSON },
    });
    const groups = groupTestSources({}, [
      path.join(root, "one/main.test.json"),
      path.join(root, "two/main.test.json"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].files.sort()).toEqual([
      path.join(root, "one/main.agency"),
      path.join(root, "two/main.agency"),
    ]);
  });

  test("a dir with a local agency.json becomes its own group with merged config", () => {
    const root = writeTree({
      plain: { "main.agency": TRIVIAL, "main.test.json": TEST_JSON },
      custom: {
        "main.agency": TRIVIAL,
        "main.test.json": TEST_JSON,
        "agency.json": JSON.stringify({ verbose: true }),
      },
    });
    const groups = groupTestSources({ observability: true }, [
      path.join(root, "plain/main.test.json"),
      path.join(root, "custom/main.test.json"),
    ]);
    expect(groups).toHaveLength(2);
    const custom = groups.find((g) => g.label.includes("custom"))!;
    expect(custom.config.verbose).toBe(true);
    expect(custom.config.observability).toBe(true);
    const base = groups.find((g) => !g.label.includes("custom"))!;
    expect(base.configKey).not.toBe(custom.configKey);
  });

  test("file-level skipped test files are excluded", () => {
    const root = writeTree({
      live: { "main.agency": TRIVIAL, "main.test.json": TEST_JSON },
      dead: {
        "main.agency": "this does not even parse {{{",
        "main.test.json": JSON.stringify({ skip: true, tests: [] }),
      },
    });
    const groups = groupTestSources({}, [
      path.join(root, "live/main.test.json"),
      path.join(root, "dead/main.test.json"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toEqual([path.join(root, "live/main.agency")]);
  });

  test("test files without a sibling .agency are excluded", () => {
    const root = writeTree({
      orphan: { "main.test.json": TEST_JSON },
    });
    const groups = groupTestSources({}, [
      path.join(root, "orphan/main.test.json"),
    ]);
    expect(groups).toEqual([]);
  });
});

describe("precompileTestSources", () => {
  test("compiles every entry and shared imports once, leaving .js siblings", () => {
    const root = writeTree({
      shared: { "helper.agency": HELPER },
      one: { "main.agency": IMPORTS_HELPER, "main.test.json": TEST_JSON },
      two: { "main.agency": IMPORTS_HELPER, "main.test.json": TEST_JSON },
    });
    precompileTestSources({}, [
      path.join(root, "one/main.test.json"),
      path.join(root, "two/main.test.json"),
    ]);
    expect(fs.existsSync(path.join(root, "one/main.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "two/main.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "shared/helper.js"))).toBe(true);
  });

  test("throws when a module is reachable from entries with differing configs", () => {
    const root = writeTree({
      shared: { "helper.agency": HELPER },
      plain: { "main.agency": IMPORTS_HELPER, "main.test.json": TEST_JSON },
      custom: {
        "main.agency": IMPORTS_HELPER,
        "main.test.json": TEST_JSON,
        "agency.json": JSON.stringify({ verbose: true }),
      },
    });
    expect(() =>
      precompileTestSources({}, [
        path.join(root, "plain/main.test.json"),
        path.join(root, "custom/main.test.json"),
      ]),
    ).toThrow(/helper\.agency/);
  });

  test("compiles test-only imports (allowTestImports)", () => {
    const root = writeTree({
      mod: { "lib.agency": 'def secret(): string {\n  return "s"\n}\n' },
      t: {
        "main.agency":
          'import test { secret } from "../mod/lib.agency"\n\nnode main() {\n  return secret()\n}\n',
        "main.test.json": TEST_JSON,
      },
    });
    precompileTestSources({}, [path.join(root, "t/main.test.json")]);
    expect(fs.existsSync(path.join(root, "t/main.js"))).toBe(true);
  });
});
