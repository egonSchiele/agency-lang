import { declaredName } from "../types/hole.js";
import type { AgencyProgram } from "../types.js";
import { getImportedNames } from "../types/importStatement.js";

/**
 * Prune auto-imported `std::index` prelude symbols that a file shadows with
 * its own top-level `def` / `node` / `type` / global-variable declaration, or
 * with a name it imports from another module.
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
/** Prelude names a user shadow must NEVER displace. `_guard` is the
 *  guard construct's desugar target (guardDesugar.ts): pruning it
 *  would silently rebind every `guard(...) { }` in the file to the
 *  user's `_guard` — a bypass of budget metering, which is safety
 *  infrastructure. Keeping the import makes a user `_guard` a
 *  duplicate-binding error instead: fail closed. The typechecker also
 *  reserves the name (RESERVED_FUNCTION_NAMES) for a clear message. */
const UNPRUNABLE_PRELUDE_NAMES = new Set<string>(["_guard"]);

export function prunePreludeShadows(program: AgencyProgram): void {
  const shadowed = new Set<string>();
  for (const node of program.nodes) {
    if (node.type === "function") {
      shadowed.add(declaredName(node.functionName));
    } else if (node.type === "graphNode") {
      shadowed.add(declaredName(node.nodeName));
    } else if (node.type === "assignment" && node.declKind) {
      // Top-level `let`/`const` global. `declKind` is absent on a bare
      // re-assignment (`x = 1`), which is not a new binding.
      shadowed.add(node.variableName);
    } else if (node.type === "typeAlias") {
      // A type compiles to a runtime value (`const Call = z.object(...)`),
      // so it collides with a prelude type of the same name, such as `Call`.
      shadowed.add(node.aliasName);
    } else if (node.type === "importStatement" && node.modulePath !== "std::index") {
      // `import { Call } from "./types.agency"` is a binding of its own.
      for (const spec of node.importedNames) {
        for (const name of getImportedNames(spec)) {
          shadowed.add(name);
        }
      }
    }
  }
  for (const name of UNPRUNABLE_PRELUDE_NAMES) {
    shadowed.delete(name);
  }
  if (shadowed.size === 0) return;

  for (const node of program.nodes) {
    if (node.type !== "importStatement" || node.modulePath !== "std::index") {
      continue;
    }
    for (const spec of node.importedNames) {
      if (spec.type !== "namedImport") continue;
      spec.importedNames = spec.importedNames.filter((entry) => {
        const name = declaredName(entry);
        return !shadowed.has(spec.aliases[name] ?? name);
      });
      // Re-filter the marker lists, and DELETE them when filtering empties
      // them — `destructiveNames`/`idempotentNames` are present only when
      // non-empty (the exact-match-AST invariant), so a leftover `[]` would
      // violate it.
      if (spec.destructiveNames) {
        spec.destructiveNames = spec.destructiveNames.filter((n) => spec.importedNames.includes(n));
        if (spec.destructiveNames.length === 0) delete spec.destructiveNames;
      }
      if (spec.idempotentNames) {
        spec.idempotentNames = spec.idempotentNames.filter((n) => spec.importedNames.includes(n));
        if (spec.idempotentNames.length === 0) delete spec.idempotentNames;
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
