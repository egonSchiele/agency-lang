// Rewrite every `async` function in dist/ into promise code, so each `await`
// becomes a `.then` call. `make build` runs this after tsc.
//
// The runtime keeps its context with PromiseContextStorage, which restores
// the context inside `.then` callbacks. A real `await` is syntax that no
// library can attach to, so code that still has one loses its context at the
// first pause. See docs/dev/runtime/portable-context-spike.md.
//
// A file with a top-level `await` cannot be rewritten: esbuild refuses it.
// The build fails and names the file, unless the file is listed in
// TOP_LEVEL_AWAIT_ALLOWED below.
//
// Running this twice is safe. A rewritten file has no `async` left to
// rewrite.
import { transformSync } from "esbuild";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/rewrite-async.mjs <dist directory>");
  process.exit(2);
}

// Files that keep a real top-level `await`. Each is a program entry point
// that runs no Agency code in its own async functions.
const TOP_LEVEL_AWAIT_ALLOWED = [];

const REWRITE = { "async-await": false, "async-generator": false, "for-await": false };

function jsFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...jsFiles(full));
    } else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
      // A .js with a .agency beside it is the compiler's output. The
      // compiler rewrites it as it emits it (lib/compiler/transpile.ts).
      if (!existsSync(full.replace(/\.(js|mjs)$/, ".agency"))) {
        found.push(full);
      }
    }
  }
  return found;
}

const failures = [];
let rewritten = 0;
for (const file of jsFiles(root)) {
  const source = readFileSync(file, "utf-8");
  if (!/\basync\b|\bawait\b/.test(source)) {
    continue;
  }
  const name = relative(root, file);
  if (TOP_LEVEL_AWAIT_ALLOWED.includes(name)) {
    continue;
  }
  try {
    const result = transformSync(source, { loader: "js", format: "esm", supported: REWRITE });
    if (result.code !== source) {
      writeFileSync(file, result.code, "utf-8");
      rewritten += 1;
    }
  } catch (error) {
    const messages = (error.errors ?? []).map((e) => e.text).join("; ") || String(error);
    failures.push(`${name}: ${messages}`);
  }
}

if (failures.length > 0) {
  console.error("rewrite-async: could not rewrite these files:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(`rewrite-async: rewrote ${rewritten} files under ${root}`);
