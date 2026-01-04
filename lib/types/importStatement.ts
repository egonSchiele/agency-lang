export type ImportStatement = {
  type: "importStatement";
  importedNames: string;
  modulePath: string;
};