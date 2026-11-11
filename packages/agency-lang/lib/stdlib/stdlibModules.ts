// Every std:: module and the public functions it exports, read from the
// generated stdlibModules.data.ts so a lookup reads no files. `learn` and
// `runFunction` use it to name the right module when a source names the
// wrong one.
import { STDLIB_MODULES } from "./stdlibModules.data.js";

export function isKnownStdlibModule(moduleName: string): boolean {
  return Object.hasOwn(STDLIB_MODULES, moduleName);
}

/** "`exec` is exported by std::shell.", or "" when no module exports it. */
export function exporterHint(name: string): string {
  const exporters = Object.keys(STDLIB_MODULES).filter((module) =>
    STDLIB_MODULES[module].includes(name),
  );
  if (exporters.length === 0) {
    return "";
  }
  return `\`${name}\` is exported by ${exporters.join(", ")}.`;
}

/** For `std::exec` with names ["exec"]: "There is no standard library
 *  module named std::exec. `exec` is exported by std::shell." When no
 *  name is found, the message lists the modules that export functions. */
export function missingModuleMessage(moduleName: string, names: string[]): string {
  const missing = `There is no standard library module named ${moduleName}.`;
  const hints = names.map(exporterHint).filter((hint) => hint !== "");
  if (hints.length > 0) {
    return [missing, ...hints].join(" ");
  }
  const withFunctions = Object.keys(STDLIB_MODULES).filter(
    (module) => STDLIB_MODULES[module].length > 0,
  );
  return `${missing} The modules that export functions are: ${withFunctions.join(", ")}.`;
}
