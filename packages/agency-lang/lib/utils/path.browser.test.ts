import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { build } from "esbuild";

// `#path` is resolved by the "imports" field of package.json. The unit
// tests see it through a vitest alias, so they cannot tell whether that
// field is right. This test bundles one import of `#path` from inside the
// package, the way a browser build would, and reads which module esbuild
// pulled in.
//
// The field points at dist/, so this needs a build. CI runs `make ci`
// before the tests. Locally, run `make` first.
const packageRoot = path.resolve(import.meta.dirname, "../..");
const builtNodePath = path.join(packageRoot, "dist/lib/utils/path.node.js");

async function bundleFor(platform: "browser" | "node"): Promise<string> {
  const result = await build({
    stdin: {
      contents: 'import p from "#path"; export default p;',
      resolveDir: packageRoot,
    },
    bundle: true,
    write: false,
    platform,
    format: "esm",
    // Left unresolved so the Node bundle builds; the test reads whether
    // it was imported.
    external: ["path"],
    absWorkingDir: packageRoot,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

// path-browserify defines normalizeStringPosix; the Node file imports
// `path`. Each marker appears in exactly one of the two.
const PORTABLE_MARKER = "normalizeStringPosix";
const NODE_MARKER = /from\s+"(node:)?path"/;

describe("#path resolution", () => {
  it.skipIf(!existsSync(builtNodePath))(
    "a browser bundle takes path-browserify and not Node's path",
    async () => {
      const text = await bundleFor("browser");
      expect(text).toContain(PORTABLE_MARKER);
      expect(text).not.toMatch(NODE_MARKER);
    },
  );

  it.skipIf(!existsSync(builtNodePath))("a Node bundle takes Node's path", async () => {
    const text = await bundleFor("node");
    expect(text).toMatch(NODE_MARKER);
    expect(text).not.toContain(PORTABLE_MARKER);
  });
});
