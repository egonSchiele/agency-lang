import type { AgencyNode } from "../../types.js";
import type { CompilationUnit } from "../../compilationUnit.js";
import { getImportedNames } from "../../types/importStatement.js";
import { walkNodesArray } from "../../utils/node.js";
import { BUILTIN_FUNCTIONS } from "../../config.js";

/**
 * Plain JS functions that bypass the `__call` dispatcher and are invoked
 * directly. These are NOT AgencyFunction instances and do not participate in
 * the interrupt-checking machinery.
 */
export const DIRECT_CALL_FUNCTIONS: ReadonlySet<string> = new Set([
  "approve", "reject", "propagate",
  "success", "failure",
  "isInterrupt", "hasInterrupts", "isDebugger", "isRejected", "isApproved",
  "isSuccess", "isFailure", "setLLMClient", "registerTools",
]);

/**
 * AST node types that the builder emits at module top level rather than
 * inside `__initializeGlobals`. Anything else (function calls, bare
 * expressions, …) goes into the per-execution init function so it has
 * access to `__ctx`.
 */
const TOP_LEVEL_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  "graphNode", "function", "typeAlias",
  "importStatement", "importNodeStatement",
  "comment", "multiLineComment", "newLine",
]);

/**
 * Answers "what kind of name is this?" questions for the TypeScriptBuilder.
 *
 * The builder repeatedly needs to ask whether a given identifier names a
 * graph node, an imported function, an impure call, a top-level
 * declaration, etc. Previously each question was implemented as an ad-hoc
 * method on the builder, with its own lazily-built caches sprinkled
 * through the file. This class collects them in one place, builds the
 * caches eagerly in its constructor, and exposes a small predicate API.
 *
 * Pure — depends only on the `CompilationUnit` it is constructed with.
 */
export class NameClassifier {
  private readonly plainTsImportNames: Set<string>;
  private readonly agencyImportNames: Set<string>;
  private readonly graphNodeNames: Set<string>;

  constructor(private readonly compilationUnit: CompilationUnit) {
    this.plainTsImportNames = new Set<string>();
    this.agencyImportNames = new Set<string>();
    for (const stmt of compilationUnit.importStatements) {
      const targetSet = stmt.isAgencyImport
        ? this.agencyImportNames
        : this.plainTsImportNames;
      for (const nameType of stmt.importedNames) {
        for (const name of getImportedNames(nameType)) {
          targetSet.add(name);
        }
      }
    }

    this.graphNodeNames = new Set<string>();
    for (const n of compilationUnit.graphNodes) {
      this.graphNodeNames.add(n.nodeName);
    }
    for (const group of compilationUnit.importedNodes) {
      for (const name of group.importedNodes) {
        this.graphNodeNames.add(name);
      }
    }
  }

  /** True if `functionName` names a graph node defined in or imported into this module. */
  isGraphNode(functionName: string): boolean {
    return this.graphNodeNames.has(functionName);
  }

  /**
   * True if `name` was brought in by an `import { … } from "<some>.agency"`
   * statement (as opposed to a `.js`/`.ts` import). Used by the codegen to
   * decide whether a read of `name` in user code should be wrapped with
   * `__readStatic` — agency imports could be `static const` values which
   * hold the `__UNINIT_STATIC` sentinel before their initializer runs.
   * Non-static agency imports (functions, nodes) will never equal the
   * sentinel, so the wrap is a no-op for them.
   */
  isAgencyImport(name: string): boolean {
    return this.agencyImportNames.has(name);
  }

  /**
   * True if `functionName` is one of the plain-JS helpers that bypass the
   * `__call` dispatcher (`approve`, `reject`, `success`, `failure`, …).
   */
  isDirectCallFunction(functionName: string): boolean {
    return DIRECT_CALL_FUNCTIONS.has(functionName);
  }

  /**
   * AST nodes that should be emitted at module top level (function
   * declarations, type aliases, classes, imports, comments, blank lines,
   * and static-scoped assignments). Anything else belongs inside the
   * per-execution `__initializeGlobals` body.
   */
  isTopLevelDeclaration(node: AgencyNode): boolean {
    if (TOP_LEVEL_DECLARATION_TYPES.has(node.type)) return true;
    if (node.type === "assignment" && (node as any).scope === "static") return true;
    return false;
  }

  /**
   * True if `functionName` was imported from another module. Any imported
   * call is treated as possibly-effectful: the compiler cannot see inside
   * it. (Before the `safe` retirement this also consulted `safeFunctions`;
   * that registry is gone, so every import is impure.)
   */
  isImpureImportedFunction(functionName: string): boolean {
    return (
      this.plainTsImportNames.has(functionName) ||
      this.agencyImportNames.has(functionName)
    );
  }

  /** Recursively walks `node` and returns true if any function call within it is impure. */
  containsImpureCall(node: AgencyNode): boolean {
    for (const { node: subNode } of walkNodesArray([node])) {
      if (subNode.type === "functionCall") {
        const name = subNode.functionName;
        if (this.isImpureImportedFunction(name)) return true;
        if (BUILTIN_FUNCTIONS[name]) return true;
      }
    }
    return false;
  }

  /** Recursively walks `node` and returns true if any function call within
   *  it targets a function marked `destructive`. Same walker shape as
   *  containsImpureCall; reads the destructiveFunctions registry. */
  containsDestructiveCall(node: AgencyNode): boolean {
    for (const { node: subNode } of walkNodesArray([node])) {
      if (subNode.type === "functionCall") {
        if (this.compilationUnit.destructiveFunctions[subNode.functionName]) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * True if a call to `functionName` should be wrapped in the
   * interrupt-checking boilerplate. Everything gets it EXCEPT known
   * non-Agency direct-call helpers, compiler-internal `__` names, and
   * graph nodes (which handle their own interrupts).
   */
  shouldHandleInterrupts(functionName: string): boolean {
    if (functionName.startsWith("__")) return false;
    if (DIRECT_CALL_FUNCTIONS.has(functionName)) return false;
    if (this.isGraphNode(functionName)) return false;
    return true;
  }
}
