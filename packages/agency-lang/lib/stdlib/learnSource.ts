import path from "#path";
import { stat, wholePath } from "../host/node/nodeFiles.js";
import { stdlibModuleName } from "../importPaths.js";
import { currentHost } from "../runtime/currentHost.js";
import { failure, success, type ResultValue } from "../runtime/result.js";
import type { AgencySourceValue } from "./agencyFunctions.js";
import { expandPath } from "./expandPath.js";
import { isContained } from "./isContained.js";
import { _stdlibDir } from "./skills.js";
import { isKnownStdlibModule } from "./stdlibModules.js";

function fileExists(file: string): boolean {
  const located = wholePath(file);
  return stat(located.root, located.target) !== null;
}

/**
 * The source `learn` takes for a path a model wrote. A relative path is
 * looked up in `cwd`, then in the stdlib folder. A file inside the stdlib
 * folder is learned as its `std::` module, so an approval names the module.
 *
 * Only a `.agency` file is accepted. `learn` reads the file in this process
 * before it raises an interrupt, so this rule also limits what is read
 * before anyone has approved anything.
 */
export function learnSourceIn(
  file: string,
  cwd: string,
  homeDir: string,
  stdlibDir: string,
): ResultValue {
  if (!file.endsWith(".agency")) {
    return failure(`'${file}' is not an Agency file. Give the path of a .agency file.`);
  }
  try {
    const expanded = expandPath(file, homeDir);
    const places = path.isAbsolute(expanded)
      ? [expanded]
      : [path.resolve(cwd, expanded), path.resolve(stdlibDir, expanded)];
    const found = places.find(fileExists);
    if (found === undefined) {
      return failure(`There is no Agency file at ${places.join(" or at ")}.`);
    }
    if (!isContained(found, stdlibDir)) {
      const source: AgencySourceValue = {
        kind: "file",
        dir: path.dirname(found),
        filename: path.basename(found),
      };
      return success(source);
    }
    // A module source is trusted code and its name is what an approval
    // shows, so the name must be one the stdlib really has, spelled as the
    // stdlib spells it.
    const module = stdlibModuleName(found);
    if (!isKnownStdlibModule(module)) {
      return failure(
        `'${found}' is in the stdlib folder but is not a stdlib module. Give the path as the list of learnable tools or grep printed it.`,
      );
    }
    const source: AgencySourceValue = { kind: "module", module };
    return success(source);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export function _learnSource(file: string, cwd: string): ResultValue {
  return learnSourceIn(file, cwd, currentHost().system.homeDir(), _stdlibDir());
}
