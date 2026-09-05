import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Where the compiled addon lives once built: outside node_modules, next to
 * the models, so a reinstall (or pnpm moving the package to a new store
 * directory when the lockfile changes) does not throw the build away.
 * Override with AGENCY_WHISPER_ADDON_DIR, like AGENCY_WHISPER_MODELS_DIR.
 */
export function resolveAddonDir(): string {
  const override = process.env.AGENCY_WHISPER_ADDON_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".agency/addons/whisper");
}

export type AddonTarget = {
  packageVersion: string;
  platform: string;
  arch: string;
  /** Node's ABI number (process.versions.modules): a new Node needs a new build. */
  abi: string;
};

/** The target the running process needs. */
export function currentAddonTarget(packageVersion: string): AddonTarget {
  return {
    packageVersion,
    platform: process.platform,
    arch: process.arch,
    abi: process.versions.modules,
  };
}

/**
 * The file name encodes everything the binary depends on, so a stale build
 * from another package version, machine, or Node is simply not found and
 * asked for again, rather than loaded and crashed into.
 */
export function addonFileName(target: AddonTarget): string {
  return `whisper_addon-${target.packageVersion}-${target.platform}-${target.arch}-abi${target.abi}.node`;
}

export function resolveAddonPath(
  target: AddonTarget,
  dir: string = resolveAddonDir(),
): string {
  return path.join(dir, addonFileName(target));
}

/** Where cmake-js leaves the build inside the package. */
export function buildOutputPath(pkgRoot: string): string {
  return path.join(pkgRoot, "build", "Release", "whisper_addon.node");
}

export function packageVersion(pkgRoot: string): string {
  const raw = readFileSync(path.join(pkgRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`No version in ${path.join(pkgRoot, "package.json")}`);
  }
  return parsed.version;
}
