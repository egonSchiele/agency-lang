import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { NODE_ONLY } from "../../eslint.node-exceptions.mjs";
import { NODE_ONLY_STDLIB_MODULES } from "./nodeOnlyModules.js";
import { typecheckSource } from "./testUtils.js";

function agencyFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return agencyFilesUnder(full);
    }
    return entry.name.endsWith(".agency") ? [full] : [];
  });
}

/** Whether a lib path is on the NODE_ONLY list, as a file or under a
 *  directory glob such as lib/host/node/**. */
function isNodeOnly(libPath: string): boolean {
  return Object.keys(NODE_ONLY).some((entry) =>
    entry.endsWith("/**") ? libPath.startsWith(entry.slice(0, -2)) : entry === libPath,
  );
}

/** The stdlib modules whose source imports a helper on the NODE_ONLY
 *  list: `import { x } from "agency-lang/stdlib-lib/ui.js"` is
 *  lib/stdlib/ui.ts. */
function derivedNodeOnlyModules(): string[] {
  const stdlib = path.join(process.cwd(), "stdlib");
  const modules: string[] = [];
  for (const file of agencyFilesUnder(stdlib)) {
    const source = fs.readFileSync(file, "utf8");
    const helpers = [...source.matchAll(/from\s+"agency-lang\/stdlib-lib\/([^"]+)\.js"/g)].map(
      (match) => `lib/stdlib/${match[1]}.ts`,
    );
    if (helpers.some(isNodeOnly)) {
      modules.push("std::" + path.relative(stdlib, file).replace(/\.agency$/, ""));
    }
  }
  return modules.sort();
}

describe("NODE_ONLY_STDLIB_MODULES", () => {
  it("is the list of stdlib modules whose source imports a NODE_ONLY helper", () => {
    expect([...NODE_ONLY_STDLIB_MODULES].sort()).toEqual(derivedNodeOnlyModules());
  });
});

describe("importing a Node-only module", () => {
  const browser = { platform: "browser" as const };
  const nodeOnlyErrors = (src: string) =>
    typecheckSource(src, browser)
      .filter((error) => error.code === "AG7009")
      .map((error) => error.message);

  it("is an error when the platform is the browser", () => {
    expect(nodeOnlyErrors('import { choice } from "std::ui"\nnode main() {}')).toEqual([
      "'std::ui' works only on Node. The browser platform cannot import it.",
    ]);
  });

  it("is fine on Node", () => {
    const errors = typecheckSource('import { choice } from "std::ui"\nnode main() {}');
    expect(errors.filter((error) => error.code === "AG7009")).toEqual([]);
  });

  it("leaves a portable module alone", () => {
    expect(nodeOnlyErrors('import { fetchJSON } from "std::http"\nnode main() {}')).toEqual([]);
  });
});
