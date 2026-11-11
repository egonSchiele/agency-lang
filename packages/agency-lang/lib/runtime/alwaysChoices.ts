import path from "#path";
import { sameScopedFields, type ScopedField } from "./alwaysScope.js";
import type { EffectSetInfo } from "./effectSets.js";
import { isContained } from "../stdlib/isContained.js";

// What the approval prompt in std::policy offers beyond "approve once":
// the words for a rule's scope, the folders a read rule may cover, and
// the effect set one answer may cover. Pure: the prompt passes in the
// registry, the sets, and the run's directories.

/** Effect sets whose members only read local files, each with the words
 *  the prompt's set-wide answer uses for it: "always approve all reads in".
 *  An effect in one of them gets the set-wide answer, the folder step, and
 *  generated rules that match dot folders. Check a new entry against all
 *  three. */
export const SHARED_APPROVAL_SETS: Record<string, string> = { FileRead: "all reads" };

const SHARED_SET_NAMES = Object.keys(SHARED_APPROVAL_SETS);

/** How many folders the folder step lists at most. */
export const MAX_FOLDER_CHOICES = 8;

const LAUNCH_DIRECTORY_NOTE = "the launch directory";

/** "dir = /x and below, method = GET". Called only when every field is in
 *  `data`: the prompt offers a scoped answer only then. */
export function describeScope(fields: ScopedField[], data: Record<string, unknown>): string {
  return fields
    .map((field) => {
      const pinned = `${field.field} = ${String(data[field.field])}`;
      return field.matchSubpaths ? `${pinned} and below` : pinned;
    })
    .join(", ");
}

export type FolderChoice = { path: string; note: string };

/** `folder`, then each parent, nearest first, ending at the root. */
function withParents(folder: string): string[] {
  const parent = path.dirname(folder);
  return parent === folder ? [folder] : [folder, ...withParents(parent)];
}

/** The directories `folderChoices` measures against, as the run resolved
 *  them (`PolicyDirs`). */
export type FolderDirs = { cwd: string; home: string; agentHome: string };

/** True for a folder a read grant must never cover: the home directory or
 *  the agent home, a folder holding either, or a filesystem root. A root
 *  is checked apart from the home directory because on Windows another
 *  drive's root (`D:\`) does not hold the home directory. */
function tooBroad(folder: string, dirs: FolderDirs): boolean {
  return (
    isContained(dirs.home, folder) ||
    isContained(dirs.agentHome, folder) ||
    path.dirname(folder) === folder
  );
}

/**
 * The folders a read rule for `value` may cover: `value`, then each parent,
 * nearest first. The list stops at the launch directory when `value` is
 * inside it. It never holds the home directory, the agent home, a folder
 * holding either, or a filesystem root, because a read grant there covers
 * the agent's earlier conversations and `~/.ssh`. So it is empty for one of
 * those. A value that is not an absolute path comes back alone.
 */
export function folderChoices(value: string, dirs: FolderDirs): FolderChoice[] {
  if (!path.isAbsolute(value)) {
    return [{ path: value, note: "" }];
  }
  const all = withParents(value);
  // The first folder in the list that holds the launch directory is the
  // launch directory itself, when `value` is inside it.
  const launch = isContained(value, dirs.cwd)
    ? all.findIndex((folder) => isContained(dirs.cwd, folder))
    : -1;
  const reach = launch === -1 ? all : all.slice(0, launch + 1);
  const allowed = reach
    .map((folder, index) => ({ path: folder, note: index === launch ? LAUNCH_DIRECTORY_NOTE : "" }))
    .filter((choice) => !tooBroad(choice.path, dirs));
  if (allowed.length <= MAX_FOLDER_CHOICES) {
    return allowed;
  }
  return [...allowed.slice(0, MAX_FOLDER_CHOICES - 1), allowed[allowed.length - 1]];
}

/**
 * The listed set `effect` belongs to whose members all share `effect`'s
 * scope, or null. Each scope is the caller's override when there is one
 * (an override of `[]` is an empty scope), and the registry's otherwise.
 *
 * A member with neither has a module that is not loaded. It is taken to
 * agree only when `effect` itself has its declared scope: a stdlib test
 * keeps the declarations of a listed set uniform, so the unloaded member
 * declares the same scope, but nothing says it matches an override.
 */
export function sharedApprovalSet(
  effect: string,
  registered: Record<string, ScopedField[]>,
  overrides: Record<string, ScopedField[]>,
  sets: Record<string, EffectSetInfo>,
): EffectSetInfo | null {
  const scopes = { ...registered, ...overrides };
  const own = scopes[effect] ?? [];
  if (own.length === 0) {
    return null;
  }
  const ownIsDeclared = sameScopedFields(registered[effect] ?? [], own);
  const agrees = (member: string) =>
    Object.hasOwn(scopes, member) ? sameScopedFields(scopes[member], own) : ownIsDeclared;
  const found = SHARED_SET_NAMES.map((name) => sets[name]).find(
    (set) => set !== undefined && set.members.includes(effect) && set.members.every(agrees),
  );
  return found ?? null;
}

/** True when `effect` is in a listed set. */
export function inSharedApprovalSet(effect: string, sets: Record<string, EffectSetInfo>): boolean {
  return SHARED_SET_NAMES.some((name) => sets[name]?.members.includes(effect) === true);
}
