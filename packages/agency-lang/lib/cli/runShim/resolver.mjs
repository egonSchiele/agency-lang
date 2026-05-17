// ESM resolver hook that lets `node` find `agency-lang` and its transitive
// dependencies even when the agency-lang CLI is installed globally and the
// program being run lives outside any `node_modules` tree.
//
// Strategy: when the default resolver can't find a bare specifier, retry
// the resolution as if the importer lived inside the agency-lang package
// directory. Node then applies its standard resolution algorithm (conditional
// exports, format detection, etc.) using agency-lang's own `node_modules`.
//
// This file lives at <install-root>/dist/lib/cli/runShim/resolver.mjs, so
// `import.meta.url` is already inside the package — we just point parentURL
// at our own package.json's URL so Node walks up from there.
import { pathToFileURL, fileURLToPath } from "node:url";
import * as path from "node:path";

// Walk up to the package root (the directory containing package.json) and
// build a fake parent URL inside it.
const thisFile = fileURLToPath(import.meta.url);
const installRoot = path.resolve(thisFile, "..", "..", "..", "..", "..");
const fakeParentURL = pathToFileURL(
  path.join(installRoot, "package.json"),
).href;

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND") {
      // Retry resolution as if the import came from inside agency-lang.
      // If this also fails, fall through and rethrow the original error so
      // the user sees the message about their actual import.
      try {
        return await nextResolve(specifier, {
          ...context,
          parentURL: fakeParentURL,
        });
      } catch {
        /* fall through */
      }
    }
    throw err;
  }
}
