import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { build } from "esbuild";
import * as nodeDefault from "./default.node.js";

// `#default-host` is resolved by the "imports" field of package.json. The
// unit tests see it through a vitest alias, so they cannot tell whether that
// field is right. This test bundles the built context.ts the way a program
// on Node would and reads which host esbuild pulled in.
//
// The field points at dist/, so this needs a build. CI runs `make ci` before
// the tests. Locally, run `make` first.
const packageRoot = path.resolve(import.meta.dirname, "../..");
const builtContext = path.join(packageRoot, "dist/lib/runtime/state/context.js");

async function bundleFor(platform: "browser" | "node"): Promise<string> {
  const result = await build({
    entryPoints: [builtContext],
    bundle: true,
    write: false,
    platform,
    format: "esm",
    // context.ts reaches most of the runtime, and on Node every module it
    // imports resolves. The test only reads which host file came in.
    absWorkingDir: packageRoot,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

// nodeHost.ts builds a host named "node"; nothing else in the bundle
// mentions that string next to makeHost.
const NODE_HOST_MARKER = 'name: "node"';

describe("#default-host resolution", () => {
  it.skipIf(!existsSync(builtContext))("a Node bundle takes nodeHost", async () => {
    const text = await bundleFor("node");
    expect(text).toContain(NODE_HOST_MARKER);
  });

  it("the Node file matches the declaration in packageImports.d.ts", () => {
    const declared: typeof import("#default-host") = nodeDefault;
    expect(declared.defaultHost().name).toBe("node");
  });
});
