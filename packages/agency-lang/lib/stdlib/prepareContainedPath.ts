import fs from "fs";
import path from "path";
import { resolveCwdPath } from "./resolveDir.js";
import { expandPath } from "./expandPath.js";
import { isContained } from "./assertContained.js";

export type ContainedPath = {
  dir: string;
  filename: string;
};

export type FileOperation = "read" | "write";

/**
 * Prepare a (dir, filename) pair for a scoped single-file wrapper: the
 * returned values feed both the interrupt payload and the execution, and
 * any escape throws before an interrupt exists. Spec:
 * 2026-08-20-contained-filename-spec.md.
 */
export async function prepareContainedPath(
  dir: string,
  filename: string,
  operation: FileOperation,
): Promise<ContainedPath> {
  if (dir.trim() === "") {
    throw new Error(`${operation} refused: dir must not be empty.`);
  }
  // Steps 1-2: expand, absolutize, and realpath dir. It must exist.
  // Sync fs throughout this module (async signature kept so rejections
  // stay rejections): preparation runs between a wrapper's call and its
  // interrupt, and real awaits there would hand the event loop to
  // concurrent branches — enough for a fork sibling to finish and pop
  // its handler before the interrupt is raised.
  const realRoot = fs.realpathSync(resolveCwdPath(dir));

  // Steps 3-4: expand filename; absolute (including ~-led) is an escape.
  const expanded = expandPath(filename);
  if (path.isAbsolute(expanded)) {
    throw escapeError(operation, filename, realRoot, expanded);
  }

  // Steps 5-6: lexical resolution and lexical containment.
  const lexical = path.resolve(realRoot, expanded);
  if (!isContained(lexical, realRoot)) {
    throw escapeError(operation, filename, realRoot, lexical);
  }

  // Steps 7-9: resolve through existing symlinks (dangling ones fail
  // closed) and check the resolved target too.
  const resolved = resolveExistingStrict(lexical);
  if (!isContained(resolved, realRoot)) {
    throw escapeError(operation, filename, realRoot, resolved);
  }

  // Step 10: the real dir plus the normalized relative filename. The
  // relative form deliberately keeps in-root symlink names (spec: the
  // payload guarantees containment, not leaf-target naming).
  return { dir: realRoot, filename: path.relative(realRoot, lexical) };
}

/** The strict walk: realpath existing components (healthy symlinks
 *  follow), fail closed on dangling links, loops, non-directories, and
 *  permission errors; only ENOENT ends the walk with a lexical tail.
 *  That error taxonomy is why this cannot reuse the more forgiving
 *  realpathOrLexicalAncestor in assertContained.ts — reuse THIS walk
 *  rather than adding another. */
function resolveExistingStrict(target: string): string {
  const parsed = path.parse(target);
  const segments = target.slice(parsed.root.length).split(path.sep);
  let current = parsed.root;
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(current, segments[i]);
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return path.join(next, ...segments.slice(i + 1));
    }
    if (stat.isSymbolicLink()) {
      try {
        current = fs.realpathSync(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        throw new Error(`refused: "${next}" is a dangling symlink.`);
      }
    } else {
      current = next;
    }
  }
  return current;
}

function escapeError(
  operation: FileOperation,
  filename: string,
  root: string,
  landed: string,
): Error {
  const preposition = operation === "write" ? "somewhere else" : "from somewhere else";
  return new Error(
    `${operation} refused: filename "${filename}" is outside dir "${root}" ` +
      `(it resolves to "${landed}"). To ${operation} ${preposition}, pass that ` +
      `directory in dir.`,
  );
}

export type TildeMode = "expand" | "literal";

/**
 * Where a safeBash redirect will actually land: the complete target
 * resolved through the strict walk, split into real parent + name so the
 * payload's dir is the destination the policy judges. No containment —
 * safeBash has no trusted dir. tildeMode is quote-aware: unquoted
 * expands, quoted stays literal.
 */
export async function resolveRedirectTarget(
  target: string,
  cwd: string,
  tildeMode: TildeMode,
): Promise<ContainedPath> {
  if (cwd.trim() === "") {
    throw new Error("redirect refused: cwd must not be empty.");
  }
  const baseDir = resolveCwdPath(cwd);
  const expanded = tildeMode === "expand" ? expandPath(target) : target;
  const lexical = path.resolve(baseDir, expanded);
  const resolved = resolveExistingStrict(lexical);
  return { dir: path.dirname(resolved), filename: path.basename(resolved) };
}
