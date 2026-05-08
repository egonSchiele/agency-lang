import { InlayHint, InlayHintKind } from "vscode-languageserver-protocol";
import type { AgencyProgram } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { walkNodes } from "../utils/node.js";
import { formatTypeHint } from "../utils/formatType.js";
import { findContainingScope } from "./scopeResolution.js";

export function getInlayHints(
  program: AgencyProgram,
  scopes: ScopeInfo[],
): InlayHint[] {
  const hints: InlayHint[] = [];

  for (const { node } of walkNodes(program.nodes)) {
    if (node.type !== "assignment") continue;
    if (node.typeHint) continue;
    if (!node.loc) continue;
    if (!node.declKind) continue; // skip reassignments

    const containingScope = findContainingScope(node.loc.start, scopes, program);
    if (!containingScope) continue;

    const resolved = containingScope.scope.lookup(node.variableName);
    if (!resolved || resolved === "any") continue;

    // Position hint after variable name: loc.col is start of let/const,
    // so variable name starts at loc.col + declKind.length + 1
    const varNameEnd = node.loc.col + node.declKind.length + 1 + node.variableName.length;

    hints.push({
      position: {
        line: node.loc.line,
        character: varNameEnd,
      },
      label: `: ${formatTypeHint(resolved)}`,
      kind: InlayHintKind.Type,
      paddingLeft: false,
      paddingRight: true,
    });
  }

  return hints;
}
