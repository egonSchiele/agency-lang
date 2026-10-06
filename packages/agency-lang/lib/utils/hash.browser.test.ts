import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { build } from "esbuild";

// `#sha256` is resolved by the "imports" field of package.json. The unit
// tests see it through a vitest alias, so they cannot tell whether that field
// is right. This test bundles the built hash.js the way a browser build would
// and reads which implementation esbuild pulled in.
//
// The field points at dist/, so this needs a build. CI runs `make ci` before
// the tests. Locally, run `make` first.
const packageRoot = path.resolve(import.meta.dirname, "../..");
const builtHash = path.join(packageRoot, "dist/lib/utils/hash.js");

async function bundleFor(platform: "browser" | "node"): Promise<string> {
  const result = await build({
    entryPoints: [builtHash],
    bundle: true,
    write: false,
    platform,
    format: "esm",
    // Left unresolved so the Node bundle builds; the test reads whether it
    // was imported.
    external: ["crypto"],
    absWorkingDir: packageRoot,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

// The portable file defines the SHA-256 round constants; the Node file
// imports crypto. Each marker appears in exactly one of the two.
const PORTABLE_MARKER = "ROUND_CONSTANTS";
const NODE_MARKER = /from\s+"(node:)?crypto"/;

describe("#sha256 resolution", () => {
  it.skipIf(!existsSync(builtHash))(
    "a browser bundle takes the portable file and no Node crypto",
    async () => {
      const text = await bundleFor("browser");
      expect(text).toContain(PORTABLE_MARKER);
      expect(text).not.toMatch(NODE_MARKER);
    },
  );

  it.skipIf(!existsSync(builtHash))("a Node bundle takes the Node file", async () => {
    const text = await bundleFor("node");
    expect(text).toMatch(NODE_MARKER);
    expect(text).not.toContain(PORTABLE_MARKER);
  });
});
