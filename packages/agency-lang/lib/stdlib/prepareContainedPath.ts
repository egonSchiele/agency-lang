import fs from "fs/promises";
import path from "path";
import { resolveDir } from "./resolveDir.js";
import { expandPath } from "./expandPath.js";
import { isContained } from "./assertContained.js";

export type ContainedPath = {
  dir: string;
  filename: string;
};

export type FileOperation = "read" | "write";

/**
 * Prepare a (dir, filename) pair for a scoped single-file wrapper: the
 * returned values go into BOTH the interrupt payload and the execution.
 * Guarantees the spec's containment contract: the resolved file operand
 * stays inside the resolved dir operand, or this throws before any
 * interrupt exists. See 2026-08-20-contained-filename-spec.md.
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
  const baseDir = await resolveDir(dir);
  const realRoot = await fs.realpath(baseDir);

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
  const resolved = await resolveExistingStrict(lexical);
  if (!isContained(resolved, realRoot)) {
    throw escapeError(operation, filename, realRoot, resolved);
  }

  // Step 10: the real dir plus the normalized relative filename. The
  // relative form deliberately keeps in-root symlink names (spec: the
  // payload guarantees containment, not leaf-target naming).
  return { dir: realRoot, filename: path.relative(realRoot, lexical) };
}

/** Walk the target path component by component. Existing components are
 *  realpathed (following healthy symlinks); a component whose lstat says
 *  "symlink" but whose realpath fails is dangling and fails closed; a
 *  component that simply does not exist ends the walk, and the remaining
 *  tail is appended lexically (missing intermediates are contained, not
 *  dangling).
 *
 *  This deliberately does not reuse assertContained.ts's
 *  realpathOrLexicalAncestor: that older helper treats every realpath
 *  error as a missing path, while this safety boundary may treat only
 *  ENOENT as a lexical tail — loops, non-directories, permission and I/O
 *  failures all fail closed. Do not add a second strict walk elsewhere;
 *  reuse this one. */
async function resolveExistingStrict(target: string): Promise<string> {
  const parsed = path.parse(target);
  const segments = target.slice(parsed.root.length).split(path.sep);
  let current = parsed.root;
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(current, segments[i]);
    let stat;
    try {
      stat = await fs.lstat(next);
    } catch (error) {
      // Only ENOENT means the rest is a lexical tail. Permission, I/O,
      // ELOOP, and ENOTDIR failures fail closed.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return path.join(next, ...segments.slice(i + 1));
    }
    if (stat.isSymbolicLink()) {
      try {
        current = await fs.realpath(next);
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
 * Where a safeBash redirect will actually land. safeBash has no trusted
 * dir — the whole command is one untrusted string — so instead of
 * containment this resolves the COMPLETE target (healthy final symlinks
 * included, via the same strict walk: dangling links, loops, and
 * non-directories fail closed) and splits it, so the payload's dir is the
 * real parent the policy should judge. tildeMode is quote-aware: an
 * unquoted `~/f` expands, a quoted one stays a literal filename.
 */
export async function resolveRedirectTarget(
  target: string,
  cwd: string,
  tildeMode: TildeMode,
): Promise<ContainedPath> {
  if (cwd.trim() === "") {
    throw new Error("redirect refused: cwd must not be empty.");
  }
  const baseDir = await resolveDir(cwd);
  const expanded = tildeMode === "expand" ? expandPath(target) : target;
  const lexical = path.resolve(baseDir, expanded);
  const resolved = await resolveExistingStrict(lexical);
  return { dir: path.dirname(resolved), filename: path.basename(resolved) };
}
