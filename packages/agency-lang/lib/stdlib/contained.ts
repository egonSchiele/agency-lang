/**
 * Every file operation the standard library performs on a path an Agency
 * program chose goes through this module. The rule it enforces: under an
 * approval that names directory D, no byte is read from or written to any
 * path outside D. A symlink in the caller's own spelling of D (a linked
 * /tmp, a linked home) resolves normally, once, in `root`. A symlink at
 * any component below D is refused, because the approver never named
 * where it points.
 *
 * How strong that rule is depends on the operation. Reads and writes,
 * and `copy`, which is built on them, move bytes only through a
 * descriptor that is validated after it is open, so a directory swapped
 * to a link while the operation runs cannot redirect them. `list`,
 * `stat`, `mkdir`, `remove`, and `move` act on a pathname that was
 * checked a moment earlier. Node has no openat, so a swap between that
 * check and the action is not closed here. Process containment is the
 * answer for that window. See docs/dev/stdlib/contained-files.md.
 */
import fs from "fs";
import type { Stats } from "fs";
import * as path from "path";
import process from "process";
import { randomBytes } from "crypto";
import { expandPath } from "./expandPath.js";

/** A directory an approval named, realpathed once. Every operation in this
 *  module takes one. Nothing takes a bare string root. */
export type Root = { real: string };

/** A whole path the approval named, as its real parent plus a final name
 *  that is never followed. */
export type Located = { root: Root; target: string };

export function root(dir: string): Root {
  if (dir === undefined || dir === null || dir.trim() === "") {
    throw new Error('dir must not be empty. Use "." for the current directory.');
  }
  const lexical = path.resolve(process.cwd(), expandPath(dir));
  return { real: walkSpelling(lexical) };
}

/** The one realpath walker. Existing components are resolved through
 *  healthy symlinks. A dangling link or a loop fails closed. Only a
 *  missing component ends the walk, keeping the rest lexical, so a
 *  directory that does not exist yet still has a real spelling. */
function walkSpelling(target: string): string {
  const parsed = path.parse(target);
  const segments = target
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((segment) => segment !== "");
  let current = parsed.root;
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(current, segments[i]);
    let info: Stats;
    try {
      info = fs.lstatSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return path.join(next, ...segments.slice(i + 1));
    }
    if (!info.isSymbolicLink()) {
      current = next;
      continue;
    }
    try {
      current = fs.realpathSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`refused: "${next}" is a dangling symlink.`);
      }
      throw error;
    }
  }
  return current;
}

/** Join `target` under the root and validate it: no absolute path, no `~`,
 *  no upward escape, and no symlink at any component strictly below the
 *  root. Returns the absolute path to operate on. "" and "." mean the root
 *  itself. A component that does not exist yet is accepted lexically. */
export function resolveUnder(root: Root, target: string): string {
  const expanded = expandPath(target);
  if (path.isAbsolute(expanded)) {
    throw escapeError(target, root.real, expanded);
  }
  const lexical = path.resolve(root.real, expanded);
  if (!isContained(lexical, root.real)) {
    throw escapeError(target, root.real, lexical);
  }
  refuseLinksBelow(root.real, lexical);
  return lexical;
}

function refuseLinksBelow(realRoot: string, lexical: string): void {
  const relative = path.relative(realRoot, lexical);
  if (relative === "") {
    return;
  }
  let current = realRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let info: Stats;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `refused: "${current}" is a symlink. Symlinks below "${realRoot}" are not followed.`,
      );
    }
  }
}

