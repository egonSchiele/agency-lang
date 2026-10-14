// Bundles the two programs under tests/browser for the browser, the way an
// app would, and fails when the bundle still needs Node. Part of CI
// (.github/workflows/browser.yml) and the headless test in
// tests/browser/browser.test.ts, which loads the bundle it writes.
//
// The programs are compiled with the built compiler, so run `make` first.
// esbuild resolves "agency-lang/runtime" and the "#" names through the
// "browser" condition of package.json. smoltalk 0.17.0 bundles for the
// browser on its own. Two of its dependencies still need help:
//
// - @anthropic-ai/sdk does `await import("node:fs")` and
//   `await import("node:path")` on its credential path
//   (lib/credentials/credential-chain.mjs and three files beside it), taken
//   when no API key is passed. Those two specifiers are left external, and
//   the check below allows them only as dynamic imports, which never run
//   when a key is passed.
// - smoltalk's embed/ollama.js imports "ollama" by name, where the rest of
//   smoltalk goes through its "#ollama" entry and gets ollama's browser
//   build. The alias sends that import to the browser build too. Drop it
//   once smoltalk ships egonSchiele/smoltalk#69.
//
// Two more packages need a stand-in, each under tests/browser/shims: tarsec
// imports `process` and `child_process` at load for its tracing, and
// typestache reads the global `process`, so a `process` with an empty env
// and a `child_process` that throws make them take their browser path.
//
// `node scripts/bundle-browser-smoke.mjs` writes tests/browser/out/bundle.js
// and prints its size.
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { builtinModules } from "module";
import path from "path";
import { fileURLToPath } from "url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const programs = ["tests/browser/hello.agency", "tests/browser/ask.agency"];
const entry = "tests/browser/entry.mjs";
const outDir = path.join(packageRoot, "tests/browser/out");
export const bundlePath = path.join(outDir, "bundle.js");

export function bundleSmokeProgram() {
  if (!existsSync(path.join(packageRoot, "dist/scripts/agency.js"))) {
    throw new Error("dist/ is missing: run `make` before the browser bundle check.");
  }
  for (const program of programs) {
    execFileSync("node", ["dist/scripts/agency.js", "compile", program], {
      cwd: packageRoot,
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    path.join(packageRoot, "node_modules/.bin/esbuild"),
    [
      entry,
      "--bundle",
      "--platform=browser",
      "--format=esm",
      "--alias:ollama=ollama/browser",
      "--external:node:fs",
      "--external:node:path",
      "--alias:process=./tests/browser/shims/process.mjs",
      "--alias:child_process=./tests/browser/shims/child_process.mjs",
      "--inject:./tests/browser/shims/process.mjs",
      `--outfile=${bundlePath}`,
      "--log-level=warning",
    ],
    { cwd: packageRoot, stdio: ["ignore", "ignore", "inherit"] },
  );
  const text = readFileSync(bundlePath, "utf8");
  // esbuild fails on an import it cannot resolve, which on the browser
  // platform every Node module is. This catches a module left external.
  // The two allowed externals may appear only as the SDK's dynamic
  // imports; a static import of either would run at load and fail.
  const dynamicAllowed = ["node:fs", "node:path"];
  const nodeModules = builtinModules.flatMap((name) => [name, `node:${name}`]);
  const left = nodeModules.filter(
    (name) =>
      text.includes(`from "${name}"`) ||
      text.includes(`require("${name}")`) ||
      (!dynamicAllowed.includes(name) && text.includes(`import("${name}")`)),
  );
  if (left.length > 0) {
    throw new Error(`The browser bundle still imports Node modules: ${left.join(", ")}`);
  }
  return { bundlePath, bytes: statSync(bundlePath).size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { bytes } = bundleSmokeProgram();
  console.log(`browser bundle: ${bundlePath} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
}
