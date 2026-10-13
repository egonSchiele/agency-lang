// Stdlib modules that only work on Node. A program compiled for another
// platform (`platform` in the config) cannot import one: AG7009. The list
// is a module whose source imports a TypeScript helper on the NODE_ONLY
// list in eslint.node-exceptions.mjs, and a test derives it from there, so
// the two cannot drift. Their functions mostly raise no effect, which is
// why the per-effect check cannot catch them. See
// docs/dev/language/capabilities.md.

import { isStdlibImport } from "../importPaths.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";

export const NODE_ONLY_STDLIB_MODULES = [
  "std::agency",
  "std::agency/eval",
  "std::agency/local",
  "std::agents/lib/search",
  "std::args",
  "std::auth/oauth",
  "std::calendar",
  "std::embedding",
  "std::image",
  "std::llm",
  "std::mcp",
  "std::speech",
  "std::statelog",
  "std::ui",
  "std::ui/cli",
  "std::vision",
];

export function checkNodeOnlyImports(ctx: TypeCheckerContext): void {
  const platform = ctx.config.platform ?? "node";
  if (platform === "node") {
    return;
  }
  for (const node of ctx.programNodes) {
    if (node.type !== "importStatement" || !isStdlibImport(node.modulePath)) {
      continue;
    }
    if (NODE_ONLY_STDLIB_MODULES.includes(node.modulePath)) {
      ctx.errors.push(
        diagnostic("nodeOnlyModule", { module: node.modulePath, platform }, node.loc ?? null),
      );
    }
  }
}
