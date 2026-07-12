import type { AgencyProgram } from "../types.js";

/**
 * Prune auto-imported `std::index` prelude symbols that a file shadows with
 * its own top-level `def` / `node` / global-variable declaration.
 *
 * The prelude (`import { ... } from "std::index"`) is injected invisibly into
 * every file. In JS, an import and a same-name top-level declaration are a
 * duplicate binding — so without this, a user's `def map` or global
 * `let count` collides with the prelude's `map` / `count` and crashes at
 * module load: a TDZ error for functions (`__registerTool(map)` runs before
 * the local `const map` initializes) or "Assignment to constant variable" for
 * globals (the import is a `const`).
 *
 * Agency treats the prelude as overridable (see resolveCall.ts: stdlib
 * functions "are regular Agency code … and users may shadow them"), the way
 * Rust/Python preludes let a local definition take priority. We realize that
 * by dropping the shadowed name from the injected import so the user's
 * declaration becomes the sole module-level binding. Only `std::index` imports
 * are touched; the TS builder derives both the emitted import and its
 * `__registerTool(...)` call from these specifiers, so pruning removes both.
 */
export function prunePreludeShadows(program: AgencyProgram): void {
  const shadowed = new Set<string>();
  for (const node of program.nodes) {
    if (node.type === "function") {
      shadowed.add(node.functionName);
    } else if (node.type === "graphNode") {
      shadowed.add(node.nodeName);
    } else if (node.type === "assignment" && node.declKind) {
      // Top-level `let`/`const` global. `declKind` is absent on a bare
      // re-assignment (`x = 1`), which is not a new binding.
      shadowed.add(node.variableName);
    }
  }
  if (shadowed.size === 0) return;

  for (const node of program.nodes) {
    if (node.type !== "importStatement" || node.modulePath !== "std::index") {
      continue;
    }
    for (const spec of node.importedNames) {
      if (spec.type !== "namedImport") continue;
      spec.importedNames = spec.importedNames.filter(
        (name) => !shadowed.has(spec.aliases[name] ?? name),
      );
      if (spec.destructiveNames) {
        spec.destructiveNames = spec.destructiveNames.filter((n) =>
          spec.importedNames.includes(n),
        );
      }
      if (spec.idempotentNames) {
        spec.idempotentNames = spec.idempotentNames.filter((n) =>
          spec.importedNames.includes(n),
        );
      }
      for (const key of Object.keys(spec.aliases)) {
        if (!spec.importedNames.includes(key)) delete spec.aliases[key];
      }
    }
    node.importedNames = node.importedNames.filter(
      (spec) => spec.type !== "namedImport" || spec.importedNames.length > 0,
    );
  }
  program.nodes = program.nodes.filter(
    (node) => node.type !== "importStatement" || node.importedNames.length > 0,
  );
}
