// Checks that the lint rule for browser-reachable files covers every file a
// browser bundle of the runtime would contain. Part of `lint:structure`.
//
// It bundles lib/runtime/browser.ts and every stdlib helper with esbuild,
// treating the files in eslint.node-exceptions.mjs as leaves it does not
// enter, and reads the metafile. Then it fails when:
//
// 1. a file it reached is not matched by BROWSER_FILES in eslint.config.js,
//    so the rule never looks at it (add the file to BROWSER_FILES, or put
//    the importer on the list), or
// 2. a file it reached imports a file on NODE_ONLY, which would drag Node
//    code into the browser bundle. The "#" names (#default-host, #platform,
//    #sha256, #path) are left unresolved, since the browser build picks
//    another file for each; an import of the Node file behind one by its
//    own path is reported like any other.
//
// scripts/bundle-browser-smoke.mjs is the end-to-end check of the same
// thing: it bundles a compiled program for the browser and fails on any
// Node import.
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
import { NODE_ONLY } from "../eslint.node-exceptions.mjs";
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
const listed = nodeOnly.files;

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

/** The names the "imports" field of package.json resolves per platform.
 *  The bundle leaves them unresolved, so the metafile keeps the name. */
const PLATFORM_NAMES = ["#default-host", "#platform", "#sha256", "#path"];

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
        "lib/runtime/browser.ts",
        ...stdlibHelpers(),
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--packages=external",
        ...PLATFORM_NAMES.map((name) => `--external:${name}`),
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

for (const file of reached) {
  if (!covered(file)) {
    problems.push(
      `${file} is in the browser bundle but BROWSER_FILES in eslint.config.js does not cover it.`,
    );
  }
  for (const entry of meta.inputs[file].imports) {
    if (!entry.external) {
      continue;
    }
    const target = resolveImport(entry.path, outdir);
    if (target === null || !nodeOnly.files.includes(target)) {
      continue;
    }
    problems.push(
      `${file} imports ${target}, which is Node-only. Reach the platform through the host instead.`,
    );
  }
}

for (const pattern of nodeOnly.empty) {
  problems.push(`${pattern} is in eslint.node-exceptions.mjs but names no file. Remove it.`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `lint-browser-reach: the browser bundle reaches ${reached.length} files, all covered by the lint rule; ${nodeOnly.files.length} are Node-only.`,
);
