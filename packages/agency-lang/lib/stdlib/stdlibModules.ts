// Every std:: module and the public functions it exports, for the message
// `learn` and `runFunction` send back when a source names a module that
// does not exist. The table is `stdlibModules.data.ts`, which
// scripts/generate-stdlib-modules.mjs writes at build time, so a lookup
// reads no files. stdlibModules.test.ts fails when the table is stale.
import { STDLIB_MODULES } from "./stdlibModules.data.js";

export function isKnownStdlibModule(moduleName: string): boolean {
  return Object.hasOwn(STDLIB_MODULES, moduleName);
}

/** For `std::exec` with names ["exec"]: "There is no standard library
 *  module named std::exec. `exec` is exported by std::shell." When no
 *  name is found, the message lists the modules that export functions. */
export function missingModuleMessage(moduleName: string, names: string[]): string {
  const missing = `There is no standard library module named ${moduleName}.`;
  const modules = Object.keys(STDLIB_MODULES);
  const found = names.flatMap((name) => {
    const exporters = modules.filter((module) => STDLIB_MODULES[module].includes(name));
    return exporters.length === 0 ? [] : [`\`${name}\` is exported by ${exporters.join(", ")}.`];
  });
  if (found.length > 0) {
    return [missing, ...found].join(" ");
  }
  const withFunctions = modules.filter((module) => STDLIB_MODULES[module].length > 0);
  return `${missing} The modules that export functions are: ${withFunctions.join(", ")}.`;
}
