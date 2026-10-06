// The inside of a `Root`. A root is a directory an approval named, spelled
// the way file effects spell their payloads: realpathed once, by `root` in
// nodeFiles.ts or by the host that made it. Every file operation on the
// host takes one; nothing takes a bare string root.
//
// Only files under lib/host may read `real`. Everything else asks the
// host for a path (`resolvePath`) or for the operation it wants. The lint
// rule in eslint.config.js refuses `.real` outside this directory.

import fs from "fs";
import type { Stats } from "fs";
import * as path from "path";
import process from "process";
import { expandPath } from "../stdlib/expandPath.js";

/** A directory an approval named, realpathed once. */
export type Root = { real: string };

/** The path inside a root. For files under lib/host. */
export function rootPath(root: Root): string {
  return root.real;
}

/** The root an approval already named, spelled the way the approver saw
 *  it. Where `root` resolves a caller's spelling before the interrupt,
 *  this runs after it and follows nothing: every existing component must
 *  be a real directory, and a symlink anywhere in the spelling is refused,
 *  because a link planted at the approved path while the prompt was
 *  pending would otherwise become the new root. Components that do not
 *  exist yet are kept as written. */
export function fixedRoot(real: string): Root {
  if (real === undefined || real === null || real.trim() === "") {
    throw new Error('dir must not be empty. Use "." for the current directory.');
  }
  const lexical = path.resolve(process.cwd(), expandPath(real));
  const parsed = path.parse(lexical);
  const segments = lexical
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((segment) => segment !== "");
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info: Stats;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { real: lexical };
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `refused: "${current}" is a symlink. The approved directory "${lexical}" must be spelled without links.`,
      );
    }
  }
  return { real: lexical };
}
