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

export type ImportToolStatement = {
  type: "importToolStatement";
  importedTools: string[];
  agencyFile: string;
};
