// ESM resolver hook that lets `node` find the `agency-lang` package (and
// its subpaths) even when the agency-lang CLI is installed globally and
// the program being run lives outside any `node_modules` tree.
//
// Strategy: when the default resolver can't find an `agency-lang` or
// `agency-lang/<sub>` specifier, retry as if the importer lived inside
// the agency-lang package itself. Node then resolves via that package's
// own `node_modules`.
//
// The fallback is **scoped strictly to `agency-lang` specifiers**. We do
// NOT retry for arbitrary bare imports (e.g. `lodash`) or relative paths
// (`./foo.js`), because doing so would silently mask the user's own
// missing-import mistakes by resolving them from inside agency-lang.
//
// This file lives at <install-root>/dist/lib/cli/runShim/resolver.mjs, so
// `import.meta.url` is already inside the package — we just point parentURL
// at our own package.json's URL so Node walks up from there.
import { pathToFileURL, fileURLToPath } from "node:url";
import * as path from "node:path";

const thisFile = fileURLToPath(import.meta.url);
const installRoot = path.resolve(thisFile, "..", "..", "..", "..", "..");
const fakeParentURL = pathToFileURL(
  path.join(installRoot, "package.json"),
).href;

function isAgencyLangSpecifier(specifier) {
  return specifier === "agency-lang" || specifier.startsWith("agency-lang/");
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND" && isAgencyLangSpecifier(specifier)) {
      // Retry only for agency-lang specifiers. If this also fails,
      // fall through and rethrow the original error.
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
