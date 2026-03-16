import type {
  TsNode,
  TsRaw,
  TsStatements,
  TsImport,
  TsImportKind,
  TsVarDecl,
  TsAssign,
  TsFunctionDecl,
  TsParam,
  TsArrowFn,
  TsCall,
  TsAwait,
  TsReturn,
  TsObjectLiteral,
  TsObjectEntry,
  TsArrayLiteral,
  TsTemplateLit,
  TsTemplatePart,
  TsIf,
  TsElseIf,
  TsFor,
  TsWhile,
  TsSwitch,
  TsSwitchCase,
  TsTryCatch,
  TsBinOp,
  TsPropertyAccess,
  TsSpread,
  TsIdentifier,
  TsStringLiteral,
  TsNumericLiteral,
  TsBooleanLiteral,
  TsComment,
  TsExport,
  TsNewExpr,
  TsScopedVar,
  TsFunctionReturn,
  TsStepBlock,
  TsEmpty,
  TsBreak,
  TsContinue,
  TsPostfixOp,
} from "./tsIR.js";

export { $, TsChain } from "./fluent.js";

export const ts = {
  raw(code: string): TsRaw {
    return { kind: "raw", code };
  },

  statements(body: TsNode[]): TsStatements {
    return { kind: "statements", body };
  },

  importDecl(opts: {
    importKind: TsImportKind;
    names?: string[];
    defaultName?: string;
    namespaceName?: string;
    from: string;
  }): TsImport {
    return {
      kind: "import",
      importKind: opts.importKind,
      names: opts.names ?? [],
      defaultName: opts.defaultName,
      namespaceName: opts.namespaceName,
      from: opts.from,
    };
  },

  varDecl(
    declKind: "const" | "let",
    name: string,
    initializer?: TsNode,
    typeAnnotation?: string,
  ): TsVarDecl {
    return { kind: "varDecl", declKind, name, typeAnnotation, initializer };
  },

  letDecl(
    name: string,
    initializer?: TsNode,
    typeAnnotation?: string,
  ): TsVarDecl {
    return { kind: "varDecl", declKind: "let", name, typeAnnotation, initializer };
  },

  constDecl(
    name: string,
    initializer?: TsNode,
    typeAnnotation?: string,
  ): TsVarDecl {
    return { kind: "varDecl", declKind: "const", name, typeAnnotation, initializer };
  },

  assign(lhs: TsNode, rhs: TsNode): TsAssign {
    return { kind: "assign", lhs, rhs };
  },

  functionDecl(
    name: string,
    params: TsParam[],
    body: TsNode,
    opts?: { async?: boolean; export?: boolean; returnType?: string },
  ): TsFunctionDecl {
    return {
      kind: "functionDecl",
      name,
      params,
      body,
      async: opts?.async ?? false,
      export: opts?.export ?? false,
      returnType: opts?.returnType,
    };
  },

  arrowFn(
    params: TsParam[],
    body: TsNode,
    opts?: { async?: boolean; returnType?: string },
  ): TsArrowFn {
    return {
      kind: "arrowFn",
      params,
      body,
      async: opts?.async ?? false,
      returnType: opts?.returnType,
    };
  },

  call(callee: TsNode, args: TsNode[] = []): TsCall {
    return { kind: "call", callee, arguments: args };
  },

  await(expr: TsNode): TsAwait {
    return { kind: "await", expr };
  },

  return(expr?: TsNode): TsReturn {
    return { kind: "return", expr };
  },

  obj(entries: TsObjectEntry[] | Record<string, TsNode>): TsObjectLiteral {
    if (Array.isArray(entries)) {
      return { kind: "objectLiteral", entries };
    }
    return {
      kind: "objectLiteral",
      entries: Object.entries(entries).map(([key, value]) => ({
        spread: false,
        key,
        value,
      })),
    };
  },

  arr(items: TsNode[]): TsArrayLiteral {
    return { kind: "arrayLiteral", items };
  },

  template(parts: TsTemplatePart[]): TsTemplateLit {
    return { kind: "templateLit", parts };
  },

  if(
    condition: TsNode,
    body: TsNode,
    opts?: { elseIfs?: TsElseIf[]; elseBody?: TsNode },
  ): TsIf {
    return {
      kind: "if",
      condition,
      body,
      elseIfs: opts?.elseIfs ?? [],
      elseBody: opts?.elseBody,
    };
  },

  forOf(varName: string, iterable: TsNode, body: TsNode): TsFor {
    return { kind: "for", variant: "of", varName, iterable, body };
  },

  forC(init: TsNode, condition: TsNode, update: TsNode, body: TsNode): TsFor {
    return { kind: "for", variant: "cStyle", init, condition, update, body };
  },

  while(condition: TsNode, body: TsNode): TsWhile {
    return { kind: "while", condition, body };
  },

  switch(discriminant: TsNode, cases: TsSwitchCase[]): TsSwitch {
    return { kind: "switch", discriminant, cases };
  },

  tryCatch(
    tryBody: TsNode,
    catchBody: TsNode,
    catchParam?: string,
  ): TsTryCatch {
    return { kind: "tryCatch", tryBody, catchParam, catchBody };
  },

  binOp(
    left: TsNode,
    op: string,
    right: TsNode,
    opts?: { parenLeft?: boolean; parenRight?: boolean },
  ): TsBinOp {
    return {
      kind: "binOp",
      left,
      op,
      right,
      parenLeft: opts?.parenLeft,
      parenRight: opts?.parenRight,
    };
  },

  prop(object: TsNode, property: string): TsPropertyAccess {
    return { kind: "propertyAccess", object, property, computed: false };
  },

  index(object: TsNode, property: TsNode): TsPropertyAccess {
    return { kind: "propertyAccess", object, property, computed: true };
  },

  spread(expr: TsNode): TsSpread {
    return { kind: "spread", expr };
  },

  id(name: string): TsIdentifier {
    return { kind: "identifier", name };
  },

  str(value: string): TsStringLiteral {
    return { kind: "stringLiteral", value };
  },

  num(value: number): TsNumericLiteral {
    return { kind: "numericLiteral", value };
  },

  bool(value: boolean): TsBooleanLiteral {
    return { kind: "booleanLiteral", value };
  },

  comment(text: string, block = false): TsComment {
    return { kind: "comment", text, block };
  },

  export(decl?: TsNode, names?: string[]): TsExport {
    return { kind: "export", decl, names };
  },

  new(callee: TsNode, args: TsNode[] = []): TsNewExpr {
    return { kind: "newExpr", callee, arguments: args };
  },

  scopedVar(name: string, scope: TsScopedVar["scope"]): TsScopedVar {
    return { kind: "scopedVar", name, scope };
  },

  functionReturn(value: TsNode): TsFunctionReturn {
    return { kind: "functionReturn", value };
  },

  stepBlock(stepIndex: number, body: TsNode): TsStepBlock {
    return { kind: "stepBlock", stepIndex, body };
  },

  empty(): TsEmpty {
    return { kind: "empty" };
  },

  break(): TsBreak {
    return { kind: "break" };
  },

  continue(): TsContinue {
    return { kind: "continue" };
  },

  postfix(operand: TsNode, op: "++" | "--"): TsPostfixOp {
    return { kind: "postfixOp", operand, op };
  },

  // --- Semantic convenience builders (no new IR types) ---

  /** Return { messages: __threads, data: value } from a graph node */
  nodeResult(value: TsNode): TsReturn {
    return ts.return(ts.obj({ messages: ts.runtime.threads, data: value }));
  },

  /** Predefined runtime identifiers */
  runtime: {
    self: { kind: "identifier", name: "__self" } as TsIdentifier,
    ctx: { kind: "identifier", name: "__ctx" } as TsIdentifier,
    threads: { kind: "identifier", name: "__threads" } as TsIdentifier,
    stack: { kind: "identifier", name: "__stack" } as TsIdentifier,
    step: { kind: "identifier", name: "__step" } as TsIdentifier,
    state: { kind: "identifier", name: "__state" } as TsIdentifier,
    globalCtx: { kind: "identifier", name: "__globalCtx" } as TsIdentifier,
    client: { kind: "identifier", name: "__client" } as TsIdentifier,
  },

  /** Thread operations */
  threads: {
    create(): TsCall {
      return ts.call(ts.prop(ts.runtime.threads, "create"));
    },
    get(id: TsNode): TsCall {
      return ts.call(ts.prop(ts.runtime.threads, "get"), [id]);
    },
    active(): TsCall {
      return ts.call(ts.prop(ts.runtime.threads, "active"));
    },
    getOrCreateActive(): TsCall {
      return ts.call(ts.prop(ts.runtime.threads, "getOrCreateActive"));
    },
  },
};
