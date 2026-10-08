import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { build } from "esbuild";
import * as nodeDefault from "./default.node.js";
import * as browserDefault from "../default.browser.js";

// `#default-host` is resolved by the "imports" field of package.json. The
// unit tests see it through a vitest alias, so they cannot tell whether that
// field is right. This test bundles the built context.ts the way a program
// on Node would and reads which host esbuild pulled in.
//
// The field points at dist/, so this needs a build. CI runs `make ci` before
// the tests. Locally, run `make` first.
const packageRoot = path.resolve(import.meta.dirname, "../../..");
const builtContext = path.join(packageRoot, "dist/lib/runtime/state/context.js");

async function bundleFor(platform: "browser" | "node"): Promise<string> {
  const result = await build({
    entryPoints: [builtContext],
    bundle: true,
    write: false,
    platform,
    format: "esm",
    // Packages stay outside the bundle: smoltalk and the model SDKs it
    // loads import Node modules, which a browser build cannot resolve. The
    // test only reads which host file came in.
    packages: "external",
    absWorkingDir: packageRoot,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

// Each host file builds a host with its name; nothing else in a bundle
// mentions that string next to makeHost.
const NODE_HOST_MARKER = 'name: "node"';
const BROWSER_HOST_MARKER = 'name: "browser"';

describe("#default-host resolution", () => {
  it.skipIf(!existsSync(builtContext))("a Node bundle takes nodeHost", async () => {
    const text = await bundleFor("node");
    expect(text).toContain(NODE_HOST_MARKER);
    expect(text).not.toContain(BROWSER_HOST_MARKER);
  });

  it.skipIf(!existsSync(builtContext))("a browser bundle takes browserHost", async () => {
    const text = await bundleFor("browser");
    expect(text).toContain(BROWSER_HOST_MARKER);
    expect(text).not.toContain(NODE_HOST_MARKER);
  });

  it("both files match the declaration in packageImports.d.ts", () => {
    const node: typeof import("#default-host") = nodeDefault;
    expect(node.defaultHost().name).toBe("node");
    const browser: typeof import("#default-host") = browserDefault;
    expect(browser.defaultHost().name).toBe("browser");
  });
});
