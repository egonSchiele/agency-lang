// Checks that the lint rule for browser-reachable files covers every file a
// browser bundle of the runtime would contain. Part of `lint:structure`.
//
// It bundles lib/runtime/index.ts and every stdlib helper with esbuild,
// treating the files in eslint.node-exceptions.mjs as leaves it does not
// enter, and reads the metafile. Then it fails when:
//
// 1. a file it reached is not matched by BROWSER_FILES in eslint.config.js,
//    so the rule never looks at it (add the file to BROWSER_FILES, or put
//    the importer on a list), or
// 2. a file it reached imports a file on NODE_ONLY, which would drag Node
//    code into the browser bundle.
//
// `node scripts/lint-browser-reach.mjs --list` prints the files it reached
// instead of checking them.
//
// It runs the esbuild command, not the JavaScript API: with the esbuild
// version in the repo, the API fails to parse its own metafile ("Unexpected
// end of JSON input"), and inside vitest it hangs. The command writes the
// metafile itself.
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import picomatch from "picomatch";
import { NODE_ONLY, WAITING } from "../eslint.node-exceptions.mjs";
import { BROWSER_FILES } from "../eslint.config.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeOnly = Object.keys(NODE_ONLY);
const listed = [...nodeOnly, ...WAITING];

function stdlibHelpers() {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(path.relative(packageRoot, full));
      }
    }
  };
  walk(path.join(packageRoot, "lib/stdlib"));
  return found.filter((file) => !listed.includes(file)).sort();
}

/** The metafile of a bundle that stops at every listed file. */
function bundleMetafile() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "agency-browser-reach-"));
  const metafile = path.join(scratch, "meta.json");
  try {
    execFileSync(
      path.join(packageRoot, "node_modules/.bin/esbuild"),
      [
        "lib/runtime/index.ts",
        ...stdlibHelpers(),
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--packages=external",
        "--alias:#default-host=./lib/host/default.node.ts",
        "--alias:#sha256=./lib/utils/sha256.node.ts",
        ...listed.map((file) => `--external:${path.join(packageRoot, file)}`),
        `--metafile=${metafile}`,
        `--outdir=${path.join(scratch, "out")}`,
        "--log-level=silent",
      ],
      { cwd: packageRoot, stdio: ["ignore", "ignore", "inherit"] },
    );
    return JSON.parse(readFileSync(metafile, "utf8"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The source file an import specifier in `importer` names, relative to
 *  the package root, or null for a package import. */
function resolveImport(importer, specifier) {
  let target;
  if (specifier.startsWith("@/")) {
    target = path.join("lib", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    target = path.join(path.dirname(importer), specifier);
  } else {
    return null;
  }
  const asSource = target.replace(/\.js$/, ".ts");
  return existsSync(path.join(packageRoot, asSource)) ? asSource : target;
}

const meta = bundleMetafile();
// lib/templates holds files generated from .mustache templates, which ESLint
// ignores; they import typestache and nothing else.
const reached = Object.keys(meta.inputs)
  .filter((file) => file.startsWith("lib/") && !file.startsWith("lib/templates/"))
  .sort();
if (process.argv.includes("--list")) {
  console.log(reached.join("\n"));
  process.exit(0);
}
const covered = picomatch(BROWSER_FILES);
const problems = [];

for (const file of reached) {
  if (!covered(file)) {
    problems.push(
      `${file} is in the browser bundle but BROWSER_FILES in eslint.config.js does not cover it.`,
    );
  }
  // The entry point is per platform: lib/runtime/index.ts is Node's and
  // may import Node-only files, because lib/runtime/browser.ts stands in
  // for it in a browser bundle with portable exports.
  if (file === "lib/runtime/index.ts") {
    continue;
  }
  for (const entry of meta.inputs[file].imports) {
    if (!entry.external) {
      continue;
    }
    const target = resolveImport(file, entry.path);
    if (target && nodeOnly.includes(target)) {
      problems.push(
        `${file} imports ${target}, which is Node-only. Reach the platform through the host instead.`,
      );
    }
  }
}

for (const file of listed) {
  if (!existsSync(path.join(packageRoot, file))) {
    problems.push(`${file} is in eslint.node-exceptions.mjs but does not exist. Remove it.`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `lint-browser-reach: the browser bundle reaches ${reached.length} files, all covered by the lint rule; ${nodeOnly.length} are Node-only and ${WAITING.length} are waiting.`,
);
