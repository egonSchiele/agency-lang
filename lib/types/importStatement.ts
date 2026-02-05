export type ImportStatement = {
  type: "importStatement";
  importedNames: string;
  modulePath: string;
};

export type ImportNodeStatement = {
  type: "importNodeStatement";
  importedNodes: string[];
  agencyFile: string;
};
