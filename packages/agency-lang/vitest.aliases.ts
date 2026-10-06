import path from "path";

// The one definition of the import aliases every vitest config uses. The
// "#..." entries mirror the "imports" field of package.json, which vitest
// does not read; they point at the source file Node would pick. Keep the
// two in step, and keep this list in step with lib/utils/packageImports.d.ts.
export const aliases: Record<string, string> = {
  "@": path.resolve(import.meta.dirname, "./lib"),
  "#sha256": path.resolve(import.meta.dirname, "./lib/utils/sha256.node.ts"),
};
