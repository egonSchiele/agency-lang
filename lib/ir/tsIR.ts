// TypeScript IR node types
// Uses "kind" as discriminant to avoid collision with Agency AST's "type" field.

export type TsNode =
  | TsRaw
  | TsStatements
  | TsImport
  | TsVarDecl
  | TsAssign
  | TsFunctionDecl
  | TsArrowFn
  | TsCall
  | TsAwait
  | TsReturn
  | TsObjectLiteral
  | TsArrayLiteral
  | TsTemplateLit
  | TsIf
  | TsFor
  | TsWhile
  | TsSwitch
  | TsTryCatch
  | TsBinOp
  | TsPropertyAccess
  | TsSpread
  | TsIdentifier
  | TsStringLiteral
  | TsNumericLiteral
  | TsBooleanLiteral
  | TsComment
  | TsExport
  | TsNewExpr
  | TsScopedVar
  | TsFunctionReturn
  | TsRunnerStep
  | TsRunnerThread
  | TsRunnerHandle
  | TsRunnerIfElse
  | TsRunnerLoop
  | TsRunnerWhileLoop
  | TsRunnerBranchStep
  | TsRunnerDebugger
  | TsRunnerPipe
  | TsEmpty
  | TsBreak
  | TsContinue
  | TsPostfixOp
  | TsAnd
  | TsOr
  | TsNot
  | TsWithHandler
  | TsTernary;

/** Raw pushHandler/popHandler wrapping for global scope (no runner) */
export interface TsWithHandler {
  kind: "withHandler";
  handler: TsNode;
  body: TsNode;
}

/** Escape hatch: verbatim string */
export interface TsRaw {
  kind: "raw";
  code: string;
}

/** Ordered list of statements */
export interface TsStatements {
  kind: "statements";
  body: TsNode[];
}

export type TsImportKind = "named" | "default" | "namespace" | "type";

export interface TsImport {
  kind: "import";
  importKind: TsImportKind;
  names: string[];
  defaultName?: string;
  namespaceName?: string;
  from: string;
}

export interface TsVarDecl {
  kind: "varDecl";
  declKind: "const" | "let";
  name: string;
  typeAnnotation?: string;
  initializer?: TsNode;
}

export interface TsAssign {
  kind: "assign";
  lhs: TsNode;
  rhs: TsNode;
}

export interface TsParam {
  name: string;
  typeAnnotation?: string;
  defaultValue?: TsNode;
}

export interface TsFunctionDecl {
  kind: "functionDecl";
  name: string;
  params: TsParam[];
  returnType?: string;
  body: TsNode;
  async: boolean;
  export: boolean;
}

export interface TsArrowFn {
  kind: "arrowFn";
  params: TsParam[];
  returnType?: string;
  body: TsNode;
  async: boolean;
}

export interface TsCall {
  kind: "call";
  callee: TsNode;
  arguments: TsNode[];
}

export interface TsAwait {
  kind: "await";
  expr: TsNode;
}

export interface TsReturn {
  kind: "return";
  expr?: TsNode;
}

export type TsObjectEntry =
  | { spread: false; key: string; value: TsNode }
  | { spread: true; expr: TsNode };

export interface TsObjectLiteral {
  kind: "objectLiteral";
  entries: TsObjectEntry[];
}

export interface TsArrayLiteral {
  kind: "arrayLiteral";
  items: TsNode[];
}

export interface TsTemplatePart {
  text: string;
  expr?: TsNode;
}

export interface TsTemplateLit {
  kind: "templateLit";
  parts: TsTemplatePart[];
}

export interface TsElseIf {
  condition: TsNode;
  body: TsNode;
}

export interface TsIf {
  kind: "if";
  condition: TsNode;
  body: TsNode;
  elseIfs: TsElseIf[];
  elseBody?: TsNode;
}

export interface TsFor {
  kind: "for";
  variant: "of" | "cStyle";
  // for-of
  varName?: string;
  iterable?: TsNode;
  // c-style
  init?: TsNode;
  condition?: TsNode;
  update?: TsNode;
  body: TsNode;
}

export interface TsWhile {
  kind: "while";
  condition: TsNode;
  body: TsNode;
}

export interface TsSwitchCase {
  test?: TsNode; // undefined = default
  body: TsNode;
}

export interface TsSwitch {
  kind: "switch";
  discriminant: TsNode;
  cases: TsSwitchCase[];
}

export interface TsTryCatch {
  kind: "tryCatch";
  tryBody: TsNode;
  catchParam?: string;
  catchBody: TsNode;
  finallyBody?: TsNode;
}

