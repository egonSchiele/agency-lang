import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import picomatch from "picomatch";
import { NODE_ONLY } from "../../eslint.node-exceptions.mjs";
import * as nodeEntry from "./index.js";
import * as browserEntry from "./browser.js";

// The generated header imports a fixed list of names from
// "agency-lang/runtime". Both entry points must export every one, and the
// browser entry must replace exactly the names Node's entry takes from a
// Node-only file: a stand-in too few fails a browser bundle, one too many
// hides a portable export behind a refusal.
const HEADER_PATH = path.resolve(
  process.cwd(),
  "lib/templates/backends/typescriptGenerator/imports.mustache",
);
const INDEX_PATH = path.resolve(process.cwd(), "lib/runtime/index.ts");
const BROWSER_PATH = path.resolve(process.cwd(), "lib/runtime/browser.ts");

/** The local names the header binds from "agency-lang/runtime", as the
 *  runtime exports them: `a as b` counts as `a`. */
function headerValueImports(): string[] {
  const header = readFileSync(HEADER_PATH, "utf8");
  const block = header.match(/^import \{([^}]*)\} from "agency-lang\/runtime";/ms);
  if (block === null) {
    throw new Error("the header has no value import from agency-lang/runtime");
  }
  return block[1]
    .split(",")
    .map((entry) => entry.trim().split(/\s+as\s+/)[0])
    .filter((name) => name.length > 0);
}

/** The names index.ts exports from a Node-only file. */
function nodeOnlyExports(): string[] {
  const isNodeOnly = Object.keys(NODE_ONLY).map((pattern) => picomatch(pattern));
  const names: string[] = [];
  const source = readFileSync(INDEX_PATH, "utf8");
  for (const match of source.matchAll(/^export (type )?\{([^}]*)\} from "([^"]+)";/gms)) {
    const file = path.join("lib/runtime", match[3]).replace(/\.js$/, ".ts");
    if (!isNodeOnly.some((matches) => matches(file))) {
      continue;
    }
    for (const entry of match[2].split(",")) {
      const name = entry
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name !== undefined && name.length > 0) {
        names.push(name);
      }
    }
  }
  return names;
}

/** The names browser.ts exports itself, beside what portable.ts gives it:
 *  its stand-ins and its platform twins. */
function browserOwnExports(): string[] {
  const source = readFileSync(BROWSER_PATH, "utf8");
  const names = [...source.matchAll(/^export const (\w+)/gm)].map((match) => match[1]);
  for (const match of source.matchAll(/^export \{([^}]*)\} from "([^"]+)";/gms)) {
    if (match[2] === "./portable.js") {
      continue;
    }
    for (const entry of match[1].split(",")) {
      const name = entry
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name !== undefined && name.length > 0) {
        names.push(name);
      }
    }
  }
  return names;
}

describe("the browser entry point", () => {
  const names = headerValueImports();
  const nodeOnly = nodeOnlyExports();

  it("exports every name the header imports", () => {
    for (const name of names) {
      expect(browserEntry, name).toHaveProperty(name);
    }
  });

  it("replaces exactly the header names that come from a Node-only file", () => {
    const replaced = browserOwnExports();
    const expected = names.filter((name) => nodeOnly.includes(name));
    expect(replaced.sort()).toEqual(expected.sort());
  });

  it("shares every other header name with the Node entry point", () => {
    const replaced = browserOwnExports();
    for (const name of names) {
      if (replaced.includes(name)) {
        continue;
      }
      expect((browserEntry as Record<string, unknown>)[name], name).toBe(
        (nodeEntry as Record<string, unknown>)[name],
      );
    }
  });

  it("stand-ins refuse with the host error, naming the function", () => {
    expect(() => browserEntry.runCliEntry()).toThrow("runCliEntry needs the terminal capability");
    expect(() => browserEntry._runFor()).toThrow("_runFor needs the subprocess capability");
  });

  it("sees a header import with an alias", () => {
    expect(headerValueImports()).toContain("_runFor");
    expect(headerValueImports()).toContain("runCliEntry");
  });
});
