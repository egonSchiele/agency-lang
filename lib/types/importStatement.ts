import { BaseNode } from "./base.js";

export type ImportStatement = BaseNode & {
  type: "importStatement";
  importedNames: ImportNameType[];
  modulePath: string;
};

export type ImportNameType = NamedImport | NamespaceImport | DefaultImport;

export type NamedImport = {
  type: "namedImport";
  importedNames: string[];
  safeNames: string[];
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
 * Use `getImportedOriginalNames` when you need the original (source module) names.
 */
export function getImportedNames(importNameType: ImportNameType): string[] {
  switch (importNameType.type) {
    case "namedImport":
      return importNameType.importedNames.map(
        (n) => importNameType.aliases[n] ?? n,
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

/** Returns original (source module) names, ignoring aliases. */
export function getImportedOriginalToolNames(
  node: ImportToolStatement,
): string[] {
  return node.importedTools.flatMap((n) => n.importedNames);
}

export function getImportedSafeToolNames(node: ImportToolStatement): string[] {
  return node.importedTools.flatMap((n) => n.safeNames);
}
