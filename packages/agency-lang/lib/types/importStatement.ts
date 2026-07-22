import { BaseNode } from "./base.js";

export type ImportStatement = BaseNode & {
  type: "importStatement";
  importedNames: ImportNameType[];
  modulePath: string;
  isAgencyImport: boolean;
  /** True when written `import test { … }`. Absent (never null/false) on
   *  normal imports so exact-match AST comparisons and JSON output stay
   *  clean. Honored only under the test harness (see resolveImports). */
  testOnly?: boolean;
};

export type ImportNameType = NamedImport | NamespaceImport | DefaultImport;

export type NamedImport = {
  type: "namedImport";
  importedNames: string[];
  /** Source-side names marked `destructive` / `idempotent`. Each present
   *  only when non-empty (matching `testOnly` above) so exact-match AST
   *  comparisons stay clean. */
  destructiveNames?: string[];
  idempotentNames?: string[];
  aliases: Record<string, string>;
};

export type NamespaceImport = {
  type: "namespaceImport";
  importedNames: string;
};

export type DefaultImport = {
  type: "defaultImport";
  importedNames: string;
};

/**
 * Returns the local names for an import (i.e. the alias if present, otherwise the original name).
 */
export function getImportedNames(importNameType: ImportNameType): string[] {
  switch (importNameType.type) {
    case "namedImport":
      // Own-property check: names are user identifiers, and a plain lookup
      // for a name like "constructor" would return the inherited prototype
      // member instead of the (absent) alias.
      return importNameType.importedNames.map((n) =>
        Object.hasOwn(importNameType.aliases, n) ? importNameType.aliases[n] : n,
      );
    case "namespaceImport":
      return [importNameType.importedNames];
    case "defaultImport":
      return [importNameType.importedNames];
  }
}

export type ImportNodeStatement = BaseNode & {
  type: "importNodeStatement";
  importedNodes: string[];
  agencyFile: string;
  /**
   * When true, the typescript builder also emits a JS-level re-export of each
   * node's `__<name>NodeParams` from the source file, so consumers of THIS
   * file can `import node` from it transitively. Set by `resolveReExports`.
   * Always undefined for user-written `import node { ... }` statements.
   */
  reExport?: boolean;
};

export type ImportToolStatement = BaseNode & {
  type: "importToolStatement";
  importedTools: NamedImport[];
  agencyFile: string;
};

export function getImportedToolNames(node: ImportToolStatement): string[] {
  return node.importedTools.flatMap((n) =>
    n.importedNames.map((name) => n.aliases[name] ?? name),
  );
}


