import { $ } from "./fluent.js";
import type {
  TsNode,
  TsRaw,
  TsStatements,
  TsImport,
  TsImportKind,
  TsImportName,
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
  // TsFunctionReturn is no longer produced but kept in tsIR.ts for now
  TsRunnerStep,
  TsRunnerThread,
  TsRunnerHandle,
  TsRunnerHookStep,
  TsRunnerIfElse,
  TsRunnerLoop,
  TsRunnerWhileLoop,
  TsRunnerBranchStep,
  TsRunnerPipe,
  TsEmpty,
  TsBreak,
  TsContinue,
  TsPostfixOp,
  TsTernary,
  TsRunnerDebugger,
  TsWithHandler,
  TsAgencyFunctionWrap,
} from "./tsIR.js";

export { $, TsChain } from "./fluent.js";

export const ts = {
  raw(code: string): TsRaw {
    return { kind: "raw", code };
  },

  statements(body: TsNode[]): TsStatements {
    return { kind: "statements", body };
  },

  statementsPush(statement: TsStatements, ...stmts: TsNode[]): TsStatements {
    return { kind: "statements", body: [...statement.body, ...stmts] };
  },

  importDecl(opts: {
    importKind: TsImportKind;
    names?: TsImportName[];
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

  /**
   * `receiver.name(args)` or `receiver?.name(args)`.
   * Replaces the verbose `$(receiver).prop(name).call(args).done()` chain
   * for the common "method call on a receiver" shape.
   */
  methodCall(
    receiver: TsNode,
    name: string,
    args: TsNode[] = [],
    opts?: { optional?: boolean },
  ): TsCall {
    return ts.call(ts.prop(receiver, name, opts), args);
  },

  /** `await callee(args)` */
  awaitCall(callee: TsNode, args: TsNode[] = []): TsAwait {
    return ts.await(ts.call(callee, args));
  },

  /** `await receiver.name(args)` or `await receiver?.name(args)` */
  awaitMethodCall(
    receiver: TsNode,
    name: string,
    args: TsNode[] = [],
    opts?: { optional?: boolean },
  ): TsAwait {
    return ts.await(ts.methodCall(receiver, name, args, opts));
  },

  /**
   * Immediately-invoked (arrow) function expression: `(async () => { body })()`.
   * `body` can be a `TsStatements` body or any single `TsNode`.
   * The printer adds the wrapping parens around the arrow callee automatically.
   */
  iife(opts: {
    async?: boolean;
    params?: TsParam[];
    body: TsNode | TsNode[];
  }): TsCall {
    const body = Array.isArray(opts.body) ? ts.statements(opts.body) : opts.body;
    return ts.call(
      ts.arrowFn(opts.params ?? [], body, { async: opts.async }),
      [],
    );
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

  setComputed(key: TsNode, value: TsNode): TsObjectEntry {
    return { spread: false, computed: true, key, value };
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

  prop(object: TsNode, property: string, opts?: { optional?: boolean }): TsPropertyAccess {
    return { kind: "propertyAccess", object, property, computed: false, ...(opts?.optional && { optional: true }) };
  },

  index(object: TsNode, property: TsNode, opts?: { optional?: boolean }): TsPropertyAccess {
    return { kind: "propertyAccess", object, property, computed: true, ...(opts?.optional && { optional: true }) };
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

  validateType(value: TsNode, zodSchema: TsNode): TsCall {
    return ts.call(ts.id("__validateType"), [value, zodSchema]);
  },

  /**
   * `await __validateChainRecursive(value, <descriptor>)` — used at
   * `!` sites whose resolved type carries at least one `@validate(...)` tag
   * anywhere in the tree. The descriptor is a TS expression built via
   * `buildValidationDescriptor(...)`. Validators read `ctx` from the
   * active `agencyStore` ALS frame, so no explicit ctx arg is threaded.
   */
  validateChainRecursive(value: TsNode, descriptor: TsNode): TsAwait {
    return ts.awaitCall(ts.id("__validateChainRecursive"), [
      value,
      descriptor,
    ]);
  },

  scopedVar(
    name: string,
    scope: TsScopedVar["scope"],
    moduleId?: string,
  ): TsScopedVar {
    return { kind: "scopedVar", name, scope, moduleId };
  },

  functionReturn(value: TsNode): TsStatements {
    return ts.statements([
      ts.assign(ts.id("__functionCompleted"), ts.bool(true)),
      ts.runnerHalt(value),
    ]);
  },

  // ── Runner-based step builders ──

  runnerStep(opts: { id: number; body: TsNode[] }): TsRunnerStep {
    return { kind: "runnerStep", ...opts };
  },

  runnerThread(opts: {
    id: number;
    method: "create" | "createSubthread";
    body: TsNode[];
    label?: TsNode | null;
    summarize?: TsNode | null;
    continueExpr?: TsNode | null;
    sessionExpr?: TsNode | null;
    hidden?: TsNode | null;
  }): TsRunnerThread {
    const res = { kind: "runnerThread" as const, ...opts };
    return res;
  },

  runnerHandle(opts: { id: number; handler: TsNode; body: TsNode[] }): TsRunnerHandle {
    return { kind: "runnerHandle", ...opts };
  },

  /** Emit `await runner.hook(id, async () => { ...body... })` — a
   *  substep-counter-idempotent wrapper for codegen-emitted callback
   *  hook sites. See `Runner.hook`'s JSDoc. */
  runnerHookStep(opts: { id: number; body: TsNode[] }): TsRunnerHookStep {
    return { kind: "runnerHookStep", ...opts };
  },

  withHandler(handler: TsNode, body: TsNode): TsWithHandler {
    return { kind: "withHandler", handler, body };
  },

  runnerIfElse(opts: { id: number; branches: { condition: TsNode; body: TsNode[] }[]; elseBranch?: TsNode[] }): TsRunnerIfElse {
    return { kind: "runnerIfElse", ...opts };
  },

  runnerLoop(opts: { id: number; items: TsNode; itemVar: string; body: TsNode[]; indexVar?: string }): TsRunnerLoop {
    return { kind: "runnerLoop", ...opts };
  },

  runnerWhileLoop(opts: { id: number; condition: TsNode; body: TsNode[] }): TsRunnerWhileLoop {
    return { kind: "runnerWhileLoop", ...opts };
  },

  runnerBranchStep(opts: { id: number; branchKey: string; body: TsNode[] }): TsRunnerBranchStep {
    return { kind: "runnerBranchStep", ...opts };
  },

  runnerDebugger(opts: { id: number; label: string }): TsRunnerDebugger {
    return { kind: "runnerDebugger", ...opts };
  },

  runnerPipe(opts: { id: number; target: TsNode; input: TsNode; fn: TsNode }): TsRunnerPipe {
    return { kind: "runnerPipe", ...opts };
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

  /** Call runner.halt(value) and return from the current callback */
  runnerHalt(value: TsNode): TsStatements {
    return ts.statements([
      ts.methodCall(ts.id("runner"), "halt", [value]),
      ts.return(),
    ]);
  },

  /** Halt with { messages: __threads(), data: value } and return from a graph node callback */
  nodeResult(value: TsNode): TsStatements {
    return ts.runnerHalt(ts.obj({ messages: ts.runtime.threads, data: value }));
  },

  /**
   * Wrap a list of statements in
   * `await agencyStore.run({ ctx, stack, threads }, async () => { ... })`.
   *
   * Defense-in-depth: every function/node body's try block carries an
   * ALS frame so stdlib helpers and `__threads()` / `__stateStack()`
   * reads resolve correctly even for code that runs between Runner
   * steps. Today the gap is empty (every callback emission uses
   * `runner.step`/`runner.hook`/etc. which re-seed the frame
   * themselves), but the wrap makes the contract explicit and
   * removes the risk that a future refactor silently loses the
   * per-scope frame.
   *
   * NOTE: `return` statements inside the wrapped body escape only the
   * inner async callback, not the outer function. Validation guards
   * that return a non-`undefined` value (e.g. `return __vr_x` for a
   * validation failure) must stay outside the wrap so the outer
   * function actually returns the value to its caller. The bare
   * `return;` emitted by `runnerHalt` is fine: after the callback
   * returns, the outer `if (runner.halted) return runner.haltResult;`
   * check picks up the halted result.
   */
  withAlsFrame({
    ctx,
    stack,
    threads,
    body,
  }: {
    ctx: TsNode;
    stack: TsNode;
    threads: TsNode;
    body: TsNode[];
  }): TsNode {
    // Spread the outer ALS frame first so non-overridden slots —
    // notably `moduleDir`, which is seeded once by generated code in
    // `runNode` / `runInBootstrapFrame` — are inherited here. Without
    // the spread, stdlib helpers invoked from inside this body frame
    // would see `moduleDir = undefined` and fall back to
    // `process.cwd()`, breaking the "resolve relative paths against
    // the compiled module dir" contract for `read` / `dirname()` /
    // `_readSkill` / etc.
    return ts.awaitCall(
      ts.prop(ts.id("agencyStore"), "run"),
      [
        ts.obj([
          ts.setSpread(ts.call(ts.id("getRuntimeContext"))),
          ts.set("ctx", ctx),
          ts.set("stack", stack),
          ts.set("threads", threads),
        ]),
        ts.arrowFn([], ts.statements(body), { async: true }),
      ],
    );
  },

  env(varName: string): TsRaw {
    return ts.raw(`__process.env[${JSON.stringify(varName)}]`);
  },

  /**
   * Emit `await callHook({ name, data })`.
   *
   * `callHook` reads `ctx` from the active `agencyStore` frame, so the
   * codegen no longer needs to thread `__ctx` through every emission
   * site. Callback bodies cannot raise interrupts (statically forbidden
   * by the typechecker — see `checkCallbackBodyInterrupts`). `callHook`
   * returns `void`; the codegen-emitted hook sites fire-and-forget.
   */
  callHook(hookName: string, data: Record<string, TsNode> | TsNode): TsNode {
    const dataNode = "kind" in data ? data as TsNode : ts.obj(data as Record<string, TsNode>);
    return ts.awaitCall(ts.id("callHook"), [
      ts.obj({
        name: ts.str(hookName),
        data: dataNode,
      }),
    ]);
  },

  setupEnv({
    stack,
    step,
    self,
    ctx,
  }: {
    stack: TsNode;
    step: TsNode;
    self: TsNode;
    ctx: TsNode;
  }): TsStatements {
    // No `__threads` or `__stateStack` const declaration here: those
    // per-scope values are now read on demand via the `__threads()`
    // and `__stateStack()` accessors (which resolve through the active
    // `agencyStore` ALS frame). The `__graph` and `statelogClient`
    // locals that used to be declared here were dead code — no
    // template or codegen path referenced them — so they were dropped
    // entirely. See `ts.runtime.threads` / `ts.runtime.stateStack` and
    // `lib/runtime/asyncContext.ts`.
    return ts.statements([
      ts.constDeclId(ts.runtime.stack, stack),
      ts.constDeclId(ts.runtime.step, step),
      ts.constDeclId(ts.runtime.self, self),
      // `ts.runtime.ctx` is now the `__ctx()` accessor; the const-decl
      // target must be the literal identifier `__ctx`. The local stays
      // because pre-wrap code (Runner ctor, withAlsFrame seed,
      // __initializeGlobals call) needs a lexical handle to seed ALS.
      ts.constDeclId(ts.id("__ctx"), ctx),
      ts.letDecl("__forked"),

      // Track whether the function completed normally (vs pausing for a debug interrupt).
      // Used in the finally block to decide whether to fire onFunctionEnd.
      ts.letDecl("__functionCompleted", ts.bool(false)),
    ]);
  },

  time(varName: string): TsNode {
    return ts.letDecl(
      varName,
      ts.methodCall(ts.id("performance"), "now"),
      "number",
    );
  },

  stack(varName: string): TsNode {
    return ts.prop(ts.runtime.stack, varName);
  },

  ctx(varName: string): TsNode {
    return ts.prop(ts.runtime.ctx, varName);
  },

  self(varName: string): TsNode {
    return ts.prop(ts.runtime.self, varName);
  },

  throw(code: string): TsNode {
    return ts.raw(`throw ${code}`);
  },

  and(...conditions: TsNode[]): TsNode {
    return { kind: "and", operands: conditions };
  },

  or(...conditions: TsNode[]): TsNode {
    return { kind: "or", operands: conditions };
  },

  not(condition: TsNode): TsNode {
    return { kind: "not", operand: condition };
  },

  unaryOp(op: string, operand: TsNode, opts?: { paren?: boolean }): TsNode {
    return { kind: "unaryOp", op, operand, paren: opts?.paren };
  },

  functionCallConfig({
    ctx,
    threads,
    stateStack,
    moduleId,
    scopeName,
    stepPath,
  }: {
    ctx: TsNode;
    threads?: TsNode;
    stateStack?: TsNode;
    moduleId?: TsNode;
    scopeName?: TsNode;
    stepPath?: TsNode;
  }): TsNode {
    const entries: Record<string, TsNode> = {
      ctx,
    };
    if (threads) {
      entries.threads = threads;
    }
    if (stateStack) {
      entries.stateStack = stateStack;
    }
    if (moduleId) {
      entries.moduleId = moduleId;
    }
    if (scopeName) {
      entries.scopeName = scopeName;
    }
    if (stepPath) {
      entries.stepPath = stepPath;
    }
    return ts.obj(entries);
  },

  newThreadStore(): TsNode {
    return ts.new(ts.id("ThreadStore"));
  },

  smoltalkSystemMessage(args: TsNode[]): TsNode {
    return ts.methodCall(ts.id("smoltalk"), "systemMessage", args);
  },

  smoltalkUserMessage(args: TsNode[]): TsNode {
    return ts.methodCall(ts.id("smoltalk"), "userMessage", args);
  },
  smoltalkAssistantMessage(args: TsNode[]): TsNode {
    return ts.methodCall(ts.id("smoltalk"), "assistantMessage", args);
  },

  goToNode(nodeName: string, args: TsNode): TsNode {
    return ts.call(ts.id("goToNode"), [ts.str(nodeName), args]);
  },

  nodeReturn({ messages, data }: { messages: TsNode; data: TsNode }): TsStatements {
    return ts.statements([
      ts.methodCall(ts.id("runner"), "halt", [ts.obj({ messages, data })]),
      ts.raw("return"),
    ]);
  },

  jsonStringify(value: TsNode): TsNode {
    return ts.methodCall(ts.id("JSON"), "stringify", [value]);
  },

  consoleLog(...args: TsNode[]): TsNode {
    return ts.methodCall(ts.id("console"), "log", args);
  },

  consoleWarn(...args: TsNode[]): TsNode {
    return ts.methodCall(ts.id("console"), "warn", args);
  },

  consoleError(...args: TsNode[]): TsNode {
    return ts.methodCall(ts.id("console"), "error", args);
  },

  /* 
          ? ts.obj([ts.spread(ts.runtime.state), ts.set("data", ts.id(tempVar))])
        : ts.obj({ data: ts.id(tempVar) }); */

  /* 

  functionReturn(value: TsNode): TsReturn {
    return ts.return(ts.obj({ data: value }));
  }, */

  /** GlobalStore operations.
   *
   *  Receiver defaults to `ts.runtime.globals` (the `__globals()!`
   *  accessor — see its docstring). Pass `globalsRef` explicitly when
   *  the emission site has a different lexical handle on the store —
   *  most notably inside `__initializeGlobals(__ctx)` in
   *  sectionAssembler.ts, where the function's `__ctx` parameter
   *  exposes the canonical store directly; pass
   *  `ts.prop(ts.id("__ctx"), "globals")` there. Routing through the
   *  accessor by default ensures every user-visible read/write
   *  participates in per-branch isolation without further codegen
   *  changes. */
  globalGet(
    moduleId: string,
    varName: string,
    globalsRef?: TsNode,
  ): TsCall {
    // Inline the default — referencing `ts.runtime.globals` here
    // creates a self-typing cycle that makes TS infer `ts: any`. The
    // `__globals()!` raw is the canonical "current per-scope
    // GlobalStore" expression (see `ts.runtime.globals`).
    const receiver = globalsRef ?? ({ kind: "raw", code: "__globals()!" } as TsRaw);
    return ts.methodCall(
      receiver,
      "get",
      [ts.str(moduleId), ts.str(varName)],
    );
  },

  globalSet(
    moduleId: string,
    varName: string,
    value: TsNode,
    globalsRef?: TsNode,
  ): TsCall {
    const receiver = globalsRef ?? ({ kind: "raw", code: "__globals()!" } as TsRaw);
    return ts.methodCall(
      receiver,
      "set",
      [ts.str(moduleId), ts.str(varName), value],
    );
  },

  ternary(condition: TsNode, trueExpr: TsNode, falseExpr: TsNode): TsTernary {
    return { kind: "ternary", condition, trueExpr, falseExpr };
  },

  agencyFunctionWrap(fn: TsNode, name: string, module: string, params: { name: string }[]): TsAgencyFunctionWrap {
    return { kind: "agencyFunctionWrap", name, module, fn, params };
  },

  /** Predefined runtime identifiers. `threads` and `stateStack` are
   *  `__threads()` / `__stateStack()` accessor calls (not bare
   *  identifiers) because post-ALS migration the per-scope
   *  `ThreadStore` and `StateStack` live on the active `agencyStore`
   *  frame instead of in codegen-emitted `const __threads` / `const
   *  __stateStack` locals. Every site that referenced the old locals
   *  now emits the accessor call, which reads from ALS and returns
   *  the live store (or `undefined` outside any frame — see
   *  `runtime/asyncContext.ts`).
   *
   *  `ctx` is `getRuntimeContext().ctx` rather than a bare `__ctx()`
   *  accessor call: the per-scope `const __ctx = __state?.ctx ||
   *  __globalCtx;` local emitted by `setupEnv` would shadow a bare
   *  `__ctx` accessor identifier — and the esbuild TS transform
   *  rewrites *every* `__ctx` reference in a scope (import-bound
   *  ones included) to match the renamed local, so `__ctx()` would
   *  become `__ctx2()` and crash with `__ctx2 is not a function`.
   *  Routing through `getRuntimeContext().ctx` avoids the shadow
   *  entirely. Pre-wrap, parameter-context, and seed sites still use
   *  `ts.id("__ctx")` directly to reach the setupEnv local. */
  runtime: {
    self: { kind: "identifier", name: "__self" } as TsIdentifier,
    ctx: { kind: "raw", code: "getRuntimeContext().ctx" } as TsRaw,
    threads: { kind: "raw", code: "__threads()" } as TsRaw,
    stateStack: { kind: "raw", code: "__stateStack()" } as TsRaw,
    /** Per-scope GlobalStore accessor. Reads from the active ALS
     *  frame's `globals` slot — pointer-shared with the canonical
     *  store at every frame builder (Stage 1) and the branch-local
     *  clone inside `runInBranchAlsFrame` (Stage 2). Replaces the
     *  pre-ALS `__ctx.globals.…` codegen pattern: every user-visible
     *  global read/write is now routed through this accessor so the
     *  branch-local view participates without further codegen
     *  changes. The non-null assertion (`!`) is appropriate because
     *  every emission site runs inside an Agency execution frame
     *  (function/node body wrapped in `withAlsFrame`, Runner step
     *  body, or bootstrap frame). */
    globals: { kind: "raw", code: "__globals()!" } as TsRaw,
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
    createAndReturnThread(): TsCall {
      return ts.call(ts.prop(ts.runtime.threads, "createAndReturnThread"));
    },
    createSubthread(): TsCall {
      return ts.call(ts.prop(ts.runtime.threads, "createSubthread"));
    },
    createAndReturnSubthread(): TsCall {
      return ts.call(ts.prop(ts.runtime.threads, "createAndReturnSubthread"));
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
