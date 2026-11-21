import path from "#path";
import { currentHost } from "../runtime/currentHost.js";
import { rejectDangerousPath } from "./fs.js";
import { resolveAgainstCwd, resolveBashPath, type TildeMode } from "./prepareContainedPath.js";

/** A trailing `/`, `/*`, `/.*`, or `/.` names a folder's contents, which
 *  for the refusal is the folder. */
const CONTENTS_SUFFIX = /\/(\*|\.\*|\.)?$/;

/** `$HOME` at the start of a target. safeBash writes a variable as
 *  `$NAME`, whichever way the model spelled it. */
const HOME_VARIABLE = /^\$HOME(?=\/|$)/;

/** A target that is one variable and nothing else, such as `$BUILD`. */
const LONE_VARIABLE = /^\$\w+$/;

function holds(folder: string, inner: string): boolean {
  const prefix = folder.endsWith(path.sep) ? folder : folder + path.sep;
  return folder === inner || inner.startsWith(prefix);
}

/** A step bash expands before it opens the path: a glob, a brace list, or
 *  a variable. */
const EXPANDED_STEP = /[*?[{$]/;

// Whether a `..` comes after a step bash expands, as in `l*/../x` or
// `$D/../x`. Such a step may expand to a symlink, and no one can tell
// where the `..` lands until bash runs. Every `..` counts, not only the
// first: in `a/../l*/../x` the second one follows the glob.
function dotDotAfterUnknownStep(text: string): boolean {
  const steps = text.split("/");
  const lastDotDot = steps.lastIndexOf("..");
  return steps.slice(0, Math.max(lastDotDot, 0)).some((step) => EXPANDED_STEP.test(step));
}

/**
 * Why `rm` or `rmdir` may not delete `target` from `cwd`, or "" when it may.
 * The rule is the remove tool's own (`rejectDangerousPath`): never the
 * filesystem root, the home folder, a top-level folder such as `/usr`, or
 * a working directory and the folders that hold it.
 *
 *   rm -rf /            refused
 *   rm -rf ~/*          refused: a folder's contents count as the folder
 *   rm -rf "$HOME"      refused
 *   rm -rf $BUILD/*     refused: an unset variable makes this `/*`
 *   rm -rf *            refused: everything in the working directory
 *   rm -rf link/../x    refused when `link` is a symlink: bash deletes `x`
 *                       beside the link's target, not the `x` named here
 *   rm -rf $D/../x      refused: `$D`, or a glob there, may be a symlink
 *   rm -rf build        ""
 *
 * `target` is the text of one argument with each variable written as
 * `$NAME`. A variable other than `$HOME` is left as it is, so `$BUILD/out`
 * is read as a folder of that name and passes. `~` is read as the home
 * folder even inside quotes, where bash would not expand it, because the
 * refusal should err toward refusing.
 */
export async function _removeRefusal(target: string, cwd: string): Promise<string> {
  let text = target.trim();
  let namedContents = false;
  while (text !== "" && CONTENTS_SUFFIX.test(text)) {
    text = text.replace(CONTENTS_SUFFIX, "");
    namedContents = true;
  }
  if (text === "") {
    return namedContents ? "that is the filesystem root" : "";
  }
  if (namedContents && LONE_VARIABLE.test(text) && text !== "$HOME") {
    return `if ${text} is unset, that is the filesystem root`;
  }
  if (text === "*" || text === ".*") {
    text = ".";
  }
  const written = text.replace(HOME_VARIABLE, "~");
  if (dotDotAfterUnknownStep(written)) {
    return "a `..` after a glob or a variable may follow a symlink";
  }
  try {
    // Throws for a `..` after a symlink, which is a refusal here: the path
    // read from the text is not the one bash would delete.
    const named = await resolveBashPath(written, cwd, "expand", "rm");
    if (holds(named, resolveAgainstCwd(".", cwd, "literal", "rm"))) {
      return "that is the working directory or a folder that holds it";
    }
    await rejectDangerousPath(currentHost(), named, "rm", "target");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** An `rm` or `rmdir` command word, bare or after a path, and the rest of
 *  its command up to the next separator. A backtick or a quote may come
 *  before the word, as in `` x=`rm -rf ~` `` and `sh -c "rm -rf /"`. A
 *  quote does not end the arguments, because `rm -rf "$HOME"` has one. */
const REMOVE_COMMAND = /(?:^|[\s;&|(){}`"'])(?:[^\s;&|(){}`"']*\/)?(?:rm|rmdir)\s+([^;&|()`\n]*)/g;

/**
 * `_removeRefusal` for a line the bash parser could not read, such as
 * `rm -rf $BUILD/*`. With no tree to walk, this reads the text: each word
 * after an `rm` or `rmdir`, up to the next separator, with quotes dropped
 * and `${NAME}` written as `$NAME`. It can refuse a line that was safe,
 * for instance when a quoted word has a space in it, and that is the side
 * to err on.
 */
export async function _unparsedRemoveRefusal(source: string, cwd: string): Promise<string> {
  for (const found of source.matchAll(REMOVE_COMMAND)) {
    for (const raw of found[1].split(/\s+/)) {
      const word = raw.replace(/["']/g, "").replace(/\$\{(\w+)\}/g, "$$$1");
      if (word.startsWith("-")) continue;
      const why = await _removeRefusal(word, cwd);
      if (why !== "") return why;
    }
  }
  return "";
}

/**
 * The real whole path of one literal operand, for a `std::remove` or
 * `std::mkdir` payload: the spelling the remove and mkdir tools put in
 * their own payloads, so one policy rule covers both. Steps that exist
 * are resolved through links; every step after the first missing one is
 * kept as written, and a dangling link fails. `tildeMode` is "expand"
 * for an unquoted word, because bash expands `~` only there. `verb` names
 * the command in an error.
 */
/**
 * A folder with every link followed, the last step included, for the
 * check that a step still runs in the folder that was approved. A folder
 * that became a link is a link in its last step, which `_realPathIn`
 * keeps as written.
 */
export async function _realFolder(dir: string): Promise<string> {
  return currentHost().files.realDir(dir);
}

export async function _realPathIn(
  text: string,
  cwd: string,
  tildeMode: TildeMode,
  verb: string,
): Promise<string> {
  return currentHost().files.realPath(await resolveBashPath(text, cwd, tildeMode, verb));
}
