/**
 * Trusted modules: directories of `.agency` modules a host vouches for, and
 * the directories their compiled JavaScript is in. The sandbox stops
 * checking at a trusted module and the child imports the host's compiled
 * file. See docs/dev/runtime/trusted-modules.md.
 *
 * This file holds the pure parts: the type, resolving a config entry to
 * real paths, finding the entry a file belongs to, and mapping a source
 * file to its compiled file. It lives in lib/compiler, outside the browser
 * lint scope, because resolving a path reads the filesystem.
 */
import * as fs from "fs";
import * as path from "path";
import { isStrictDescendant } from "@/utils.js";

/** A directory of `.agency` modules the host vouches for, and the directory
 *  their compiled JavaScript is in. As written in config they may be
 *  relative; once resolved they are absolute real paths. */
export type TrustedModules = { source: string; compiled: string };

export type ResolvedTrustedModules =
  { ok: true; value: TrustedModules[] } | { ok: false; error: string };

/** Resolve each entry's paths against `baseDir` to real paths. A directory
 *  that does not exist, or is reached through a symlink, fails with the
 *  entry as written and the path it resolved to. */
export function resolveTrustedModules(
  entries: TrustedModules[],
  baseDir: string,
): ResolvedTrustedModules {
  let realBase: string;
  try {
    realBase = fs.realpathSync(path.resolve(baseDir));
  } catch (error) {
    return {
      ok: false,
      error: `trusted modules: '${baseDir}' cannot be resolved: ${messageOf(error)}`,
    };
  }
  const resolved: TrustedModules[] = [];
  for (const entry of entries) {
    const source = resolveDirectory(entry.source, realBase, entry, "source");
    if (!source.ok) return source;
    const compiled = resolveDirectory(entry.compiled, realBase, entry, "compiled");
    if (!compiled.ok) return compiled;
    resolved.push({ source: source.value, compiled: compiled.value });
  }
  return { ok: true, value: resolved };
}

function resolveDirectory(
  written: string,
  realBase: string,
  entry: TrustedModules,
  field: "source" | "compiled",
): { ok: true; value: string } | { ok: false; error: string } {
  const label = `trusted modules entry { source: '${entry.source}', compiled: '${entry.compiled}' }`;
  const absolute = path.resolve(realBase, written);
  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    return { ok: false, error: `${label}: ${field} directory '${absolute}' does not exist` };
  }
  if (real !== absolute) {
    return {
      ok: false,
      error: `${label}: ${field} directory '${absolute}' goes through a symlink (it is really '${real}'); name the real path`,
    };
  }
  if (!fs.statSync(real).isDirectory()) {
    return { ok: false, error: `${label}: ${field} '${absolute}' is not a directory` };
  }
  return { ok: true, value: real };
}

/** The entry under whose `source` the real path `file` sits, or null. */
export function trustedEntryFor(file: string, entries: TrustedModules[]): TrustedModules | null {
  return entries.find((entry) => isStrictDescendant(entry.source, file)) ?? null;
}

/** The compiled file for a trusted `.agency` source: `source` swapped for
 *  `compiled`, `.agency` swapped for `.js`. */
export function compiledPathFor(file: string, entry: TrustedModules): string {
  const relative = path.relative(entry.source, file);
  return path.join(entry.compiled, relative.replace(/\.agency$/, ".js"));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
