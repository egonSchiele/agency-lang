/**
 * Which tools the driver imports. The driver would not compile with an
 * import of a name its module does not export, so each module is described
 * first, the way `std::workflow` describes it, and only names it really
 * exports go into the driver.
 */
import fs from "fs";
import path from "path";
import { root } from "../../host/node/nodeFiles.js";
import { isStrictDescendant } from "../../utils.js";
import { _describe, resolveInSandbox, type ExportInfo } from "../../stdlib/agency.js";
import { _pickSignatures } from "../../stdlib/workflow/index.js";
import { MODULE_PATH } from "../../stdlib/workflow/tools.js";
import {
  isObject,
  signatureKey,
  type Problem,
  type Signature,
} from "../../stdlib/workflow/types.js";
import { DRIVER_NAMES } from "./driver.js";

/** A standard module, as a step's `module` field names one. `isStdlibImport`
 *  checks only the prefix, so `std::../../x` would pass it and `MODULE_PATH`. */
export const STD_MODULE = /^std::[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;

export type DescribedModule = {
  /** As a step's `module` field writes it: `std::math`, or `./tools/notes.agency`. */
  module: string;
  /** Each exported def's Signature, keyed by its name. */
  signatures: Record<string, Signature>;
};

/** Why a module could not be described. `reachable` is false for a module
 *  that is missing, outside `dir`, or not a module path at all: those are
 *  left for `checkWorkflow` to report on the step. A reachable module that
 *  still fails, such as one that does not parse, is reported here. */
export type DescribeError = { error: string; reachable: boolean };

export function describeModule(module: string, dir: string): DescribedModule | DescribeError {
  if (module.startsWith("std::")) {
    if (!STD_MODULE.test(module)) {
      return { error: `"${module}" is not a standard module name`, reachable: false };
    }
    return described(module, () => _describe(`export * from "${module}"`).exports, false);
  }
  if (!MODULE_PATH.test(module) || !module.endsWith(".agency")) {
    return { error: `"${module}" is not a path to an .agency file`, reachable: false };
  }
  let file: string;
  try {
    file = resolveInSandbox(dir, module, root);
  } catch (error) {
    return { error: (error as Error).message, reachable: false };
  }
  if (!fs.existsSync(file)) {
    return { error: `"${module}" does not exist`, reachable: false };
  }
  return described(
    module,
    () => _describe(fs.readFileSync(file, "utf-8"), dir, module).exports,
    true,
  );
}

/** A std module that does not describe is one that does not exist, so it is
 *  not reachable. A local file that exists and does not describe is. */
function described(
  module: string,
  exportsOf: () => ExportInfo[],
  reachable: boolean,
): DescribedModule | DescribeError {
  let exports: ExportInfo[];
  try {
    exports = exportsOf();
  } catch (error) {
    return { error: (error as Error).message, reachable };
  }
  const names = exports.filter((entry) => entry.kind === "def").map((entry) => entry.name);
  const picked = _pickSignatures({ module, names, reExport: null }, exports);
  if (!picked.success) {
    return { error: String(picked.error), reachable };
  }
  const byKey = picked.value as Record<string, Signature>;
  const signatures: Record<string, Signature> = {};
  for (const name of names) {
    signatures[name] = byKey[signatureKey(module, name)];
  }
  return { module, signatures };
}

function isDescribeError(value: DescribedModule | DescribeError): value is DescribeError {
  return "error" in value;
}

export type ToolImport = { module: string; names: string[] };

export type ImportPlan = {
  /** One import line's worth per module, in first-use order. */
  imports: ToolImport[];
  /** Signatures of every imported tool, keyed by signatureKey(module, name). */
  signatures: Record<string, Signature>;
  problems: Problem[];
};

/** One tool to import, and the step and field a problem with it belongs to. */
type Wanted = { module: string; name: string; step: string | null };

/** The plan for a list of wanted tools, each from a module that described.
 *  A name already imported from another module, and a name the driver
 *  uses, are problems on the tool. */
function planFor(wanted: Wanted[], modules: Record<string, DescribedModule>): ImportPlan {
  const plan: ImportPlan = { imports: [], signatures: {}, problems: [] };
  const firstModule: Record<string, string> = {};
  for (const { module, name, step } of wanted) {
    if (Object.hasOwn(firstModule, name)) {
      const earlier = firstModule[name];
      if (earlier !== module) {
        const message = `tools "${name}" from "${earlier}" and "${module}" have the same name; a workflow imports each tool by its name`;
        plan.problems.push({ step, field: step === null ? null : "tool", message });
      }
      continue;
    }
    if (DRIVER_NAMES.includes(name)) {
      const message = `tool name "${name}" is a name the agency workflow command uses`;
      plan.problems.push({ step, field: step === null ? null : "tool", message });
      continue;
    }
    firstModule[name] = module;
    const entry = plan.imports.find((existing) => existing.module === module);
    if (entry === undefined) {
      plan.imports.push({ module, names: [name] });
    } else {
      entry.names.push(name);
    }
    plan.signatures[signatureKey(module, name)] = modules[module].signatures[name];
  }
  return plan;
}

/** The tool steps of a workflow that is not yet known to be well formed.
 *  A step with the wrong shape is skipped; parse reports it. */
function toolSteps(workflow: unknown): { id: string; module: string; tool: string }[] {
  if (!isObject(workflow) || !Array.isArray(workflow.steps)) {
    return [];
  }
  return workflow.steps.flatMap((step) => {
    if (!isObject(step) || step.kind !== "tool") {
      return [];
    }
    const { id, module, tool } = step;
    if (typeof id !== "string" || typeof module !== "string" || typeof tool !== "string") {
      return [];
    }
    return [{ id, module, tool }];
  });
}

/** `check`, `compile`, and `run`: the tools the steps name. */
export function importsForSteps(workflow: unknown, dir: string): ImportPlan {
  const modules: Record<string, DescribedModule> = {};
  const unreadable: Problem[] = [];
  const wanted: Wanted[] = [];
  const tried: string[] = [];
  for (const step of toolSteps(workflow)) {
    if (!tried.includes(step.module)) {
      tried.push(step.module);
      const result = describeModule(step.module, dir);
      if (!isDescribeError(result)) {
        modules[step.module] = result;
      } else if (result.reachable) {
        const message = `cannot read the exports of "${step.module}": ${result.error}`;
        unreadable.push({ step: step.id, field: "module", message });
      }
    }
    const found = modules[step.module];
    if (found !== undefined && Object.hasOwn(found.signatures, step.tool)) {
      wanted.push({ module: step.module, name: step.tool, step: step.id });
    }
  }
  const plan = planFor(wanted, modules);
  return { ...plan, problems: [...unreadable, ...plan.problems] };
}

/** `tools`: every def of each source. A source is a .agency path or a std::
 *  module. A local source is written as `./<path relative to dir>`. */
export function importsForSources(
  sources: string[],
  dir: string,
  cwd: string,
): ImportPlan | { error: string } {
  const modules: Record<string, DescribedModule> = {};
  const wanted: Wanted[] = [];
  for (const source of sources) {
    const module = moduleOfSource(source, dir, cwd);
    if (module === null) {
      return { error: `${source}: is not inside the project directory ${dir}` };
    }
    const result = describeModule(module, dir);
    if (isDescribeError(result)) {
      return { error: `${source}: cannot read its exports: ${result.error}` };
    }
    modules[module] = result;
    for (const name of Object.keys(result.signatures)) {
      wanted.push({ module, name, step: null });
    }
  }
  return planFor(wanted, modules);
}

function moduleOfSource(source: string, dir: string, cwd: string): string | null {
  if (source.startsWith("std::")) {
    return source;
  }
  const relative = path.relative(dir, path.resolve(cwd, source));
  if (!isStrictDescendant(dir, path.resolve(cwd, source))) {
    return null;
  }
  return `./${relative.split(path.sep).join("/")}`;
}
