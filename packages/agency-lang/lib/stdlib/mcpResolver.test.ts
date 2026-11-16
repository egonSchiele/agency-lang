import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { safeDeleteDirectoryWithin } from "../utils.js";

// The global roots come from `npm root -g`, which differs per machine. Each
// test sets the roots it needs.
const globalRoots: { list: string[] } = { list: [] };
vi.mock("../runtime/localProvider.js", () => ({
  globalNodeModulesRoots: () => globalRoots.list,
}));

import { isMcpAvailable, exposeResolvedMcpPath, resolveMcpEntry } from "./mcpResolver.js";

let tmpDir: string;

/** Write a fake @agency-lang/mcp into a global node_modules root under the
 *  temp dir, with an entry file at every path in `files`. */
function installGlobally(pkgJson: Record<string, unknown>, files: string[]): string {
  const root = path.join(tmpDir, "node_modules");
  const pkgDir = path.join(root, "@agency-lang", "mcp");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(pkgJson));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(pkgDir, file)), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, file), "export {};\n");
  }
  globalRoots.list = [root];
  return pkgDir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-mcp-resolver-"));
  globalRoots.list = [];
});

afterEach(() => {
  delete process.env.AGENCY_MCP_PATH;
  safeDeleteDirectoryWithin(os.tmpdir(), tmpDir);
});

describe("mcpResolver", () => {
  it("is unresolvable in a monorepo checkout with nothing installed globally", () => {
    // agency-lang does not depend on the package, so Node's node_modules walk
    // from here finds nothing. A real user installs it beside agency-lang or
    // globally.
    expect(resolveMcpEntry()).toBeNull();
    expect(isMcpAvailable()).toBe(false);
  });

  it("finds a global install whose exports only list an import entry", () => {
    // The shape @agency-lang/mcp publishes. require.resolve rejects it, so
    // the check used to say "not installed" for a working install.
    const pkgDir = installGlobally(
      {
        name: "@agency-lang/mcp",
        type: "module",
        main: "./index.js",
        exports: {
          ".": { types: "./dist/src/mcp.d.ts", import: "./dist/src/mcp.js" },
          "./package.json": "./package.json",
        },
      },
      ["index.js", "dist/src/mcp.js"],
    );
    expect(resolveMcpEntry()).toBe(path.join(pkgDir, "dist/src/mcp.js"));
    expect(isMcpAvailable()).toBe(true);
  });

  it("skips a require entry listed before the import entry", () => {
    const pkgDir = installGlobally(
      { exports: { require: "./cjs/mcp.cjs", import: "./esm/mcp.js" } },
      ["cjs/mcp.cjs", "esm/mcp.js"],
    );
    expect(resolveMcpEntry()).toBe(path.join(pkgDir, "esm/mcp.js"));
  });

  it("follows nested conditions down to the import entry", () => {
    const pkgDir = installGlobally(
      { exports: { ".": { node: { import: "./node/mcp.js", require: "./node/mcp.cjs" } } } },
      ["node/mcp.js", "node/mcp.cjs"],
    );
    expect(resolveMcpEntry()).toBe(path.join(pkgDir, "node/mcp.js"));
  });

  it("is unavailable when the exports give import() nothing to load", () => {
    installGlobally({ exports: { ".": { require: "./mcp.cjs" } } }, ["mcp.cjs"]);
    expect(resolveMcpEntry()).toBeNull();
  });

  it("is unavailable when the entry file is missing", () => {
    installGlobally({ exports: { ".": { import: "./dist/src/mcp.js" } } }, []);
    expect(resolveMcpEntry()).toBeNull();
  });

  it("uses main when the package has no exports", () => {
    const pkgDir = installGlobally({ main: "./lib/mcp.js" }, ["lib/mcp.js"]);
    expect(resolveMcpEntry()).toBe(path.join(pkgDir, "lib/mcp.js"));
  });

  it("honors the AGENCY_MCP_PATH override", () => {
    process.env.AGENCY_MCP_PATH = "/some/where/mcp.js";
    expect(resolveMcpEntry()).toBe("/some/where/mcp.js");
    expect(isMcpAvailable()).toBe(true);
  });

  it("exposeResolvedMcpPath is a no-op when unresolvable and idempotent when preset", () => {
    exposeResolvedMcpPath();
    expect(process.env.AGENCY_MCP_PATH).toBeUndefined();
    process.env.AGENCY_MCP_PATH = "/preset";
    exposeResolvedMcpPath();
    expect(process.env.AGENCY_MCP_PATH).toBe("/preset");
  });

  it("exposeResolvedMcpPath hands the bridge the entry it found", () => {
    const pkgDir = installGlobally({ exports: { import: "./mcp.js" } }, ["mcp.js"]);
    exposeResolvedMcpPath();
    expect(process.env.AGENCY_MCP_PATH).toBe(path.join(pkgDir, "mcp.js"));
  });
});
