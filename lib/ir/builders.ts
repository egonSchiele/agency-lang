import { $ } from "./fluent.js";
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
    return {
      kind: "varDecl",
      declKind: "let",
      name,
      typeAnnotation,
      initializer,
    };
  },

  constDecl(
    name: string,
    initializer?: TsNode,
    typeAnnotation?: string,
  ): TsVarDecl {
    return {
      kind: "varDecl",
      declKind: "const",
      name,
      typeAnnotation,
      initializer,
    };
  },

  constDeclId(
    name: TsIdentifier,
    initializer?: TsNode,
    typeAnnotation?: string,
  ): TsVarDecl {
    return {
      kind: "varDecl",
      declKind: "const",
      name: name.name,
      typeAnnotation,
      initializer,
    };
  },

  /** `const { key: binding, ... } = initializer` — use shorthand when key === binding */
  constDestructure(
    bindings: Record<string, string>,
    initializer?: TsNode,
    typeAnnotation?: string,
  ): TsVarDecl {
    const parts = Object.entries(bindings).map(([key, binding]) =>
      key === binding ? key : `${key}: ${binding}`,
    );
    return {
      kind: "varDecl",
      declKind: "const",
      name: `{ ${parts.join(", ")} }`,
      typeAnnotation,
      initializer,
    };
  },

  /** `let { key: binding, ... } = initializer` — use shorthand when key === binding */
  letDestructure(
    bindings: Record<string, string>,
    initializer?: TsNode,
    typeAnnotation?: string,
  ): TsVarDecl {
    const parts = Object.entries(bindings).map(([key, binding]) =>
      key === binding ? key : `${key}: ${binding}`,
    );
    return {
      kind: "varDecl",
      declKind: "let",
      name: `{ ${parts.join(", ")} }`,
      typeAnnotation,
      initializer,
    };
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

  namedArgs(callee: TsNode, args: Record<string, TsNode>): TsCall {
    return ts.call(callee, [ts.obj(args)]);
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

  setSpread(expr: TsNode): TsObjectEntry {
    return { spread: true, expr };
  },

  set(key: string, value: TsNode): TsObjectEntry {
    return { spread: false, key, value };
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
    finallyBody?: TsNode,
  ): TsTryCatch {
    return { kind: "tryCatch", tryBody, catchParam, catchBody, finallyBody };
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

  scopedVar(
    name: string,
    scope: TsScopedVar["scope"],
    moduleId?: string,
  ): TsScopedVar {
    return { kind: "scopedVar", name, scope, moduleId };
  },

  functionReturn(value: TsNode): TsFunctionReturn {
    return { kind: "functionReturn", value };
  },

  stepBlock(stepIndex: number, body: TsNode, branchCheck?: boolean): TsStepBlock {
    return { kind: "stepBlock", stepIndex, body, ...(branchCheck ? { branchCheck } : {}) };
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

  env(varName: string): TsRaw {
    return ts.raw(`process.env[${JSON.stringify(varName)}]`);
  },

  callHook(hookName: string, data: Record<string, TsNode>): TsNode {
    return $(ts.id("callHook"))
      .call([
        ts.obj({
          callbacks: $(ts.runtime.ctx).prop("callbacks").done(),
          name: ts.str(hookName),
          data: ts.obj(data),
        }),
      ])
      .await()
      .done();
  },

  setupEnv({
    stack,
    step,
    self,
    threads,
    ctx,
    statelogClient,
    graph,
  }: {
    stack: TsNode;
    step: TsNode;
    self: TsNode;
    threads: TsNode;
    ctx: TsNode;
    statelogClient: TsNode;
    graph: TsNode;
  }): TsStatements {
    return ts.statements([
      ts.constDeclId(ts.runtime.stack, stack),
      ts.constDeclId(ts.runtime.step, step),
      ts.constDeclId(ts.runtime.self, self),
      ts.constDeclId(ts.runtime.threads, threads),
      ts.constDeclId(ts.runtime.ctx, ctx),
      ts.constDeclId(ts.runtime.statelogClient, statelogClient),
      ts.constDeclId(ts.runtime.graph, graph),
    ]);
  },

  time(varName: string): TsNode {
    return ts.letDecl(
      varName,
      $(ts.id("performance")).prop("now").call().done(),
      "number",
    );
  },

  stack(varName: string): TsNode {
    return $(ts.runtime.stack).prop(varName).done();
  },

  ctx(varName: string): TsNode {
    return $(ts.runtime.ctx).prop(varName).done();
  },

  self(varName: string): TsNode {
    return $(ts.runtime.self).prop(varName).done();
  },

  throw(code: string): TsNode {
    return ts.raw(`throw ${code}`);
  },

  functionCallConfig({
    ctx,
    threads,
    interruptData,
    stateStack,
  }: {
    ctx: TsNode;
    threads: TsNode;
    interruptData: TsNode;
    stateStack?: TsNode;
  }): TsNode {
    const entries: Record<string, TsNode> = {
      ctx,
      threads,
      interruptData,
    };
    if (stateStack) {
      entries.stateStack = stateStack;
    }
    return ts.obj(entries);
  },

  newThreadStore(): TsNode {
    return ts.new(ts.id("ThreadStore"));
  },

  smoltalkSystemMessage(args: TsNode[]): TsNode {
    return $.id("smoltalk").prop("systemMessage").call(args).done();
  },

  smoltalkUserMessage(args: TsNode[]): TsNode {
    return $.id("smoltalk").prop("userMessage").call(args).done();
  },
  smoltalkAssistantMessage(args: TsNode[]): TsNode {
    return $.id("smoltalk").prop("assistantMessage").call(args).done();
  },

  goToNode(nodeName: string, args: TsNode): TsNode {
    return $.id("goToNode")
      .call([ts.str(nodeName), args])
      .done();
  },

  nodeReturn({ messages, data }: { messages: TsNode; data: TsNode }): TsReturn {
    return ts.return(ts.obj({ messages, data }));
  },

  jsonStringify(value: TsNode): TsNode {
    return $.id("JSON").prop("stringify").call([value]).done();
  },

  consoleLog(...args: TsNode[]): TsNode {
    return $.id("console").prop("log").call(args).done();
  },

  consoleWarn(...args: TsNode[]): TsNode {
    return $.id("console").prop("warn").call(args).done();
  },

  consoleError(...args: TsNode[]): TsNode {
    return $.id("console").prop("error").call(args).done();
  },

  /* 
          ? ts.obj([ts.spread(ts.runtime.state), ts.set("data", ts.id(tempVar))])
        : ts.obj({ data: ts.id(tempVar) }); */

  /* 

  functionReturn(value: TsNode): TsReturn {
    return ts.return(ts.obj({ data: value }));
  }, */

  /** GlobalStore operations */
  globalGet(moduleId: string, varName: string): TsCall {
    return ts.call($(ts.runtime.ctx).prop("globals").prop("get").done(), [
      ts.str(moduleId),
      ts.str(varName),
    ]);
  },

  globalSet(moduleId: string, varName: string, value: TsNode): TsCall {
    return ts.call($(ts.runtime.ctx).prop("globals").prop("set").done(), [
      ts.str(moduleId),
      ts.str(varName),
      value,
    ]);
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
    statelogClient: {
      kind: "identifier",
      name: "statelogClient",
    } as TsIdentifier,
    graph: { kind: "identifier", name: "__graph" } as TsIdentifier,
  },

  /** Thread operations */
  threads: {
    create(): TsCall {
      return ts.call(ts.prop(ts.runtime.threads, "create"));
    },
    createAndReturnThread(): TsCall {
      return ts.call(ts.prop(ts.runtime.threads, "createAndReturnThread"));
    },
    createSubthread(): TsCall {
      return ts.call(ts.prop(ts.runtime.threads, "createSubthread"));
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
