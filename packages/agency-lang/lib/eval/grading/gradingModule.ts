import { sha256Text } from "@/utils/hash.js";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

import { build, stop as stopEsbuild, type BuildOptions } from "esbuild";

import type { AgencyConfig } from "@/config.js";
import { getPackageRoot } from "@/importPaths.js";
import type { BaseGrader } from "./baseGrader.js";
import { toGrader, type Grader } from "./functionGrader.js";

let counter = 0;

/** A grading module bundled into one self-contained file: everything it
 *  imports inlined, except `agency-lang` itself. The hash names the revision. */
export type GradingBundle = { source: string; code: string; sha256: string };

/**
 * Load a user-authored TypeScript grading module and return its graders.
 * Bundles with esbuild (leaving `agency-lang` external so the user's
 * `import { grader } from "agency-lang/eval"` resolves to the installed
 * package), imports the default export, and normalizes it to BaseGrader[].
 */
export async function loadGradingModule(
  filePath: string,
  _config: AgencyConfig,
): Promise<BaseGrader[]> {
  const bundle = await bundleGradingModule(filePath);
  return importBundle(bundle, path.dirname(bundle.source));
}

/** Bundle a grading module without loading it. */
export async function bundleGradingModule(filePath: string): Promise<GradingBundle> {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Grading module not found: ${absolute}`);
  }
  const result = await buildSurvivingServiceDeath({
    entryPoints: [absolute],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    write: false,
    logLevel: "silent",
    external: ["agency-lang", "agency-lang/*"],
  });
  const code = result.outputFiles?.[0]?.text ?? "";
  return { source: absolute, code, sha256: sha256Text(code) };
}

/**
 * The files a run directory keeps so the run can be graded later, anywhere,
 * by the graders it was run with: the bundle, plus any file a grader reads
 * by path (a custom judge prompt). Names are content hashes. `judgeFiles`
 * maps each path as the grader declared it to its stored name.
 */
export type GradersSnapshot = {
  source: string;
  bundleFile: string;
  judgeFiles: Record<string, string>;
  files: { name: string; content: string }[];
};

/** Bundle a grading module and collect its external files. Loads the module
 *  once, so a broken module fails here, before any agent runs. */
export async function snapshotGradingModule(filePath: string): Promise<GradersSnapshot> {
  const bundle = await bundleGradingModule(filePath);
  const graders = await importBundle(bundle, path.dirname(bundle.source));
  const bundleFile = `${bundle.sha256}.mjs`;
  const files: GradersSnapshot["files"] = [{ name: bundleFile, content: bundle.code }];
  const judgeFiles: Record<string, string> = Object.create(null);
  for (const grader of graders) {
    for (const file of grader.externalFiles?.() ?? []) {
      if (judgeFiles[file] !== undefined) continue;
      const content = fs.readFileSync(path.resolve(file), "utf8");
      const name = `${sha256Text(content)}${path.extname(file)}`;
      judgeFiles[file] = name;
      if (!files.some((entry) => entry.name === name)) files.push({ name, content });
    }
  }
  return { source: bundle.source, bundleFile, judgeFiles, files };
}

/** What a run row records about its graders' snapshot: where the module
 *  came from, and the stored names under the run directory's `graders/`. */
export type RecordedGraders = {
  source: string;
  bundleFile: string;
  judgeFiles: Record<string, string>;
};

/** Load graders from a run directory's snapshot. The revision is the stored
 *  bundle's hash under the original source path, so a row graded from the
 *  snapshot and one graded live from the unchanged module agree. */
export async function loadGradingSnapshot(
  gradersDir: string,
  recorded: RecordedGraders,
): Promise<BaseGrader[]> {
  const bundlePath = path.join(gradersDir, recorded.bundleFile);
  if (!fs.existsSync(bundlePath)) {
    throw new Error(
      `Grading snapshot not found: ${bundlePath} (recorded for ${recorded.source}). ` +
        `Pass --graders <file> to grade with a module from disk.`,
    );
  }
  const code = fs.readFileSync(bundlePath, "utf8");
  const bundle: GradingBundle = { source: recorded.source, code, sha256: sha256Text(code) };
  const graders = await importBundle(bundle, gradersDir);
  for (const grader of graders) {
    for (const [original, stored] of Object.entries(recorded.judgeFiles)) {
      grader.rebindExternalFile?.(original, path.join(gradersDir, stored));
    }
  }
  return graders;
}

/** Write the bundle to a temp file and import it. The temp file goes in
 *  `nearDir` so the bundle's `agency-lang` import resolves from there; when
 *  that fails (a run directory copied outside any project), retry from this
 *  package's own root, where the name resolves to the package itself. */
async function importBundle(bundle: GradingBundle, nearDir: string): Promise<BaseGrader[]> {
  try {
    return await importBundleFrom(bundle, nearDir);
  } catch (err) {
    if (!isAgencyLangNotFound(err) || nearDir === getPackageRoot()) throw err;
    return importBundleFrom(bundle, getPackageRoot());
  }
}

async function importBundleFrom(bundle: GradingBundle, dir: string): Promise<BaseGrader[]> {
  counter += 1;
  const out = path.join(dir, `.agency-grading-${process.pid}-${counter}.mjs`);
  try {
    fs.writeFileSync(out, bundle.code);
    // eslint-disable-next-line no-restricted-syntax -- CLI-layer loading of a user artifact; the bundle path is only known at runtime
    const mod = await import(pathToFileURL(out).href);
    const exported = mod.default;
    if (exported === undefined) {
      throw new Error(
        `Grading module ${bundle.source} must default-export a grader or an array of graders ` +
          `(e.g. \`export default [...]\`).`,
      );
    }
    const specs: Grader[] = Array.isArray(exported) ? exported : [exported];
    // Name each grader by the module's revision, so a score row says which
    // version of graders.ts produced it and an in-place edit never supersedes
    // the rows an earlier version wrote.
    const revision = `${bundle.source}@${bundle.sha256}`;
    const graders = specs.map((spec) => {
      const grader = toGrader(spec);
      grader.revision = revision;
      return grader;
    });
    assertDistinctNames(graders, bundle.source);
    return graders;
  } finally {
    if (fs.existsSync(out)) fs.rmSync(out, { force: true });
  }
}

function isAgencyLangNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { code?: string }).code === "ERR_MODULE_NOT_FOUND" &&
    err.message.includes("agency-lang")
  );
}

/** Score rows are keyed by grader name, so two graders sharing one would
 *  silently overwrite each other's verdicts. Refuse at load time instead. */
function assertDistinctNames(graders: BaseGrader[], modulePath: string): void {
  const seen: Record<string, true> = Object.create(null);
  for (const grader of graders) {
    const name = grader.name();
    if (seen[name]) {
      throw new Error(
        `Grading module ${modulePath} has two graders named "${name}". Give each a distinct name ` +
          `(e.g. \`grader(fn, { name: "..." })\` or \`new LlmJudge({ name: "..." })\`), ` +
          `because scores are recorded per grader name.`,
      );
    }
    seen[name] = true;
  }
}

/**
 * esbuild runs a long-lived service subprocess, and a terminal Ctrl-C reaches
 * the whole process group — service included. An interrupted eval still
 * grades (partial results are the point of salvage-on-SIGINT), and that
 * grading may be the next build() call, which then fails with "The service is
 * no longer running": a killed service never restarts by itself. stop() +
 * retry once starts a fresh service; any other error, or a second failure,
 * propagates untouched.
 */
async function buildSurvivingServiceDeath(options: BuildOptions) {
  try {
    return await build(options);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("service is no longer running")) {
      throw err;
    }
    await stopEsbuild();
    return build(options);
  }
}
