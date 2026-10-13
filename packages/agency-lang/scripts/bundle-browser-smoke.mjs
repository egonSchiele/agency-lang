// Bundles tests/browser/hello.agency for the browser, the way an app
// would, and fails when the bundle still needs Node. Part of CI
// (.github/workflows/lint.yml) and the headless test in
// tests/browser/browser.test.ts, which loads the bundle it writes.
//
// The program is compiled with the built compiler, so run `make` first.
// esbuild resolves "agency-lang/runtime" and the "#" names through the
// "browser" condition of package.json. Three packages still need help,
// each with a file under tests/browser/shims: smoltalk imports fs, path,
// and url (a change in the smoltalk repo; until then the stand-in there
// throws on any model call); tarsec imports `process` and `child_process`
// at load for its tracing, and typestache reads the global `process`, so
// a `process` with an empty env and a `child_process` that throws make
// them take their browser path.
//
// `node scripts/bundle-browser-smoke.mjs` writes tests/browser/out/bundle.js
// and prints its size.
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { builtinModules } from "module";
import path from "path";
import { fileURLToPath } from "url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const program = "tests/browser/hello.agency";
const entry = "tests/browser/entry.mjs";
const outDir = path.join(packageRoot, "tests/browser/out");
export const bundlePath = path.join(outDir, "bundle.js");

export function bundleSmokeProgram() {
  if (!existsSync(path.join(packageRoot, "dist/scripts/agency.js"))) {
    throw new Error("dist/ is missing: run `make` before the browser bundle check.");
  }
  execFileSync("node", ["dist/scripts/agency.js", "compile", program], {
    cwd: packageRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    path.join(packageRoot, "node_modules/.bin/esbuild"),
    [
      entry,
      "--bundle",
      "--platform=browser",
      "--format=esm",
      "--alias:smoltalk=./tests/browser/shims/smoltalk.mjs",
      "--alias:process=./tests/browser/shims/process.mjs",
      "--alias:child_process=./tests/browser/shims/child_process.mjs",
      "--inject:./tests/browser/shims/process.mjs",
      `--outfile=${bundlePath}`,
      "--log-level=warning",
      // The stand-in lacks the names the runtime reaches through the
      // smoltalk namespace at call time; they are undefined on purpose.
      "--log-override:import-is-undefined=silent",
    ],
    { cwd: packageRoot, stdio: ["ignore", "ignore", "inherit"] },
  );
  const text = readFileSync(bundlePath, "utf8");
  // esbuild fails on an import it cannot resolve, which on the browser
  // platform every Node module is. This catches a module left external.
  const nodeModules = builtinModules.flatMap((name) => [name, `node:${name}`]);
  const left = nodeModules.filter(
    (name) => text.includes(`from "${name}"`) || text.includes(`require("${name}")`),
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
