import path from "#path";
import { currentHost } from "../runtime/currentHost.js";
import { rejectDangerousPath } from "./fs.js";
import { resolveAgainstCwd, type TildeMode } from "./prepareContainedPath.js";

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
  try {
    const lexical = resolveAgainstCwd(text.replace(HOME_VARIABLE, "~"), cwd, "expand", "rm");
    if (holds(lexical, resolveAgainstCwd(".", cwd, "literal", "rm"))) {
      return "that is the working directory or a folder that holds it";
    }
    await rejectDangerousPath(currentHost(), lexical, "rm", "target");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

/** An `rm` or `rmdir` command word, bare or after a path, and the rest of
 *  its command up to the next separator. */
const REMOVE_COMMAND = /(?:^|[\s;&|(){}])(?:[^\s;&|(){}]*\/)?(?:rm|rmdir)\s+([^;&|()\n]*)/g;

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
 * The real whole path of one literal `rm` operand, for the `std::remove`
 * payload: the spelling the remove tool puts in its own payload, so one
 * policy rule covers both. `tildeMode` is "expand" for an unquoted word,
 * because bash expands `~` only there.
 */
export async function _removeTargetIn(
  text: string,
  cwd: string,
  tildeMode: TildeMode,
): Promise<string> {
  return currentHost().files.realPath(resolveAgainstCwd(text, cwd, tildeMode, "rm"));
}
