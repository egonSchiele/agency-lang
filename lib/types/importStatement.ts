export type ImportStatement = {
  type: "importStatement";
  importedNames: ImportNameType[];
  modulePath: string;
};

export type ImportNameType = NamedImport | NamespaceImport | DefaultImport;

export type NamedImport = {
  type: "namedImport";
  importedNames: string[];
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

export type ImportNodeStatement = {
  type: "importNodeStatement";
  importedNodes: string[];
  agencyFile: string;
};

export type ImportToolStatement = {
  type: "importToolStatement";
  importedTools: string[];
  agencyFile: string;
};
