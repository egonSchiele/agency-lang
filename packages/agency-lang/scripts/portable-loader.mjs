// SPIKE: rewrite `async` functions into promise code as each module loads.
//
// The promise-tracking context store (lib/runtime/platform/
// promiseContextStorage.ts) only works on code whose `await`s have been
// turned into `.then` calls. A real portable build would do that once, at
// build time. This hook does it at load time instead, so the existing tests
// can run against it with no change to the compiler or to dist/.
//
// Use:
//   AGENCY_PORTABLE_CONTEXT=1 \
//   NODE_OPTIONS="--import /abs/path/to/scripts/portable-loader.mjs" \
//   node ./dist/scripts/agency.js test tests/agency/handlers
//
// NODE_OPTIONS is inherited, so subprocesses are rewritten too.
//
// AGENCY_PORTABLE_SCOPE picks what is rewritten:
//   "ours" (default)  everything outside node_modules
//   "all"             node_modules as well
//   "none"            nothing; shows what breaks with no rewrite
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scope = process.env.AGENCY_PORTABLE_SCOPE ?? "ours";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(packageRoot, ".spike", "lower-cache");
mkdirSync(cacheDir, { recursive: true });

function inScope(url) {
  if (scope === "none" || !url.startsWith("file:")) {
    return false;
  }
  if (url.includes("/node_modules/typescript/")) {
    return false;
  }
  return scope === "all" || !url.includes("/node_modules/");
}

function hasAsync(source) {
  return /\basync\b/.test(source);
}

function lower(source, format) {
  const key = createHash("sha1").update(format).update(source).digest("hex");
  const cached = join(cacheDir, key + ".js");
  if (existsSync(cached)) {
    return readFileSync(cached, "utf-8");
  }
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2016,
      // Leave imports, exports, and require calls exactly as written.
      module: format === "commonjs" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
      allowJs: true,
      esModuleInterop: false,
      // A top-level `await` is not inside an async function, so it is left
      // alone. Nothing at module top level reads the context.
    },
  });
  writeFileSync(cached, result.outputText, "utf-8");
  return result.outputText;
}

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!inScope(url)) {
      return loaded;
    }
    if (loaded.format !== "module" && loaded.format !== "commonjs") {
      return loaded;
    }
    if (loaded.source === null || loaded.source === undefined) {
      return loaded;
    }
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf-8");
    if (!hasAsync(source)) {
      return loaded;
    }
    return { ...loaded, source: lower(source, loaded.format) };
  },
});
