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
  | TsStepBlock
  | TsIfSteps
  | TsThreadSteps
  | TsWhileSteps
  | TsEmpty
  | TsBreak
  | TsContinue
  | TsPostfixOp
  | TsAnd
  | TsOr
  | TsNot
  | TsTernary;

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
    | "local";
  moduleId?: string;
}

/** Return from a function scope — pops the state stack, then returns the value */
export interface TsFunctionReturn {
  kind: "functionReturn";
  value: TsNode;
}

/** A resumable step block — wraps body in `if (__step <= N) { ... __stack.step++; }`.
 * When subStep is set, uses substep variable names instead (e.g. __sub_3, __substep_3).
 * When branchKey is set, the guard also checks for branch data at that key. */
export interface TsStepBlock {
  kind: "stepBlock";
  stepIndex: number;
  body: TsNode;
  branchKey?: string;
  subStep?: number[];
}

/** A thread block with substep guards for each body statement.
 * Thread setup (create+pushActive) is substep 0, body statements
 * follow, and cleanup (cloneMessages+popActive) runs after all
 * substeps complete. */
export interface TsThreadSteps {
  kind: "threadSteps";
  /** The substep path for naming variables */
  subStepPath: number[];
  /** The thread creation method — "create" or "createSubthread" */
  createMethod: string;
  /** The setup statements (create + pushActive) */
  setup: TsNode[];
  /** The body statements (each gets a substep guard) */
  body: TsNode[];
  /** The cleanup statements (cloneMessages + popActive) */
  cleanup: TsNode[];
}

/** A while loop with iteration tracking and substep guards for each body statement.
 * Tracks which iteration to resume on and which substep within that iteration. */
export interface TsWhileSteps {
  kind: "whileSteps";
  /** The substep path for naming variables */
  subStepPath: number[];
  /** The loop condition */
  condition: TsNode;
  /** The body statements (each gets a substep guard) */
  body: TsNode[];
  /** Local variable keys to reset at end of each iteration (nested condbranch/substep/iteration values) */
  resetKeys: string[];
}

/** A branch in a TsIfSteps node */
export interface TsIfStepsBranch {
  condition: TsNode;
  body: TsNode[];
}

/** An if/else block with substep guards for each branch body.
 * Handles condbranch tracking (which branch was taken) and substep
 * guards within each branch. Used inside step-counted bodies to
 * enable precise mid-block interrupt resumption. */
export interface TsIfSteps {
  kind: "ifSteps";
  /** The substep path for naming variables (e.g. [3] or [2, 1]) */
  subStepPath: number[];
  /** The branches — first is the "if", rest are "else if" */
  branches: TsIfStepsBranch[];
  /** Optional else body */
  elseBranch?: TsNode[];
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
