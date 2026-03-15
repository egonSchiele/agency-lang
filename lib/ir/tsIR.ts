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
  | TsEmpty
  | TsBreak
  | TsContinue
  | TsPostfixOp;

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
  scope: "global" | "function" | "node" | "args" | "imported";
}

/** Return from a function scope — pops the state stack, then returns the value */
export interface TsFunctionReturn {
  kind: "functionReturn";
  value: TsNode;
}

/** A resumable step block — wraps body in `if (__step <= N) { ... __stack.step++; }` */
export interface TsStepBlock {
  kind: "stepBlock";
  stepIndex: number;
  body: TsNode;
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
