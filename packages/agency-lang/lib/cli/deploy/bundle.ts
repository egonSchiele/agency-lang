// Turning an entrypoint into the `.agency` source to upload, and checking it
// compiles. Deploy is single-file for now: statelog compiles each uploaded file
// in isolation (agencyCompiler/serveHost both use `compileSource`, which loses
// the file's location and so can't resolve relative imports), so an agent that
// imports another local `.agency` file cannot be hosted yet. This module refuses
// what statelog can't serve. Multi-file is tracked in statelog#9.

import fs from "fs";
import path from "path";
import type { AgencyConfig } from "@/config.js";
import { parseAgency } from "@/parser.js";
import { compileSource } from "@/compiler/compile.js";
import {
  agencyImportTargets,
  nonAgencyLocalImportTargets,
} from "@/importPaths.js";

export type BundleFile = {
  /** Upload key — the basename, which is all statelog's flat store keeps. */
  name: string;
  contents: string;
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
 * Collect the single-file bundle for an entrypoint. Refuses agents statelog
 * cannot host: local TypeScript/JavaScript interop imports (the server only
 * compiles `.agency` source), and — for now — any local `.agency` import
 * (multi-file hosting is blocked on statelog#9).
 */
export function collectAgencyBundle(
  entrypointPath: string,
  config: AgencyConfig,
): CollectBundleResult {
  const entrypointAbs = path.resolve(entrypointPath);
  if (!fs.existsSync(entrypointAbs)) {
    return { ok: false, error: `File not found: ${entrypointAbs}` };
  }
  const name = path.basename(entrypointAbs);
  const contents = fs.readFileSync(entrypointAbs, "utf-8");

  const parsed = parseAgency(contents, config);
  if (!parsed.success) {
    return { ok: false, error: `Parse error in ${name}: ${parsed.message ?? "invalid Agency source"}` };
  }

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

  const localAgencyImports = agencyImportTargets(parsed.result, { localOnly: true });
  if (localAgencyImports.length > 0) {
    return {
      ok: false,
      error:
        `${name} imports ${localAgencyImports.map((target) => `"${target}"`).join(", ")}. ` +
        `Deploy is single-file for now — hosted multi-file agents aren't supported yet ` +
        `(statelog compiles each file in isolation). Tracking: statelog#9.`,
    };
  }

  return { ok: true, bundle: { entrypoint: name, files: [{ name, contents }] } };
}

export type ValidateResult = { ok: true } | { ok: false; error: string };

/**
 * Compile each bundle file locally for fast feedback before the upload, mirroring
 * statelog's per-file server compile. A pass here is a pre-flight, not a
 * guarantee the server — which may run a different agency-lang — accepts it.
 */
export function validateBundleCompiles(
  bundle: AgencyBundle,
  config: AgencyConfig,
): ValidateResult {
  const failures = bundle.files
    .map((file) => ({ file, result: compileSource(file.contents, config) }))
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
