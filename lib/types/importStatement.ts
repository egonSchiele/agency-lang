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
};

export type NamespaceImport = {
  type: "namespaceImport";
  importedNames: string;
};

export type DefaultImport = {
  type: "defaultImport";
  importedNames: string;
};

export function getImportedNames(importNameType: ImportNameType): string[] {
  switch (importNameType.type) {
    case "namedImport":
      return importNameType.importedNames;
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
  return node.importedTools.flatMap((n) => n.importedNames);
}

export function getImportedSafeToolNames(node: ImportToolStatement): string[] {
  return node.importedTools.flatMap((n) => n.safeNames);
}
