import { BaseNode } from "./base.js";

export type ExportFromStatement = BaseNode & {
  type: "exportFromStatement";
  modulePath: string;
  isAgencyImport: boolean;
  body: NamedExportBody | StarExportBody;
};

export type NamedExportBody = {
  kind: "namedExport";
  /** Source-side names being re-exported. */
  names: string[];
  /** Map of sourceName → localName for entries written as `name as alias`. */
  aliases: Record<string, string>;
  /** Source-side names marked with the `safe` modifier. */
  safeNames: string[];
};

export type StarExportBody = {
  kind: "starExport";
};

/** Returns the local names produced by a named re-export (alias if present). */
export function getReExportedLocalNames(body: NamedExportBody): string[] {
  return body.names.map((n) => body.aliases[n] ?? n);
}
