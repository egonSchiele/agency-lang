import type { AgencyProgram } from "../types.js";
import type { CompilationUnit } from "../compilationUnit.js";
import type { SemanticIndex } from "./semantics.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import type { SymbolTable } from "../symbolTable.js";

export type DocumentState = {
  program: AgencyProgram;
  info: CompilationUnit;
  semanticIndex: SemanticIndex;
  scopes: ScopeInfo[];
  symbolTable: SymbolTable;
};
