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
//    code into the browser bundle, unless REACHES_NODE_ONLY lists that
//    import as one the browser entry point still has to cut; a listed
//    import that is gone fails too, so that list only gets shorter. An
//    import of the Node file behind a "#" name (#default-host, #sha256,
//    #path) is not one: the browser build picks the other file.
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
import { NODE_ONLY, REACHES_NODE_ONLY, WAITING } from "../eslint.node-exceptions.mjs";
import { BROWSER_FILES } from "../eslint.config.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under `dir`, relative to the package root. */
function filesUnder(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(path.relative(packageRoot, full));
      }
    }
  };
  walk(path.join(packageRoot, dir));
  return found.sort();
}

const libFiles = filesUnder("lib");

/** The files the patterns name. A pattern is a file path or a glob such
 *  as lib/host/node/**, and a pattern that names no file is reported. */
function expand(patterns) {
  const files = [];
  const empty = [];
  for (const pattern of patterns) {
    // Not `filter(isMatch)`: a picomatch matcher takes a second argument,
    // and filter would pass it the index.
    const isMatch = picomatch(pattern);
    const matched = libFiles.filter((file) => isMatch(file));
    if (matched.length === 0) {
      empty.push(pattern);
    }
    files.push(...matched);
  }
  return { files, empty };
}

const nodeOnly = expand(Object.keys(NODE_ONLY));
const waiting = expand(WAITING);
const listed = [...nodeOnly.files, ...waiting.files];

function stdlibHelpers() {
  return libFiles.filter(
    (file) =>
      file.startsWith("lib/stdlib/") &&
      !file.startsWith("lib/stdlib/__tests__/") &&
      file.endsWith(".ts") &&
      !file.endsWith(".test.ts") &&
      !listed.includes(file),
  );
}

/** The Node file behind each "#" name, which the aliases below point the
 *  bundle at. The browser condition picks another file for each, so an
 *  import of one is not an import of Node-only code. */
const PLATFORM_FILES = [
  "lib/host/node/default.node.ts",
  "lib/utils/sha256.node.ts",
  "lib/utils/path.node.ts",
];

/** The metafile of a bundle that stops at every listed file, and the
 *  output directory the bundle was written to, which the metafile's paths
 *  to external files are relative to. */
function bundleMetafile() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "agency-browser-reach-"));
  const metafile = path.join(scratch, "meta.json");
  const outdir = path.join(scratch, "out");
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
        "--alias:#default-host=./lib/host/node/default.node.ts",
        "--alias:#sha256=./lib/utils/sha256.node.ts",
        "--alias:#path=./lib/utils/path.node.ts",
        ...listed.map((file) => `--external:${path.join(packageRoot, file)}`),
        `--metafile=${metafile}`,
        `--outdir=${outdir}`,
        "--log-level=silent",
      ],
      { cwd: packageRoot, stdio: ["ignore", "ignore", "inherit"] },
    );
    return { meta: JSON.parse(readFileSync(metafile, "utf8")), outdir };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The source file an import of an external file names, relative to the
 *  package root, or null for a package import. The metafile writes the
 *  path of an external file relative to the output directory. */
function resolveImport(specifier, outdir) {
  if (specifier.startsWith("@/")) {
    return path.join("lib", specifier.slice(2)).replace(/\.js$/, ".ts");
  }
  if (!specifier.startsWith(".")) {
    return null;
  }
  const target = path.relative(packageRoot, path.resolve(outdir, specifier));
  const asSource = target.replace(/\.js$/, ".ts");
  return existsSync(path.join(packageRoot, asSource)) ? asSource : target;
}

const { meta, outdir } = bundleMetafile();
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
const seenReaches = [];

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
    const target = resolveImport(entry.path, outdir);
    if (target === null || PLATFORM_FILES.includes(target) || !nodeOnly.files.includes(target)) {
      continue;
    }
    if (REACHES_NODE_ONLY[file]?.includes(target)) {
      seenReaches.push(`${file} -> ${target}`);
      continue;
    }
    problems.push(
      `${file} imports ${target}, which is Node-only. Reach the platform through the host instead.`,
    );
  }
}

for (const [file, targets] of Object.entries(REACHES_NODE_ONLY)) {
  for (const target of targets) {
    if (!seenReaches.includes(`${file} -> ${target}`)) {
      problems.push(
        `${file} no longer imports ${target}. Remove that entry from REACHES_NODE_ONLY in eslint.node-exceptions.mjs.`,
      );
    }
  }
}

for (const pattern of [...nodeOnly.empty, ...waiting.empty]) {
  problems.push(`${pattern} is in eslint.node-exceptions.mjs but names no file. Remove it.`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `lint-browser-reach: the browser bundle reaches ${reached.length} files, all covered by the lint rule; ${nodeOnly.files.length} are Node-only, ${waiting.files.length} are waiting, and ${seenReaches.length} imports of a Node-only file remain to cut.`,
);
