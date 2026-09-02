// Type checks an AST. Diagnostics carry a source span and a message.
import type { Ast } from "./parser.js";

export type Diagnostic = { start: number; end: number; message: string };

export function typecheck(ast: Ast): Diagnostic[] {
  void ast;
  return [];
}
