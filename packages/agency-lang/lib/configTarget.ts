import * as fs from "fs";
import * as path from "path";
import { loadConfigSafe, validateConfig, type ConfigResult } from "./config.js";
import { mergeConfig } from "./configMerge.js";

export const CONFIG_FILE = "agency.json";
/** Per-developer overrides, kept out of git. Merged over CONFIG_FILE. */
export const LOCAL_CONFIG_FILE = "agency.local.json";

/** Where config comes from: one named file, or a project directory's
 *  agency.json with agency.local.json merged over it. */
export type ConfigTarget = { kind: "file"; path: string } | { kind: "project"; dir: string };

export function fileTarget(filePath: string): ConfigTarget {
  return { kind: "file", path: filePath };
}

export function projectTarget(dir: string): ConfigTarget {
  return { kind: "project", dir };
}

export function configTarget(cliConfig: string | undefined, fallback: ConfigTarget): ConfigTarget {
  return cliConfig === undefined ? fallback : fileTarget(cliConfig);
}

/** Every file the target could read, base file first. */
export function targetPaths(target: ConfigTarget): string[] {
  if (target.kind === "file") {
    return [target.path];
  }
  return [CONFIG_FILE, LOCAL_CONFIG_FILE].map((name) => path.join(target.dir, name));
}

export function configFiles(target: ConfigTarget): string[] {
  return targetPaths(target).filter((file) => fs.existsSync(file));
}

export function hasProjectConfig(dir: string): boolean {
  return configFiles(projectTarget(dir)).length > 0;
}

/** The single file a writer reads and writes. Never agency.local.json. */
export function writeTarget(target: ConfigTarget): string {
  return target.kind === "file" ? target.path : path.join(target.dir, CONFIG_FILE);
}

/**
 * The config to use. A project's merged result is validated again. That
 * checks rules that span both files, and puts keys in schema order, which
 * deriveConfigKey depends on.
 */
export function readConfig(target: ConfigTarget): ConfigResult {
  if (target.kind === "file") {
    return loadConfigSafe(target.path);
  }
  const [basePath, localPath] = targetPaths(target);
  const base = loadConfigSafe(basePath);
  if (base.error !== undefined) {
    return base;
  }
  const local = loadConfigSafe(localPath);
  if (local.error !== undefined) {
    return local;
  }
  const merged = mergeConfig(base.config, local.config);
  return validateConfig(merged, `${basePath} merged with ${localPath}`);
}

/** The nearest directory at or above `startPath` that has a config file. */
export function findProjectRoot(startPath: string): string | null {
  const startIsDir = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory();
  const start = startIsDir ? startPath : path.dirname(startPath);
  if (hasProjectConfig(start)) {
    return start;
  }
  const parent = path.dirname(start);
  return parent === start ? null : findProjectRoot(parent);
}
