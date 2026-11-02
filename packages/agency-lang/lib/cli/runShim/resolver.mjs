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
const fakeParentURL = pathToFileURL(path.join(installRoot, "package.json")).href;

function isAgencyLangSpecifier(specifier) {
  return specifier === "agency-lang" || specifier.startsWith("agency-lang/");
}

// Modern hooks resolve synchronously; older Node versions return promises.
function attemptResolution(operation, onError) {
  try {
    const result = operation();
    return result instanceof Promise ? result.catch(onError) : result;
  } catch (err) {
    return onError(err);
  }
}

export function resolve(specifier, context, nextResolve) {
  return attemptResolution(
    () => nextResolve(specifier, context),
    (err) => {
      if (err?.code !== "ERR_MODULE_NOT_FOUND" || !isAgencyLangSpecifier(specifier)) {
        throw err;
      }
      // Retry only for agency-lang specifiers, preserving the original error.
      return attemptResolution(
        () =>
          nextResolve(specifier, {
            ...context,
            parentURL: fakeParentURL,
          }),
        (innerErr) => {
          if (process.env.AGENCY_DEBUG_RESOLVER) {
            const msg = innerErr && innerErr.message ? innerErr.message : String(innerErr);
            process.stderr.write(`[agency resolver] fallback failed for ${specifier}: ${msg}\n`);
          }
          throw err;
        },
      );
    },
  );
}
