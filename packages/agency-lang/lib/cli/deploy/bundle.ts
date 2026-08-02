// Turning an entrypoint into the set of `.agency` source files to upload, and
// checking they compile. Statelog stores uploaded files flat (one directory,
// keyed by basename) and its filenames can't contain slashes, so a hosted
// agent's local imports must all be same-directory `.agency` siblings — this
// module gathers exactly that set and refuses anything statelog can't host.

import fs from "fs";
import path from "path";
import type { AgencyConfig } from "@/config.js";
import { parseAgency } from "@/parser.js";
import { compileSource } from "@/compiler/compile.js";
import {
  agencyImportTargets,
  nonAgencyLocalImportTargets,
  resolveAgencyImportPath,
} from "@/importPaths.js";

export type BundleFile = {
  /** Upload key — the basename, which is all statelog's flat store keeps. */
  name: string;
  contents: string;
  /** Real on-disk path — passed as `sourcePath` so the pre-flight compile
   *  resolves this file's relative imports against its siblings. */
  absPath: string;
};

export type AgencyBundle = {
  /** Basename of the entrypoint file, echoed as the upload's `entrypoint`. */
  entrypoint: string;
  files: BundleFile[];
};

export type CollectBundleResult =
  | { ok: true; bundle: AgencyBundle }
  | { ok: false; error: string };

/**
 * Collect the entrypoint and every local `.agency` file it imports
 * (transitively) into one flat bundle. Refuses agents statelog cannot host:
 * imports that resolve outside the entrypoint's directory (the flat store can't
 * represent subpaths), and local TypeScript/JavaScript interop imports (the
 * server only compiles `.agency` source).
 */
export function collectAgencyBundle(
  entrypointPath: string,
  config: AgencyConfig,
): CollectBundleResult {
  const entrypointAbs = path.resolve(entrypointPath);
  if (!fs.existsSync(entrypointAbs)) {
    return { ok: false, error: `Entrypoint not found: ${entrypointAbs}` };
  }
  const rootDir = path.dirname(entrypointAbs);

  const collected: Record<string, BundleFile> = {};
  const queue: string[] = [entrypointAbs];

  while (queue.length > 0) {
    const fileAbs = queue.pop()!;
    if (collected[fileAbs]) {
      continue;
    }
    if (!fs.existsSync(fileAbs)) {
      return { ok: false, error: `Imported file not found: ${fileAbs}` };
    }

    const name = path.basename(fileAbs);
    const contents = fs.readFileSync(fileAbs, "utf-8");
    const parsed = parseAgency(contents, config);
    if (!parsed.success) {
      return { ok: false, error: `Parse error in ${name}: ${parsed.message ?? "invalid Agency source"}` };
    }
    collected[fileAbs] = { name, contents, absPath: fileAbs };

    const interop = nonAgencyLocalImportTargets(parsed.result);
    if (interop.length > 0) {
      return {
        ok: false,
        error:
          `${name} imports local code ${interop.map((target) => `"${target}"`).join(", ")}. ` +
          `Hosted agents can only use .agency files (statelog compiles the source it hosts); ` +
          `local TypeScript/JavaScript interop can't be deployed.`,
      };
    }

    for (const importPath of agencyImportTargets(parsed.result, { localOnly: true })) {
      const importAbs = resolveAgencyImportPath(importPath, fileAbs);
      if (path.dirname(importAbs) !== rootDir) {
        return {
          ok: false,
          error:
            `${name} imports "${importPath}", which resolves outside the entrypoint's directory. ` +
            `Hosted agents must keep all .agency files in one directory (statelog stores them flat).`,
        };
      }
      queue.push(importAbs);
    }
  }

  return {
    ok: true,
    bundle: { entrypoint: path.basename(entrypointAbs), files: Object.values(collected) },
  };
}

export type ValidateResult = { ok: true } | { ok: false; error: string };

/**
 * Compile each bundle file locally for fast feedback before the upload. Each is
 * compiled at its real path (`sourcePath`), so a file's relative `.agency`
 * imports resolve against its siblings — the same way statelog compiles them.
 * A pass here is a pre-flight, not a guarantee the server (which may run a
 * different agency-lang) accepts it.
 */
export function validateBundleCompiles(
  bundle: AgencyBundle,
  config: AgencyConfig,
): ValidateResult {
  const failures = bundle.files
    .map((file) => ({
      file,
      result: compileSource(file.contents, { ...config, sourcePath: file.absPath }),
    }))
    .filter(
      (entry): entry is { file: BundleFile; result: { success: false; errors: string[] } } =>
        !entry.result.success,
    );

  if (failures.length === 0) {
    return { ok: true };
  }

  const detail = failures
    .map(({ file, result }) => `  ${file.name}: ${result.errors.join("; ")}`)
    .join("\n");
  return { ok: false, error: `Compilation failed before upload:\n${detail}` };
}