export interface TsBinOp {
  kind: "binOp";
  left: TsNode;
  op: string;
  right: TsNode;
  parenLeft?: boolean;
  parenRight?: boolean;
}

export interface TsPropertyAccess {
  kind: "propertyAccess";
  object: TsNode;
  property: string | TsNode;
  computed: boolean;
}

export interface TsSpread {
  kind: "spread";
  expr: TsNode;
}

export interface TsIdentifier {
  kind: "identifier";
  name: string;
}

export interface TsStringLiteral {
  kind: "stringLiteral";
  value: string;
}

export interface TsNumericLiteral {
  kind: "numericLiteral";
  value: number;
}

export interface TsBooleanLiteral {
  kind: "booleanLiteral";
  value: boolean;
}

export interface TsComment {
  kind: "comment";
  text: string;
  block: boolean;
}

export interface TsExport {
  kind: "export";
  decl?: TsNode;
  names?: string[];
}

export interface TsNewExpr {
  kind: "newExpr";
  callee: TsNode;
  arguments: TsNode[];
}

/** Scoped variable reference — lowered to TsPropertyAccess by lowerScopes */
export interface TsScopedVar {
  kind: "scopedVar";
  name: string;
  scope:
  | "global"
  | "shared"
  | "function"
  | "node"
  | "args"
  | "imported"
  | "local"
  | "block"
  | "blockArgs";
  moduleId?: string;
}

/** Return from a function scope — pops the state stack, then returns the value */
export interface TsFunctionReturn {
  kind: "functionReturn";
  value: TsNode;
}

// ── Runner-based step IR types ──
// These map 1:1 to Runner method calls. The builder assigns step IDs
// that match the source map paths. The Runner handles all bookkeeping
// (counters, substep variables, condbranch tracking, iteration tracking).

/** runner.step(id, async (runner) => { body }) */
export interface TsRunnerStep {
  kind: "runnerStep";
  id: number;
  body: TsNode[];
}

/** runner.thread(id, method, async (runner) => { body }) */
export interface TsRunnerThread {
  kind: "runnerThread";
  id: number;
  method: "create" | "createSubthread";
  body: TsNode[];
}

/** runner.handle(id, handlerFn, async (runner) => { body }) */
export interface TsRunnerHandle {
  kind: "runnerHandle";
  id: number;
  handler: TsNode;
  body: TsNode[];
}

/** runner.ifElse(id, branches, elseBranch?) */
export interface TsRunnerIfElse {
  kind: "runnerIfElse";
  id: number;
  branches: { condition: TsNode; body: TsNode[] }[];
  elseBranch?: TsNode[];
}

/** runner.loop(id, items, async (item, index, runner) => { body }) */
export interface TsRunnerLoop {
  kind: "runnerLoop";
  id: number;
  items: TsNode;
  itemVar: string;
  indexVar?: string;
  body: TsNode[];
}

/** runner.whileLoop(id, condition, async (runner) => { body }) */
export interface TsRunnerWhileLoop {
  kind: "runnerWhileLoop";
  id: number;
  condition: TsNode;
  body: TsNode[];
}

/** runner.branchStep(id, branchKey, async (runner) => { body }) */
export interface TsRunnerBranchStep {
  kind: "runnerBranchStep";
  id: number;
  branchKey: string;
  body: TsNode[];
}

export interface TsRunnerDebugger {
  kind: "runnerDebugger";
  id: number;
  label: string;
}

/** runner.pipe(id, input, async (__pipeArg) => fn(__pipeArg)) — one stage of a pipe chain */
export interface TsRunnerPipe {
  kind: "runnerPipe";
  id: number;
  target: TsNode;
  input: TsNode;
  fn: TsNode;
}



/** No-op node — produces no output. Used for AST nodes handled elsewhere (e.g. imports collected in a separate pass). */
export interface TsEmpty {
  kind: "empty";
}

export interface TsBreak {
  kind: "break";
}

export interface TsContinue {
  kind: "continue";
}

/** Postfix operator (e.g. i++) */
export interface TsPostfixOp {
  kind: "postfixOp";
  operand: TsNode;
  op: "++" | "--";
}

export interface TsAnd {
  kind: "and";
  operands: TsNode[];
}

export interface TsOr {
  kind: "or";
  operands: TsNode[];
}

export interface TsNot {
  kind: "not";
  operand: TsNode;
}

export interface TsTernary {
  kind: "ternary";
  condition: TsNode;
  trueExpr: TsNode;
  falseExpr: TsNode;
}
