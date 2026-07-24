import type { AgencyProgram } from "../types.js";
import type { CompilationUnit } from "../compilationUnit.js";
import type { SemanticIndex } from "./semantics.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import type { SymbolTable } from "../symbolTable.js";
import type { LintEdit, LintFinding } from "../linter/types.js";

export type DocumentState = {
  program: AgencyProgram;
  info: CompilationUnit;
  semanticIndex: SemanticIndex;
  scopes: ScopeInfo[];
  symbolTable: SymbolTable;
  /** The document version this state was built from. Lets a consumer
   *  tell a fresh state from one the debounce has left behind — see
   *  DocumentStateCache, which serves stale state on purpose. */
  version: number;
  /** Lint results computed by the diagnostics pass, reused by the
   *  code-action path so a lightbulb request does not re-parse and re-lint
   *  the document. Valid only while the document is still at
   *  `lintVersion` — diagnostics run on a debounce, so a code-action
   *  request can arrive with a newer buffer, and offset-based edits
   *  computed against old text would corrupt the new text. */
  lintFindings: LintFinding[];
  lintBatchEdits: LintEdit[];
  lintVersion: number;
};
