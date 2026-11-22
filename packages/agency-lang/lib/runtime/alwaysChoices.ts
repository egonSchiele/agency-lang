import path from "#path";
import { sameScopedFields, type ScopedField } from "./alwaysScope.js";
import type { EffectSetInfo } from "./effectSets.js";
import { escapeGlob, REST_OF_LIST } from "./policy.js";
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

/** Effects outside a shared set that still get the folder step and rules
 *  that reach dot folders. Each entry is a decision: the folder step lets
 *  one key press widen a rule to a parent folder, so an effect such as
 *  `std::remove` must not be here. `std::exec` is, because its folder is
 *  where a program starts, and `.worktrees/x` is no riskier than `src`. */
export const FOLDER_STEP_EFFECTS: string[] = ["std::exec"];

/** True when a rule for `effect` may be widened to a parent folder. */
export function getsFolderStep(effect: string, sets: Record<string, EffectSetInfo>): boolean {
  return FOLDER_STEP_EFFECTS.includes(effect) || inSharedApprovalSet(effect, sets);
}

/** How many folders the folder step lists at most. */
export const MAX_FOLDER_CHOICES = 8;

const LAUNCH_DIRECTORY_NOTE = "the launch directory";

/** How many choices the list step shows at most. */
export const MAX_PREFIX_CHOICES = 8;

/** The id of the choice that pins the whole list. */
export const EXACT_PREFIX = "exact";

/** One width a rule for a list can have. `keep` is how many leading items
 *  it pins. `rest` is true when any items may follow them. */
export type PrefixChoice = { id: string; keep: number; rest: boolean };

/** "dir = /x and below, args = run build". A list prints as its items
 *  joined with spaces, which is the narrowest rule: the whole list. Called
 *  only when every field is in `data`: the prompt offers a scoped answer
 *  only then. */
export function describeScope(fields: ScopedField[], data: Record<string, unknown>): string {
  return fields
    .map((field) => {
      const value = data[field.field];
      const shown = Array.isArray(value) ? value.join(" ") : String(value);
      const pinned = `${field.field} = ${shown}`;
      return field.matchSubpaths ? `${pinned} and below` : pinned;
    })
    .join(", ");
}

/** `choices` cut to `max`: the narrowest ones, and the widest. */
function narrowestAndWidest<T>(choices: T[], max: number): T[] {
  if (choices.length <= max) {
    return choices;
  }
  return [...choices.slice(0, max - 1), choices[choices.length - 1]];
}

/** The widths a rule for a list of `itemCount` items can have, narrowest
 *  first: the whole list, then the first n items followed by anything,
 *  down to the first item followed by anything. When there are too many,
 *  the whole list stays and the widest ones fill the rest: for a command
 *  the wide choices are the likely picks, such as `pnpm run agency …` for a
 *  long `pnpm run agency test` line. There is no choice that keeps no
 *  items: it would cover the program with any arguments, which is broader
 *  than any rule the prompt saved before. */
export function prefixChoices(itemCount: number): PrefixChoice[] {
  const widest = Math.min(itemCount, MAX_PREFIX_CHOICES - 1);
  const widths = Array.from({ length: widest }, (_, index) => widest - index);
  return [
    { id: EXACT_PREFIX, keep: itemCount, rest: false },
    ...widths.map((keep) => ({ id: String(keep), keep, rest: true })),
  ];
}

/** The pattern a choice saves: the kept items, each escaped so it matches
 *  only itself, then REST_OF_LIST when `rest` is true. */
export function prefixPattern(items: string[], choice: PrefixChoice): string[] {
  const kept = items.slice(0, choice.keep).map(escapeGlob);
  return choice.rest ? [...kept, REST_OF_LIST] : kept;
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
  return narrowestAndWidest(allowed, MAX_FOLDER_CHOICES);
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
  // Own keys only: `effect` is a user-controlled string, and an effect
  // named `constructor` must not resolve Object's from the prototype.
  const scopeOf = (record: Record<string, ScopedField[]>, name: string) =>
    Object.hasOwn(record, name) ? record[name] : [];
  const scopes = { ...registered, ...overrides };
  const own = scopeOf(scopes, effect);
  if (own.length === 0) {
    return null;
  }
  const ownIsDeclared = sameScopedFields(scopeOf(registered, effect), own);
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
