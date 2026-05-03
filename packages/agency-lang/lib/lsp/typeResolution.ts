import { getWordAtPosition } from "../cli/definition.js";
import type { AgencyProgram, VariableType } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { findContainingScope } from "./scopeResolution.js";
import { offsetOfLine } from "./util.js";

export function resolveTypeAtPosition(
  source: string,
  line: number,
  character: number,
  program: AgencyProgram,
  scopes: ScopeInfo[],
): VariableType | null {
  const word = getWordAtPosition(source, line, character);
  if (!word) return null;

  const cursorOffset = offsetOfLine(source, line) + character;

  const scope = findContainingScope(cursorOffset, scopes, program);
  if (!scope) return null;

  const resolved = scope.scope.lookup(word);
  if (!resolved || resolved === "any") return null;
  return resolved;
}
