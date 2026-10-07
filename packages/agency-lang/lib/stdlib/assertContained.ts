import path from "#path";
import type { Host } from "../host/host.js";
import { expandPath } from "./expandPath.js";
import { isContained } from "./isContained.js";

/**
 * The allow-list a program sets on itself: assert that `target` resolves
 * inside at least one of `allowedRoots`. Both sides are realpathed by
 * the host, so a target that reaches an allowed root only through a
 * symlink is judged by where it lands.
 *
 * Empty `allowedRoots` means no restriction, kept on purpose so adding
 * this check to a helper is additive. A non-empty list whose entries are
 * all blank throws rather than degrading to no restriction.
 *
 * Both target and roots resolve against the same `baseDir`, so a relative
 * entry such as `allowedPaths: ["src/"]` means the same directory the
 * tool is operating in. Each entry goes through `expandPath`, so
 * `allowedPaths: ["~/proj"]` matches paths under the home directory.
 */
export async function assertContained(
  host: Host,
  target: string,
  allowedRoots: string[],
  baseDir: string = host.system.cwd(),
): Promise<void> {
  if (allowedRoots.length === 0) {
    return;
  }
  if (target.trim() === "") {
    throw new Error("assertContained: target must not be empty");
  }
  const home = host.system.homeDir();
  const realTarget = await realOrLexical(host, path.resolve(baseDir, expandPath(target, home)));
  const realRoots: string[] = [];
  for (const entry of allowedRoots) {
    if (entry.trim() === "") {
      continue;
    }
    realRoots.push(await host.files.realDir(path.resolve(baseDir, expandPath(entry, home))));
  }
  if (realRoots.length === 0) {
    throw new Error(
      `assertContained: allowedPaths was set (${JSON.stringify(allowedRoots)}) but contained no usable entries; refusing to fall back to unrestricted access.`,
    );
  }
  if (realRoots.some((realRoot) => isContained(realTarget, realRoot))) {
    return;
  }
  throw new Error(
    `Path "${target}" is not under any of the allowed paths: ${allowedRoots.join(", ")}.`,
  );
}

/** A dangling link or a loop in the target's spelling is judged where it
 *  sits: its nearest resolvable ancestor is realpathed and the rest kept
 *  as written. The operation that follows refuses or hides it anyway. */
async function realOrLexical(host: Host, p: string): Promise<string> {
  try {
    return await host.files.realDir(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) {
      return p;
    }
    return path.join(await realOrLexical(host, parent), path.basename(p));
  }
}