function escapeError(target: string, realRoot: string, landed: string): Error {
  return new Error(
    `refused: "${target}" is outside dir "${realRoot}" (it resolves to "${landed}"). ` +
      `To reach it, pass that directory in dir.`,
  );
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

/** The whole-path twin of `fixedRoot`: the real parent the approver saw,
 *  checked to still be spelled without links, plus the final name. */
export function fixedPath(p: string): Located {
  if (p === undefined || p === null || p.trim() === "") {
    throw new Error("path must not be empty.");
  }
  const lexical = path.resolve(process.cwd(), expandPath(p));
  return { root: fixedRoot(path.dirname(lexical)), target: path.basename(lexical) };
}

/** Split a whole path into its real parent and final name. `mkdir`,
 *  `remove`, `copy`, `move`, and output files use this: the interrupt
 *  named the whole path, the parent is the root, and the final name is
 *  one component that is never followed. */
export function wholePath(p: string): Located {
  if (p === undefined || p === null || p.trim() === "") {
    throw new Error("path must not be empty.");
  }
  const lexical = path.resolve(process.cwd(), expandPath(p));
  return { root: root(path.dirname(lexical)), target: path.basename(lexical) };
}

/** True when `target` is `root` or sits inside it. Uses `path.relative` so
 *  a root of `/` works. Case-insensitive on Windows. */
export function isContained(target: string, root: string): boolean {
  const t = process.platform === "win32" ? target.toLowerCase() : target;
  const r = process.platform === "win32" ? root.toLowerCase() : root;
  if (t === r) {
    return true;
  }
  const rel = path.relative(r, t);
  if (rel === "") {
    return true;
  }
  if (path.isAbsolute(rel)) {
    return false;
  }
  return rel.split(path.sep)[0] !== "..";
}

/** The real spelling of a directory, for an interrupt payload. */
export function _realDir(dir: string): string {
  return root(dir).real;
}

/** The real spelling of a whole path, for an interrupt payload. */
export function _realTarget(p: string): string {
  const located = wholePath(p);
  return path.join(located.root.real, located.target);
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

export const WRITE_MODES = ["overwrite", "append", "create-only"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

/** Test-only hook that runs between the open and the validation of a
 *  descriptor, where a concurrent swap would land. */
export type Seams = { afterOpen?: () => void };

export type WriteOptions = { mode?: WriteMode; fileMode?: number; seams?: Seams };

const DEFAULT_FILE_MODE = 0o644;
const NO_FOLLOW = fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;

export function readText(root: Root, target: string, seams: Seams = {}): string {
  return readBytes(root, target, seams).toString("utf8");
}

/** Read through a validated descriptor: open without following a final
 *  link, require a regular file, realpath after the open and require it
 *  inside the root, and require the same (dev, ino) as the descriptor so a
 *  swap undone after the open is caught too. */
export function readBytes(root: Root, target: string, seams: Seams = {}): Buffer {
  const resolved = resolveUnder(root, target);
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    validateDescriptor(fd, root, resolved, seams, "read");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function validateDescriptor(
  fd: number,
  root: Root,
  resolved: string,
  seams: Seams,
  verb: string,
): Stats {
  const opened = fs.fstatSync(fd);
  if (!opened.isFile()) {
    throw new Error(`'${resolved}' is not a regular file`);
  }
  seams.afterOpen?.();
  const real = fs.realpathSync(resolved);
  if (!isContained(real, root.real) || real === root.real) {
    throw new Error(`'${resolved}' resolves to '${real}', which is outside '${root.real}'`);
  }
  const onDisk = fs.statSync(real);
  if (onDisk.dev !== opened.dev || onDisk.ino !== opened.ino) {
    throw new Error(`'${resolved}' changed between validation and ${verb}`);
  }
  return opened;
}

export function writeText(
  root: Root,
  target: string,
  content: string,
  options: WriteOptions = {},
): void {
  writeBytes(root, target, Buffer.from(content, "utf8"), options);
}

export function writeBytes(
  root: Root,
  target: string,
  data: Buffer,
  options: WriteOptions = {},
): void {
  const mode = options.mode ?? "overwrite";
  if (!WRITE_MODES.includes(mode)) {
    throw new Error(`Invalid mode '${mode}'. Must be one of: ${WRITE_MODES.join(", ")}.`);
  }
  const resolved = resolveUnder(root, target);
  const fileMode = options.fileMode ?? DEFAULT_FILE_MODE;
  const seams = options.seams ?? {};
  if (mode === "overwrite") {
    overwriteViaSibling(root, resolved, data, fileMode, seams);
    return;
  }
  const fd = openForWrite(root, resolved, mode, fileMode);
  try {
    validateDescriptor(fd, root, resolved, seams, "write");
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/** Open an existing file for append, or create a new one. A new file's
 *  parent is checked to be a real directory inside the root first, so a
 *  linked directory cannot receive a file. */
function openForWrite(root: Root, resolved: string, mode: WriteMode, fileMode: number): number {
  const appendFlags = fs.constants.O_WRONLY | fs.constants.O_APPEND | NO_FOLLOW;
  const createFlags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW;
  if (mode === "append") {
    try {
      return fs.openSync(resolved, appendFlags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  requireRealParent(root, resolved);
  try {
    return fs.openSync(resolved, createFlags, fileMode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`File already exists: '${resolved}' (mode is 'create-only').`);
    }
    throw error;
  }
}

function requireRealParent(root: Root, resolved: string): void {
  const parent = path.dirname(resolved);
  if (fs.lstatSync(parent).isSymbolicLink()) {
    throw new Error(`'${parent}' is a symlink`);
  }
  const realParent = fs.realpathSync(parent);
  if (!isContained(realParent, root.real)) {
    throw new Error(`'${parent}' resolves to '${realParent}', which is outside '${root.real}'`);
  }
}

/** Write the new content to a sibling temporary file and rename it over
 *  the target, so a write that fails part way leaves the old file whole.
 *  The temporary file is created exclusively in the validated parent and
 *  its descriptor is validated before any byte is written. */
function overwriteViaSibling(
  root: Root,
  resolved: string,
  data: Buffer,
  fileMode: number,
  seams: Seams,
): void {
  requireRealParent(root, resolved);
  const existingMode = modeOfExisting(resolved);
  const temp = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW;
  const fd = fs.openSync(temp, flags, existingMode ?? fileMode);
  let open = true;
  try {
    validateDescriptor(fd, root, temp, seams, "write");
    fs.writeFileSync(fd, data);
    fs.closeSync(fd);
    open = false;
    fs.renameSync(temp, resolved);
  } catch (error) {
    if (open) {
      fs.closeSync(fd);
    }
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** The mode bits of the file about to be replaced, or null when it does
 *  not exist. Opened without following a link, so a link at the target
 *  is treated as absent (resolveUnder has already refused it). */
function modeOfExisting(resolved: string): number | null {
  try {
    const fd = fs.openSync(resolved, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
      return fs.fstatSync(fd).mode & 0o777;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

export type Entry = { name: string; type: "file" | "dir" | "other"; size: number };

/** One level of a directory. Symlinked entries are left out: they are
 *  never followed, so there is nothing to say about them. */
export function list(root: Root, target: string): Entry[] {
  const resolved = resolveUnder(root, target);
  const entries: Entry[] = [];
  for (const name of fs.readdirSync(resolved)) {
    let info: Stats;
    try {
      info = fs.lstatSync(path.join(resolved, name));
    } catch {
      // The entry vanished between readdir and lstat. Nothing to list.
      continue;
    }
    if (info.isSymbolicLink()) {
      continue;
    }
    entries.push({ name, type: entryType(info), size: info.size });
  }
  return entries;
}

function entryType(info: Stats): Entry["type"] {
  if (info.isDirectory()) {
    return "dir";
  }
  if (info.isFile()) {
    return "file";
  }
  return "other";
}

/** lstat of a target under the root. Missing returns null. A symlink below
 *  the root also returns null: it is hidden, the way `list` hides it. The
 *  root itself is already real, so "." reports the directory. */
export function stat(root: Root, target: string): Stats | null {
  let resolved: string;
  try {
    resolved = resolveUnder(root, target);
  } catch (error) {
    if (/is a symlink/.test((error as Error).message)) {
      return null;
    }
    throw error;
  }
  try {
    return fs.lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function mkdir(root: Root, target: string): void {
  fs.mkdirSync(resolveUnder(root, target), { recursive: true });
}

export function remove(root: Root, target: string): void {
  fs.rmSync(resolveUnder(root, target), { recursive: true, force: true });
}

/** Copy a file or tree. Every file is read and written through a
 *  validated descriptor, and a symlink anywhere in the source tree is
 *  refused, so a copy can neither pull in bytes from outside the source
 *  nor plant a link at the destination. An existing destination file is
 *  replaced, as with cp. */
export function copy(from: Located, to: Located): void {
  const source = resolveUnder(from.root, from.target);
  const destination = resolveUnder(to.root, to.target);
  if (isContained(destination, source)) {
    throw new Error(`copy: destination '${destination}' is inside source '${source}'`);
  }
  let info: Stats;
  try {
    info = fs.lstatSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`copy: no such file or directory: '${source}'`);
    }
    throw error;
  }
  if (info.isDirectory()) {
    mkdir(to.root, to.target);
    for (const name of fs.readdirSync(source)) {
      copy(
        { root: from.root, target: path.join(from.target, name) },
        { root: to.root, target: path.join(to.target, name) },
      );
    }
    return;
  }
  if (!info.isFile()) {
    throw new Error(`copy: '${source}' is not a regular file or directory`);
  }
  writeBytes(to.root, to.target, readBytes(from.root, from.target), {
    fileMode: info.mode & 0o777,
  });
}

/** Rename within one filesystem, or copy and remove across two. */
export function move(from: Located, to: Located): void {
  const source = resolveUnder(from.root, from.target);
  const destination = resolveUnder(to.root, to.target);
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    copy(from, to);
    fs.rmSync(source, { recursive: true, force: true });
  }
}

/** Every operation this module performs. The symlink battery runs each
 *  one; adding an operation without a row here fails the registry test. */
export const PRIMITIVES = [
  "readText",
  "readBytes",
  "writeText",
  "writeBytes",
  "list",
  "stat",
  "mkdir",
  "remove",
  "copy",
  "move",
] as const;

/** Exports that are not operations: they resolve, they do not touch bytes. */
export const HELPERS = [
  "root",
  "fixedRoot",
  "resolveUnder",
  "wholePath",
  "fixedPath",
  "isContained",
  "_realDir",
  "_realTarget",
] as const;
