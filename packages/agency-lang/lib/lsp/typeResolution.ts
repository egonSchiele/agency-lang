import { getWordAtPosition } from "../cli/definition.js";
import type { AgencyProgram, VariableType } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { findContainingScope } from "./scopeResolution.js";

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

function offsetOfLine(source: string, line: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const idx = source.indexOf("\n", offset);
    if (idx === -1) return source.length;
    offset = idx + 1;
  }
  return offset;
}
